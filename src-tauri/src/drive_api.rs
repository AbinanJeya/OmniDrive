use crate::{
  app_session,
  account_registry::{find_account, list_accounts, upsert_account, AccountRegistryEntry},
  photos_api,
  token_store::{load_tokens_for_account, save_tokens_for_account, StoredTokenRecord},
};
use reqwest::{
  blocking::Client,
  header::{AUTHORIZATION, CONTENT_TYPE},
};
use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const GOOGLE_DRIVE_ABOUT_URL: &str = "https://www.googleapis.com/drive/v3/about";
const GOOGLE_DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_FOLDER_MIME_TYPE: &str = "application/vnd.google-apps.folder";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatePayload {
  pub account_id: String,
  pub label: String,
  pub display_name: String,
  pub email: Option<String>,
  pub source_kind: String,
  pub is_connected: bool,
  pub total_bytes: u64,
  pub used_bytes: u64,
  pub free_bytes: u64,
  pub last_synced_at: Option<String>,
  pub load_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDriveFileRecordPayload {
  pub id: String,
  pub name: String,
  pub mime_type: String,
  pub size: Option<String>,
  pub parents: Option<Vec<String>>,
  pub trashed: Option<bool>,
  pub modified_time: Option<String>,
  pub created_time: Option<String>,
  pub viewed_by_me_time: Option<String>,
  pub starred: Option<bool>,
  pub shared: Option<bool>,
  pub md5_checksum: Option<String>,
  pub thumbnail_link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveSnapshotPayload {
  pub account: AccountStatePayload,
  pub files: Vec<GoogleDriveFileRecordPayload>,
}

#[derive(Debug, Clone)]
pub struct LiveAccountContext {
  pub account: AccountStatePayload,
  pub access_token: String,
  pub files: Vec<GoogleDriveFileRecordPayload>,
}

#[derive(Debug, Clone)]
pub struct DriveUserProfile {
  pub account_id: String,
  pub display_name: String,
  pub email: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum DriveApiError {
  #[error("failed to build Google API client: {0}")]
  HttpClient(String),
  #[error("failed to refresh access token for {0}: {1}")]
  TokenRefresh(String, String),
  #[error("stored token for {0} is missing the Google client id required for refresh")]
  MissingClientId(String),
  #[error("failed to fetch Google Drive profile: {0}")]
  Profile(String),
  #[error("failed to fetch Google Drive account info for {0}: {1}")]
  About(String, String),
  #[error("failed to fetch Google Drive file list for {0}: {1}")]
  Files(String, String),
  #[error("failed to read stored tokens for {0}: {1}")]
  TokenLoad(String, String),
  #[error("failed to persist refreshed tokens for {0}: {1}")]
  TokenSave(String, String),
  #[error("failed to update local account registry for {0}: {1}")]
  Registry(String, String),
}

#[derive(Debug, Deserialize)]
pub(crate) struct GoogleAboutResponse {
  pub(crate) user: Option<GoogleDriveUser>,
  #[serde(rename = "storageQuota")]
  pub(crate) storage_quota: Option<GoogleStorageQuota>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GoogleDriveUser {
  #[serde(rename = "displayName")]
  pub display_name: Option<String>,
  #[serde(rename = "emailAddress")]
  pub email_address: Option<String>,
  #[serde(rename = "permissionId")]
  pub permission_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GoogleStorageQuota {
  pub(crate) limit: Option<String>,
  pub(crate) usage: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleFilesListResponse {
  files: Option<Vec<GoogleDriveFileRecordPayload>>,
  #[serde(rename = "nextPageToken")]
  next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleRefreshTokenResponse {
  access_token: String,
  expires_in: Option<i64>,
  scope: Option<String>,
  token_type: Option<String>,
}

pub fn load_drive_snapshots(app: tauri::AppHandle) -> Result<Vec<DriveSnapshotPayload>, DriveApiError> {
  app_session::ensure_authenticated(&app)
    .map_err(|err| DriveApiError::Registry("session".into(), err))?;
  let accounts = list_accounts(&app).map_err(|err| DriveApiError::Registry("registry".into(), err))?;
  let snapshots = accounts
    .iter()
    .map(|entry| match entry.source_kind {
      crate::account_registry::SourceKind::Drive => load_snapshot_for_drive_account(&app, entry),
      crate::account_registry::SourceKind::Photos => load_snapshot_for_photos_account(&app, entry),
    })
    .collect::<Vec<_>>();

  if let Err(err) = crate::local_index::save_drive_snapshots(&app, &snapshots) {
    eprintln!("OmniDrive could not update the local SQLite index: {err}");
  }

  Ok(snapshots)
}

pub fn fetch_profile_from_access_token(access_token: &str) -> Result<DriveUserProfile, DriveApiError> {
  let about = fetch_about(access_token).map_err(|err| DriveApiError::Profile(err.to_string()))?;
  let user = about
    .user
    .ok_or_else(|| DriveApiError::Profile("Google Drive did not return user details".into()))?;

  let account_id = canonical_account_id(&user);
  Ok(DriveUserProfile {
    account_id,
    display_name: user.display_name.unwrap_or_else(|| "Google Drive".to_string()),
    email: user.email_address,
  })
}

pub fn load_live_account_context_by_id(
  app: &tauri::AppHandle,
  account_id: &str,
) -> Result<LiveAccountContext, DriveApiError> {
  let registry_entry =
    find_account(app, account_id).map_err(|err| DriveApiError::Registry(account_id.into(), err))?;
  load_live_account_context(app, &registry_entry)
}

pub fn load_access_token_for_account(
  app: &tauri::AppHandle,
  account_id: &str,
) -> Result<String, DriveApiError> {
  let _registry_entry =
    find_account(app, account_id).map_err(|err| DriveApiError::Registry(account_id.into(), err))?;
  let tokens = load_tokens_for_account(app, account_id)
    .map_err(|err| DriveApiError::TokenLoad(account_id.into(), err.to_string()))?;
  let refreshed_tokens = ensure_fresh_tokens(app, account_id, tokens)?;
  Ok(refreshed_tokens.access_token)
}

fn load_snapshot_for_account(
  app: &tauri::AppHandle,
  registry_entry: &AccountRegistryEntry,
) -> DriveSnapshotPayload {
  match load_live_account_context(app, registry_entry) {
    Ok(context) => DriveSnapshotPayload {
      account: context.account,
      files: context.files,
    },
    Err(err) => {
      eprintln!(
        "OmniDrive failed to load snapshot for {} ({}): {}",
        registry_entry.label, registry_entry.account_id, err
      );

      DriveSnapshotPayload {
        account: AccountStatePayload {
          account_id: registry_entry.account_id.clone(),
          label: registry_entry.label.clone(),
          display_name: registry_entry.display_name.clone(),
          email: Some(registry_entry.email.clone()),
          source_kind: "drive".into(),
          is_connected: false,
          total_bytes: 0,
          used_bytes: 0,
          free_bytes: 0,
          last_synced_at: registry_entry.last_synced_at.clone(),
          load_error: Some(err.to_string()),
        },
        files: Vec::new(),
      }
    }
  }
}

pub fn load_live_account_context(
  app: &tauri::AppHandle,
  registry_entry: &AccountRegistryEntry,
) -> Result<LiveAccountContext, DriveApiError> {
  let tokens = load_tokens_for_account(app, &registry_entry.account_id)
    .map_err(|err| DriveApiError::TokenLoad(registry_entry.account_id.clone(), err.to_string()))?;
  let refreshed_tokens = ensure_fresh_tokens(app, &registry_entry.account_id, tokens)?;
  let about = fetch_about(&refreshed_tokens.access_token)
    .map_err(|err| DriveApiError::About(registry_entry.account_id.clone(), err.to_string()))?;

  let user = about.user.unwrap_or(GoogleDriveUser {
    display_name: Some(registry_entry.display_name.clone()),
    email_address: Some(registry_entry.email.clone()),
    permission_id: Some(registry_entry.account_id.clone()),
  });
  let last_synced_at = now_rfc3339();
  upsert_account(
    app,
    &registry_entry.account_id,
    user.display_name.as_deref().unwrap_or(&registry_entry.display_name),
    user.email_address.as_deref().unwrap_or(&registry_entry.email),
    crate::account_registry::SourceKind::Drive,
    None,
    Some(last_synced_at.clone()),
  )
  .map_err(|err| DriveApiError::Registry(registry_entry.account_id.clone(), err))?;

  let total_bytes = parse_u64(about.storage_quota.as_ref().and_then(|quota| quota.limit.as_deref()));
  let used_bytes = parse_u64(about.storage_quota.as_ref().and_then(|quota| quota.usage.as_deref()));
  let files = match fetch_all_files(&registry_entry.account_id, &refreshed_tokens.access_token) {
    Ok(files) => files,
    Err(err) => {
      eprintln!(
        "OmniDrive loaded quota for {} but failed to enumerate files: {}",
        registry_entry.account_id, err
      );
      return Ok(LiveAccountContext {
        account: AccountStatePayload {
          account_id: registry_entry.account_id.clone(),
          label: registry_entry.label.clone(),
          display_name: user.display_name.unwrap_or_else(|| registry_entry.display_name.clone()),
          email: user.email_address.or_else(|| Some(registry_entry.email.clone())),
          source_kind: "drive".into(),
          is_connected: true,
          total_bytes,
          used_bytes,
          free_bytes: total_bytes.saturating_sub(used_bytes),
          last_synced_at: Some(last_synced_at),
          load_error: Some(err.to_string()),
        },
        access_token: refreshed_tokens.access_token,
        files: Vec::new(),
      });
    }
  };

  Ok(LiveAccountContext {
    account: AccountStatePayload {
      account_id: registry_entry.account_id.clone(),
      label: registry_entry.label.clone(),
      display_name: user.display_name.unwrap_or_else(|| registry_entry.display_name.clone()),
      email: user.email_address.or_else(|| Some(registry_entry.email.clone())),
      source_kind: "drive".into(),
      is_connected: true,
      total_bytes,
      used_bytes,
      free_bytes: total_bytes.saturating_sub(used_bytes),
      last_synced_at: Some(last_synced_at),
      load_error: None,
    },
    access_token: refreshed_tokens.access_token,
    files,
  })
}

pub fn ensure_fresh_tokens(
  app: &tauri::AppHandle,
  account_id: &str,
  mut tokens: StoredTokenRecord,
) -> Result<StoredTokenRecord, DriveApiError> {
  let now_unix = OffsetDateTime::now_utc().unix_timestamp();
  let expires_at_unix = tokens.expires_at_unix.unwrap_or_default();

  if expires_at_unix > now_unix + 60 && !tokens.access_token.trim().is_empty() {
    return Ok(tokens);
  }

  let client_id = if tokens.client_id.trim().is_empty() {
    std::env::var("GOOGLE_CLIENT_ID")
      .ok()
      .or_else(|| option_env!("GOOGLE_CLIENT_ID").map(str::to_string))
      .unwrap_or_default()
  } else {
    tokens.client_id.clone()
  };

  if client_id.trim().is_empty() {
    return Err(DriveApiError::MissingClientId(account_id.to_string()));
  }

  let client = build_client()?;
  let client_secret = std::env::var("GOOGLE_CLIENT_SECRET")
    .ok()
    .or_else(|| option_env!("GOOGLE_CLIENT_SECRET").map(str::to_string))
    .filter(|value| !value.trim().is_empty());
  let mut form_fields = vec![
    ("client_id", client_id.as_str()),
    ("grant_type", "refresh_token"),
    ("refresh_token", tokens.refresh_token.as_str()),
  ];
  if let Some(client_secret) = client_secret.as_deref() {
    form_fields.push(("client_secret", client_secret));
  }

  let response = client
    .post(GOOGLE_TOKEN_URL)
    .form(&form_fields)
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<GoogleRefreshTokenResponse>())
    .map_err(|err| DriveApiError::TokenRefresh(account_id.to_string(), err.to_string()))?;

  tokens.client_id = client_id;
  tokens.access_token = response.access_token;
  tokens.expires_at_unix = response.expires_in.map(|expires_in| now_unix + expires_in);
  tokens.scope = response.scope.or(tokens.scope);
  tokens.token_type = response.token_type.unwrap_or_else(|| "Bearer".to_string());

  save_tokens_for_account(app, account_id, &tokens)
    .map_err(|err| DriveApiError::TokenSave(account_id.to_string(), err.to_string()))?;

  Ok(tokens)
}

fn load_snapshot_for_drive_account(
  app: &tauri::AppHandle,
  registry_entry: &AccountRegistryEntry,
) -> DriveSnapshotPayload {
  load_snapshot_for_account(app, registry_entry)
}

fn load_snapshot_for_photos_account(
  app: &tauri::AppHandle,
  registry_entry: &AccountRegistryEntry,
) -> DriveSnapshotPayload {
  match photos_api::load_live_photos_context(app, registry_entry) {
    Ok(context) => DriveSnapshotPayload {
      account: context.account,
      files: context.files,
    },
    Err(err) => {
      eprintln!(
        "OmniDrive failed to load Google Photos snapshot for {} ({}): {}",
        registry_entry.label, registry_entry.account_id, err
      );

      DriveSnapshotPayload {
        account: AccountStatePayload {
          account_id: registry_entry.account_id.clone(),
          label: registry_entry.label.clone(),
          display_name: registry_entry.display_name.clone(),
          email: Some(registry_entry.email.clone()),
          source_kind: "photos".into(),
          is_connected: false,
          total_bytes: 0,
          used_bytes: 0,
          free_bytes: 0,
          last_synced_at: registry_entry.last_synced_at.clone(),
          load_error: Some(err.to_string()),
        },
        files: Vec::new(),
      }
    }
  }
}

pub(crate) fn fetch_about(access_token: &str) -> Result<GoogleAboutResponse, reqwest::Error> {
  Client::builder()
    .timeout(std::time::Duration::from_secs(120))
    .build()?
    .get(GOOGLE_DRIVE_ABOUT_URL)
    .header(AUTHORIZATION, format!("Bearer {access_token}"))
    .query(&[(
      "fields",
      "user(displayName,emailAddress,permissionId),storageQuota(limit,usage)",
    )])
    .send()?
    .error_for_status()?
    .json::<GoogleAboutResponse>()
}

pub fn fetch_all_files(
  account_id: &str,
  access_token: &str,
) -> Result<Vec<GoogleDriveFileRecordPayload>, DriveApiError> {
  let client = build_client()?;
  let mut files = Vec::new();
  let mut next_page_token: Option<String> = None;

  loop {
    let mut request = client
      .get(GOOGLE_DRIVE_FILES_URL)
      .header(AUTHORIZATION, format!("Bearer {access_token}"))
      .header(CONTENT_TYPE, "application/json")
      .query(&[
        ("pageSize", "1000"),
        (
          "fields",
          "files(id,name,mimeType,size,parents,trashed,modifiedTime,createdTime,viewedByMeTime,starred,shared,md5Checksum,thumbnailLink),nextPageToken",
        ),
        ("q", "trashed=false"),
        ("spaces", "drive"),
      ]);

    if let Some(page_token) = &next_page_token {
      request = request.query(&[("pageToken", page_token.as_str())]);
    }

    let response = request
      .send()
      .and_then(|response| response.error_for_status())
      .and_then(|response| response.json::<GoogleFilesListResponse>())
      .map_err(|err| DriveApiError::Files(account_id.to_string(), err.to_string()))?;

    files.extend(response.files.unwrap_or_default());
    next_page_token = response.next_page_token;

    if next_page_token.is_none() {
      break;
    }
  }

  Ok(files)
}

pub fn build_client() -> Result<Client, DriveApiError> {
  Client::builder()
    .timeout(std::time::Duration::from_secs(120))
    .build()
    .map_err(|err| DriveApiError::HttpClient(err.to_string()))
}

fn canonical_account_id(user: &GoogleDriveUser) -> String {
  user
    .email_address
    .clone()
    .filter(|email| !email.trim().is_empty())
    .or_else(|| user.permission_id.clone())
    .unwrap_or_else(|| "google-drive-account".to_string())
}

fn parse_u64(value: Option<&str>) -> u64 {
  value
    .and_then(|raw| raw.parse::<u64>().ok())
    .unwrap_or_default()
}

fn now_rfc3339() -> String {
  OffsetDateTime::now_utc()
    .format(&Rfc3339)
    .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
