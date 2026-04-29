use crate::{
  app_session,
  account_registry::{upsert_account, AccountRegistryEntry, SourceKind},
  drive_api::{
    build_client, ensure_fresh_tokens, fetch_profile_from_access_token, fetch_about,
    AccountStatePayload, DriveApiError, GoogleDriveFileRecordPayload,
  },
  oauth::{run_oauth_browser_flow, AccountAuthSummary, OAuthError},
  token_store::save_tokens_for_account,
};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use std::{thread, time::{Duration, Instant}};
use tauri::AppHandle;
use thiserror::Error;

const GOOGLE_PHOTOS_PICKER_SESSIONS_URL: &str = "https://photospicker.googleapis.com/v1/sessions";
const GOOGLE_PHOTOS_PICKER_MEDIA_ITEMS_URL: &str =
  "https://photospicker.googleapis.com/v1/mediaItems";
const PHOTOS_SCOPES: &[&str] = &[
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
];

#[derive(Debug, Error)]
pub enum PhotosApiError {
  #[error("failed to create Google Photos picker session: {0}")]
  Session(String),
  #[error("failed to load Google Photos media items: {0}")]
  MediaItems(String),
  #[error("failed to fetch Google Photos media item content: {0}")]
  MediaBytes(String),
}

#[derive(Debug, Clone, Deserialize)]
struct PickingSessionPayload {
  id: String,
  #[serde(rename = "pickerUri")]
  picker_uri: String,
  #[serde(rename = "mediaItemsSet")]
  media_items_set: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct PickerMediaItemsResponse {
  #[serde(rename = "mediaItems")]
  media_items: Vec<PickedMediaItemPayload>,
  #[serde(rename = "nextPageToken")]
  next_page_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PickedMediaItemPayload {
  id: String,
  #[serde(rename = "createTime")]
  create_time: Option<String>,
  #[serde(rename = "type")]
  media_type: String,
  #[serde(rename = "mediaFile")]
  media_file: PickerMediaFilePayload,
}

#[derive(Debug, Clone, Deserialize)]
struct PickerMediaFilePayload {
  #[serde(rename = "baseUrl")]
  base_url: String,
  #[serde(rename = "mimeType")]
  mime_type: String,
  filename: String,
}

#[derive(Debug, Clone)]
pub struct LivePhotosContext {
  pub account: AccountStatePayload,
  pub files: Vec<GoogleDriveFileRecordPayload>,
}

pub fn run_google_photos_connect(
  app: AppHandle,
  client_id: Option<String>,
) -> Result<AccountAuthSummary, OAuthError> {
  app_session::ensure_authenticated(&app).map_err(OAuthError::Storage)?;
  let grant = run_oauth_browser_flow(client_id, PHOTOS_SCOPES)?;
  let profile = fetch_profile_from_access_token(&grant.token_record.access_token)
    .map_err(|err| OAuthError::TokenExchange(err.to_string()))?;

  let session = create_picker_session(&grant.token_record.access_token)
    .map_err(|err| OAuthError::TokenExchange(err.to_string()))?;
  let open_url = if session.picker_uri.ends_with("/autoclose") {
    session.picker_uri.clone()
  } else {
    format!("{}/autoclose", session.picker_uri.trim_end_matches('/'))
  };
  tauri_plugin_opener::open_url(open_url.as_str(), None::<&str>)
    .map_err(|err| OAuthError::BrowserLaunch(err.to_string()))?;

  let completed_session = wait_for_picker_session(
    &grant.token_record.access_token,
    &session.id,
    Duration::from_secs(600),
  )?;
  let account_id = canonical_photos_account_id(&profile.account_id);
  let registry_entry = upsert_account(
    &app,
    &account_id,
    &profile.display_name,
    profile.email.as_deref().unwrap_or(""),
    SourceKind::Photos,
    Some(completed_session.id.clone()),
    None,
  )
  .map_err(OAuthError::Storage)?;

  let mut token_record = grant.token_record.clone();
  token_record.account_id = account_id.clone();
  save_tokens_for_account(&app, &account_id, &token_record)
    .map_err(|err| OAuthError::Storage(err.to_string()))?;

  Ok(AccountAuthSummary {
    account_id,
    label: registry_entry.label,
    display_name: profile.display_name,
    email: profile.email,
    token_expires_at_unix: token_record.expires_at_unix,
    scope: token_record.scope,
  })
}

pub fn load_live_photos_context(
  app: &AppHandle,
  registry_entry: &AccountRegistryEntry,
) -> Result<LivePhotosContext, DriveApiError> {
  let tokens = crate::token_store::load_tokens_for_account(app, &registry_entry.account_id)
    .map_err(|err| DriveApiError::TokenLoad(registry_entry.account_id.clone(), err.to_string()))?;
  let refreshed_tokens = ensure_fresh_tokens(app, &registry_entry.account_id, tokens)?;
  let about = fetch_about(&refreshed_tokens.access_token)
    .map_err(|err| DriveApiError::About(registry_entry.account_id.clone(), err.to_string()))?;

  let user = about.user.unwrap_or(crate::drive_api::GoogleDriveUser {
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
    SourceKind::Photos,
    registry_entry.remote_collection_id.clone(),
    Some(last_synced_at.clone()),
  )
  .map_err(|err| DriveApiError::Registry(registry_entry.account_id.clone(), err))?;

  let total_bytes =
    parse_u64(about.storage_quota.as_ref().and_then(|quota| quota.limit.as_deref()));
  let used_bytes =
    parse_u64(about.storage_quota.as_ref().and_then(|quota| quota.usage.as_deref()));
  let session_id = registry_entry
    .remote_collection_id
    .clone()
    .ok_or_else(|| DriveApiError::Files(registry_entry.account_id.clone(), "missing Google Photos picker session id".into()))?;
  let files = match fetch_all_picked_media_items(&refreshed_tokens.access_token, &session_id) {
    Ok(files) => map_picked_media_items_to_files(files),
    Err(err) => {
      eprintln!(
        "OmniDrive loaded quota for {} but failed to enumerate Google Photos items: {}",
        registry_entry.account_id, err
      );
      return Ok(LivePhotosContext {
        account: AccountStatePayload {
          account_id: registry_entry.account_id.clone(),
          label: registry_entry.label.clone(),
          display_name: user
            .display_name
            .unwrap_or_else(|| registry_entry.display_name.clone()),
          email: user.email_address.or_else(|| Some(registry_entry.email.clone())),
          source_kind: "photos".into(),
          is_connected: true,
          total_bytes,
          used_bytes,
          free_bytes: total_bytes.saturating_sub(used_bytes),
          last_synced_at: Some(last_synced_at),
          load_error: Some(err.to_string()),
        },
        files: Vec::new(),
      });
    }
  };

  Ok(LivePhotosContext {
    account: AccountStatePayload {
      account_id: registry_entry.account_id.clone(),
      label: registry_entry.label.clone(),
      display_name: user.display_name.unwrap_or_else(|| registry_entry.display_name.clone()),
      email: user.email_address.or_else(|| Some(registry_entry.email.clone())),
      source_kind: "photos".into(),
      is_connected: true,
      total_bytes,
      used_bytes,
      free_bytes: total_bytes.saturating_sub(used_bytes),
      last_synced_at: Some(last_synced_at),
      load_error: None,
    },
    files,
  })
}

pub fn fetch_picked_media_item_bytes(
  access_token: &str,
  session_id: &str,
  media_id: &str,
  mime_type: &str,
) -> Result<Vec<u8>, PhotosApiError> {
  let item = fetch_picked_media_item(access_token, session_id, media_id)?;
  let client = build_client().map_err(|err| PhotosApiError::MediaBytes(err.to_string()))?;
  let content_url =
    photos_content_url(&item.media_file.base_url, mime_type, &item.media_type);
  client
    .get(content_url)
    .header(AUTHORIZATION, format!("Bearer {access_token}"))
    .header(CONTENT_TYPE, "application/json")
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.bytes())
    .map(|bytes| bytes.to_vec())
    .map_err(|err| PhotosApiError::MediaBytes(err.to_string()))
}

fn fetch_picked_media_item(
  access_token: &str,
  session_id: &str,
  media_id: &str,
) -> Result<PickedMediaItemPayload, PhotosApiError> {
  let items = fetch_all_picked_media_items(access_token, session_id)?;
  items
    .into_iter()
    .find(|item| item.id == media_id)
    .ok_or_else(|| PhotosApiError::MediaItems(format!("picked media item {media_id} was not found in session {session_id}")))
}

fn map_picked_media_items_to_files(
  items: Vec<PickedMediaItemPayload>,
) -> Vec<GoogleDriveFileRecordPayload> {
  items
    .into_iter()
    .map(|item| GoogleDriveFileRecordPayload {
      id: item.id,
      name: item.media_file.filename,
      mime_type: item.media_file.mime_type,
      size: None,
      parents: None,
      trashed: Some(false),
      modified_time: item.create_time,
      created_time: None,
      viewed_by_me_time: None,
      starred: Some(false),
      shared: Some(false),
      md5_checksum: None,
      thumbnail_link: None,
    })
    .collect()
}

fn create_picker_session(access_token: &str) -> Result<PickingSessionPayload, PhotosApiError> {
  let client = build_client().map_err(|err| PhotosApiError::Session(err.to_string()))?;
  client
    .post(GOOGLE_PHOTOS_PICKER_SESSIONS_URL)
    .header(AUTHORIZATION, format!("Bearer {access_token}"))
    .json(&serde_json::json!({}))
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<PickingSessionPayload>())
    .map_err(|err| PhotosApiError::Session(err.to_string()))
}

fn wait_for_picker_session(
  access_token: &str,
  session_id: &str,
  timeout: Duration,
) -> Result<PickingSessionPayload, OAuthError> {
  let started = Instant::now();
  loop {
    if started.elapsed() > timeout {
      return Err(OAuthError::CallbackTimeout);
    }

    let session = fetch_picker_session(access_token, session_id)
      .map_err(|err| OAuthError::TokenExchange(err.to_string()))?;
    if session.media_items_set {
      return Ok(session);
    }

    thread::sleep(Duration::from_secs(2));
  }
}

fn fetch_picker_session(
  access_token: &str,
  session_id: &str,
) -> Result<PickingSessionPayload, PhotosApiError> {
  let client = build_client().map_err(|err| PhotosApiError::Session(err.to_string()))?;
  client
    .get(format!("{GOOGLE_PHOTOS_PICKER_SESSIONS_URL}/{session_id}"))
    .header(AUTHORIZATION, format!("Bearer {access_token}"))
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<PickingSessionPayload>())
    .map_err(|err| PhotosApiError::Session(err.to_string()))
}

fn fetch_all_picked_media_items(
  access_token: &str,
  session_id: &str,
) -> Result<Vec<PickedMediaItemPayload>, PhotosApiError> {
  let client = build_client().map_err(|err| PhotosApiError::MediaItems(err.to_string()))?;
  let mut items = Vec::new();
  let mut next_page_token: Option<String> = None;

  loop {
    let mut request = client
      .get(GOOGLE_PHOTOS_PICKER_MEDIA_ITEMS_URL)
      .header(AUTHORIZATION, format!("Bearer {access_token}"))
      .header(CONTENT_TYPE, "application/json")
      .query(&[("sessionId", session_id), ("pageSize", "100")]);

    if let Some(page_token) = &next_page_token {
      request = request.query(&[("pageToken", page_token.as_str())]);
    }

    let response = request
      .send()
      .and_then(|response| response.error_for_status())
      .and_then(|response| response.json::<PickerMediaItemsResponse>())
      .map_err(|err| PhotosApiError::MediaItems(err.to_string()))?;

    items.extend(response.media_items);
    next_page_token = response.next_page_token;

    if next_page_token.is_none() {
      break;
    }
  }

  Ok(items)
}

fn photos_content_url(base_url: &str, mime_type: &str, media_type: &str) -> String {
  if mime_type.starts_with("video/") || media_type == "video" {
    format!("{base_url}=dv")
  } else {
    format!("{base_url}=d")
  }
}

fn canonical_photos_account_id(account_id: &str) -> String {
  format!("photos:{account_id}")
}

fn parse_u64(value: Option<&str>) -> u64 {
  value
    .and_then(|raw| raw.parse::<u64>().ok())
    .unwrap_or_default()
}

fn now_rfc3339() -> String {
  time::OffsetDateTime::now_utc()
    .format(&time::format_description::well_known::Rfc3339)
    .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
