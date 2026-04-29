use crate::{
  account_registry::{find_account, list_accounts, SourceKind},
  drive_api::{
    build_client, load_access_token_for_account, load_live_account_context,
    load_live_account_context_by_id, LiveAccountContext, GoogleDriveFileRecordPayload,
    GOOGLE_FOLDER_MIME_TYPE,
  },
  photos_api::fetch_picked_media_item_bytes,
};
use mime_guess::MimeGuess;
use reqwest::{
  blocking::{Client, Response},
  header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, LOCATION},
};
use serde::Deserialize;
use serde_json::json;
use std::{
  collections::HashMap,
  fs::{self, File},
  io,
  path::{Path, PathBuf},
};
use tauri_plugin_dialog::DialogExt;
use thiserror::Error;

const GOOGLE_DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";

#[derive(Debug, Error)]
pub enum DriveMutationError {
  #[error("no connected Google Drive accounts are available for this action")]
  NoConnectedAccounts,
  #[error("folder names cannot be empty or contain path separators")]
  InvalidFolderName,
  #[error("item names cannot be empty or contain path separators")]
  InvalidItemName,
  #[error("virtual path {0} is invalid")]
  InvalidVirtualPath(String),
  #[error("virtual folder {0} already exists")]
  FolderAlreadyExists(String),
  #[error("virtual folder {0} was not found")]
  FolderNotFound(String),
  #[error("cannot mutate the OmniDrive root folder")]
  RootFolderMutation,
  #[error("file size {file_size} bytes exceeds the maximum continuous free space of any single drive ({maximum_capacity} bytes)")]
  InsufficientContinuousSpace { file_size: u64, maximum_capacity: u64 },
  #[error("the selected Google Workspace file type cannot be exported yet: {0}")]
  UnsupportedWorkspaceExport(String),
  #[error("filesystem error: {0}")]
  Filesystem(String),
  #[error("google drive request failed: {0}")]
  GoogleDrive(String),
  #[error("account registry error: {0}")]
  Registry(String),
  #[error("virtual path resolution failed: {0}")]
  VirtualPath(String),
  #[error("the selected source is read-only: {0}")]
  ReadOnlySource(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatedDriveItemResponse {
  id: String,
  name: String,
  mime_type: String,
  parents: Option<Vec<String>>,
  modified_time: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferDriveNodeRequest {
  account_id: String,
  google_id: String,
  filename: String,
  mime_type: String,
}

#[derive(Debug, Clone)]
struct MutableAccountContext {
  account_id: String,
  free_bytes: u64,
  access_token: String,
  files: Vec<GoogleDriveFileRecordPayload>,
}

impl From<LiveAccountContext> for MutableAccountContext {
  fn from(value: LiveAccountContext) -> Self {
    Self {
      account_id: value.account.account_id,
      free_bytes: value.account.free_bytes,
      access_token: value.access_token,
      files: value.files,
    }
  }
}

pub fn upload_into_virtual_folder(
  app: tauri::AppHandle,
  target_virtual_path: String,
) -> Result<usize, DriveMutationError> {
  let Some(file_paths) = app
    .dialog()
    .file()
    .set_title("Select files to upload into OmniDrive")
    .blocking_pick_files()
  else {
    return Ok(0);
  };

  let local_paths = file_paths
    .into_iter()
    .map(dialog_path_to_path_buf)
    .collect::<Result<Vec<_>, _>>()?;
  if local_paths.is_empty() {
    return Ok(0);
  }

  let normalized_target = normalize_virtual_path(&target_virtual_path)?;
  let mut accounts = load_mutable_accounts(&app)?;
  let client = build_client().map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  let mut uploaded_count = 0usize;

  for local_path in local_paths {
    let metadata = fs::metadata(&local_path)
      .map_err(|err| DriveMutationError::Filesystem(format!("failed to inspect {}: {err}", local_path.display())))?;
    if !metadata.is_file() {
      continue;
    }

    let file_size = metadata.len();
    let chosen_index = select_upload_account(&accounts, file_size)?;
    let context = &mut accounts[chosen_index];
    let parent_google_id =
      ensure_virtual_folder_path(&client, context, &normalized_target)?;
    let uploaded_record = upload_local_file(
      &client,
      context,
      &local_path,
      file_size,
      parent_google_id.as_deref(),
    )?;

    context.free_bytes = context.free_bytes.saturating_sub(file_size);
    context.files.push(uploaded_record);
    uploaded_count += 1;
  }

  Ok(uploaded_count)
}

pub fn create_virtual_folder(
  app: tauri::AppHandle,
  parent_virtual_path: String,
  folder_name: String,
) -> Result<(), DriveMutationError> {
  let normalized_parent = normalize_virtual_path(&parent_virtual_path)?;
  let validated_name = validate_item_name(&folder_name, true)?;
  let folder_virtual_path = join_virtual_path(&normalized_parent, &validated_name);
  let mut accounts = load_mutable_accounts(&app)?;
  let folder_already_exists = accounts.iter().try_fold(false, |found, account| {
    if found {
      return Ok(true);
    }

    find_folder_id_by_virtual_path(&account.files, &folder_virtual_path).map(|entry| entry.is_some())
  })?;
  if folder_already_exists {
    return Err(DriveMutationError::FolderAlreadyExists(folder_virtual_path));
  }

  let selected_index = select_upload_account(&accounts, 0)?;
  let client = build_client().map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  let context = &mut accounts[selected_index];
  let parent_google_id = ensure_virtual_folder_path(&client, context, &normalized_parent)?;
  let created_folder = create_folder_record(
    &client,
    &context.access_token,
    &validated_name,
    parent_google_id.as_deref(),
  )?;
  context.files.push(created_folder);
  Ok(())
}

pub fn rename_virtual_folder(
  app: tauri::AppHandle,
  virtual_path: String,
  next_name: String,
) -> Result<usize, DriveMutationError> {
  let normalized_virtual_path = normalize_virtual_path(&virtual_path)?;
  if normalized_virtual_path == "/" {
    return Err(DriveMutationError::RootFolderMutation);
  }

  let validated_name = validate_item_name(&next_name, true)?;
  let accounts = load_mutable_accounts(&app)?;
  let client = build_client().map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  let mut renamed = 0usize;

  for account in accounts {
    if let Some(folder_id) = find_folder_id_by_virtual_path(&account.files, &normalized_virtual_path)? {
      patch_drive_item_name(&client, &account.access_token, &folder_id, &validated_name)?;
      renamed += 1;
    }
  }

  if renamed == 0 {
    return Err(DriveMutationError::FolderNotFound(normalized_virtual_path));
  }

  Ok(renamed)
}

pub fn delete_virtual_folder(
  app: tauri::AppHandle,
  virtual_path: String,
) -> Result<usize, DriveMutationError> {
  let normalized_virtual_path = normalize_virtual_path(&virtual_path)?;
  if normalized_virtual_path == "/" {
    return Err(DriveMutationError::RootFolderMutation);
  }

  let accounts = load_mutable_accounts(&app)?;
  let client = build_client().map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  let mut deleted = 0usize;

  for account in accounts {
    if let Some(folder_id) = find_folder_id_by_virtual_path(&account.files, &normalized_virtual_path)? {
      delete_drive_item(&client, &account.access_token, &folder_id)?;
      deleted += 1;
    }
  }

  if deleted == 0 {
    return Err(DriveMutationError::FolderNotFound(normalized_virtual_path));
  }

  Ok(deleted)
}

pub fn rename_drive_node(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  next_name: String,
) -> Result<(), DriveMutationError> {
  let registry_entry =
    find_account(&app, &account_id).map_err(|err| DriveMutationError::Registry(err))?;
  if matches!(registry_entry.source_kind, SourceKind::Photos) {
    return Err(DriveMutationError::ReadOnlySource(
      "Google Photos items cannot be renamed inside OmniDrive yet".into(),
    ));
  }
  let context = load_live_account_context_by_id(&app, &account_id)
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  let validated_name = validate_item_name(&next_name, false)?;
  let client = build_client().map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  patch_drive_item_name(&client, &context.access_token, &google_id, &validated_name)
}

pub fn delete_drive_node(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
) -> Result<(), DriveMutationError> {
  let registry_entry =
    find_account(&app, &account_id).map_err(|err| DriveMutationError::Registry(err))?;
  if matches!(registry_entry.source_kind, SourceKind::Photos) {
    return Err(DriveMutationError::ReadOnlySource(
      "Google Photos items cannot be deleted inside OmniDrive yet".into(),
    ));
  }
  let context = load_live_account_context_by_id(&app, &account_id)
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  let client = build_client().map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  delete_drive_item(&client, &context.access_token, &google_id)
}

pub fn download_drive_node(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  filename: String,
  mime_type: String,
) -> Result<Option<String>, DriveMutationError> {
  let suggested_file_name = suggested_download_name(&filename, &mime_type)?;
  let Some(save_path) = app
    .dialog()
    .file()
    .set_title("Save OmniDrive file")
    .set_file_name(&suggested_file_name)
    .blocking_save_file()
  else {
    return Ok(None);
  };

  let destination = dialog_path_to_path_buf(save_path)?;
  let registry_entry =
    find_account(&app, &account_id).map_err(|err| DriveMutationError::Registry(err))?;
  match registry_entry.source_kind {
    SourceKind::Drive => {
      let context = load_live_account_context_by_id(&app, &account_id)
        .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
      if mime_type == GOOGLE_FOLDER_MIME_TYPE {
        return Err(DriveMutationError::UnsupportedWorkspaceExport(
          "Folders cannot be downloaded as a single file".into(),
        ));
      }

      let client = build_client().map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
      let mut response = if let Some((export_mime, _)) = workspace_export_for_mime_type(&mime_type) {
        client
          .get(format!("{GOOGLE_DRIVE_FILES_URL}/{google_id}/export"))
          .header(AUTHORIZATION, bearer(&context.access_token))
          .query(&[("mimeType", export_mime)])
          .send()
          .and_then(|response| response.error_for_status())
          .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?
      } else {
        client
          .get(format!("{GOOGLE_DRIVE_FILES_URL}/{google_id}"))
          .header(AUTHORIZATION, bearer(&context.access_token))
          .query(&[("alt", "media")])
          .send()
          .and_then(|response| response.error_for_status())
          .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?
      };

      write_response_to_path(&mut response, &destination)?;
    }
    SourceKind::Photos => {
      let access_token = load_access_token_for_account(&app, &account_id)
        .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
      let session_id = registry_entry.remote_collection_id.ok_or_else(|| {
        DriveMutationError::Registry(format!(
          "google photos account {account_id} is missing a picker session id"
        ))
      })?;
      let bytes = fetch_picked_media_item_bytes(&access_token, &session_id, &google_id, &mime_type)
        .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
      fs::write(&destination, bytes)
        .map_err(|err| DriveMutationError::Filesystem(err.to_string()))?;
    }
  }
  Ok(Some(destination.display().to_string()))
}

pub fn transfer_drive_nodes(
  app: tauri::AppHandle,
  nodes: Vec<TransferDriveNodeRequest>,
  target_account_id: String,
  target_virtual_path: String,
) -> Result<usize, DriveMutationError> {
  if nodes.is_empty() {
    return Ok(0);
  }

  let target_registry =
    find_account(&app, &target_account_id).map_err(DriveMutationError::Registry)?;
  if !matches!(target_registry.source_kind, SourceKind::Drive) {
    return Err(DriveMutationError::ReadOnlySource(
      "Files can only be transferred into Google Drive accounts".into(),
    ));
  }

  let normalized_target = normalize_virtual_path(&target_virtual_path)?;
  let mut target_context = MutableAccountContext::from(
    load_live_account_context_by_id(&app, &target_account_id)
      .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?,
  );
  let client = build_client().map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  let parent_google_id = ensure_virtual_folder_path(
    &client,
    &mut target_context,
    &normalized_target,
  )?;
  let mut source_tokens = HashMap::<String, String>::new();
  let mut transferred_count = 0usize;

  for node in nodes {
    if node.account_id == target_account_id {
      continue;
    }

    let source_registry =
      find_account(&app, &node.account_id).map_err(DriveMutationError::Registry)?;
    if !matches!(source_registry.source_kind, SourceKind::Drive) {
      return Err(DriveMutationError::ReadOnlySource(
        "Google Photos items cannot be transferred between drives".into(),
      ));
    }
    if node.mime_type == GOOGLE_FOLDER_MIME_TYPE {
      return Err(DriveMutationError::UnsupportedWorkspaceExport(
        "Folder transfer is not supported yet. Select files inside the folder instead.".into(),
      ));
    }

    let source_token = match source_tokens.get(&node.account_id) {
      Some(token) => token.clone(),
      None => {
        let token = load_access_token_for_account(&app, &node.account_id)
          .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
        source_tokens.insert(node.account_id.clone(), token.clone());
        token
      }
    };
    let transfer_payload = fetch_transfer_payload(&client, &source_token, &node)?;
    let file_size = transfer_payload.bytes.len() as u64;
    if target_context.free_bytes < file_size {
      return Err(DriveMutationError::InsufficientContinuousSpace {
        file_size,
        maximum_capacity: target_context.free_bytes,
      });
    }

    let uploaded = upload_bytes_as_file(
      &client,
      &target_context,
      &transfer_payload.filename,
      &transfer_payload.mime_type,
      transfer_payload.bytes,
      parent_google_id.as_deref(),
    )?;
    target_context.free_bytes = target_context.free_bytes.saturating_sub(file_size);
    target_context.files.push(uploaded);
    transferred_count += 1;
  }

  Ok(transferred_count)
}

fn load_mutable_accounts(app: &tauri::AppHandle) -> Result<Vec<MutableAccountContext>, DriveMutationError> {
  let registry_entries = list_accounts(app).map_err(DriveMutationError::Registry)?;
  let accounts = registry_entries
    .iter()
    .filter(|entry| matches!(entry.source_kind, SourceKind::Drive))
    .filter_map(|entry| load_live_account_context(app, entry).ok())
    .map(MutableAccountContext::from)
    .collect::<Vec<_>>();

  if accounts.is_empty() {
    return Err(DriveMutationError::NoConnectedAccounts);
  }

  Ok(accounts)
}

fn select_upload_account(
  accounts: &[MutableAccountContext],
  file_size: u64,
) -> Result<usize, DriveMutationError> {
  let mut candidates = accounts
    .iter()
    .enumerate()
    .filter(|(_, account)| account.free_bytes >= file_size)
    .collect::<Vec<_>>();

  if candidates.is_empty() {
    let maximum_capacity = accounts.iter().map(|account| account.free_bytes).max().unwrap_or(0);
    return Err(DriveMutationError::InsufficientContinuousSpace {
      file_size,
      maximum_capacity,
    });
  }

  candidates.sort_by(|(left_index, left), (right_index, right)| {
    right
      .free_bytes
      .cmp(&left.free_bytes)
      .then_with(|| left.account_id.cmp(&right.account_id))
      .then_with(|| left_index.cmp(right_index))
  });

  Ok(candidates[0].0)
}

fn normalize_virtual_path(virtual_path: &str) -> Result<String, DriveMutationError> {
  if virtual_path.trim().is_empty() {
    return Ok("/".into());
  }

  let mut normalized = virtual_path.trim().replace('\\', "/");
  if !normalized.starts_with('/') {
    normalized.insert(0, '/');
  }

  while normalized.len() > 1 && normalized.ends_with('/') {
    normalized.pop();
  }

  if normalized.contains("//") {
    return Err(DriveMutationError::InvalidVirtualPath(virtual_path.into()));
  }

  Ok(normalized)
}

fn split_virtual_path(virtual_path: &str) -> Result<Vec<String>, DriveMutationError> {
  let normalized = normalize_virtual_path(virtual_path)?;
  if normalized == "/" {
    return Ok(Vec::new());
  }

  Ok(
    normalized
      .trim_start_matches('/')
      .split('/')
      .map(|segment| segment.to_string())
      .collect(),
  )
}

fn join_virtual_path(parent_virtual_path: &str, leaf_name: &str) -> String {
  if parent_virtual_path == "/" {
    format!("/{leaf_name}")
  } else {
    format!("{parent_virtual_path}/{leaf_name}")
  }
}

fn validate_item_name(value: &str, folder_only: bool) -> Result<String, DriveMutationError> {
  let trimmed = value.trim();
  if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
    return if folder_only {
      Err(DriveMutationError::InvalidFolderName)
    } else {
      Err(DriveMutationError::InvalidItemName)
    };
  }

  Ok(trimmed.to_string())
}

fn sanitize_path_segment(value: &str) -> String {
  let cleaned = value.trim().replace('/', "_");
  if cleaned.is_empty() {
    "Untitled".into()
  } else {
    cleaned
  }
}

fn build_virtual_path_lookup(
  files: &[GoogleDriveFileRecordPayload],
) -> Result<HashMap<String, String>, DriveMutationError> {
  let by_id = files
    .iter()
    .map(|file| (file.id.clone(), file))
    .collect::<HashMap<_, _>>();
  let mut cache = HashMap::<String, String>::new();
  let mut resolving = Vec::<String>::new();

  fn resolve(
    google_id: &str,
    by_id: &HashMap<String, &GoogleDriveFileRecordPayload>,
    cache: &mut HashMap<String, String>,
    resolving: &mut Vec<String>,
  ) -> Result<String, DriveMutationError> {
    if let Some(cached) = cache.get(google_id) {
      return Ok(cached.clone());
    }

    let Some(record) = by_id.get(google_id) else {
      return Ok("/".into());
    };

    if resolving.iter().any(|current| current == google_id) {
      return Err(DriveMutationError::VirtualPath(format!(
        "cyclic parent chain detected for Google Drive item {google_id}"
      )));
    }

    resolving.push(google_id.into());
    let parent_id = record.parents.as_ref().and_then(|parents| parents.first()).cloned();
    let parent_path = match parent_id {
      Some(parent_google_id) if by_id.contains_key(&parent_google_id) => {
        resolve(&parent_google_id, by_id, cache, resolving)?
      }
      _ => "/".into(),
    };
    let segment = sanitize_path_segment(&record.name);
    let virtual_path = if parent_path == "/" {
      format!("/{segment}")
    } else {
      format!("{parent_path}/{segment}")
    };
    resolving.pop();
    cache.insert(google_id.into(), virtual_path.clone());
    Ok(virtual_path)
  }

  for file in files {
    let _ = resolve(&file.id, &by_id, &mut cache, &mut resolving)?;
  }

  Ok(cache)
}

fn find_folder_id_by_virtual_path(
  files: &[GoogleDriveFileRecordPayload],
  virtual_path: &str,
) -> Result<Option<String>, DriveMutationError> {
  let lookup = build_virtual_path_lookup(files)?;
  Ok(
    files
      .iter()
      .find(|file| {
        file.mime_type == GOOGLE_FOLDER_MIME_TYPE
          && lookup.get(&file.id).is_some_and(|path| path == virtual_path)
      })
      .map(|file| file.id.clone()),
  )
}

fn ensure_virtual_folder_path(
  client: &Client,
  account: &mut MutableAccountContext,
  virtual_path: &str,
) -> Result<Option<String>, DriveMutationError> {
  let segments = split_virtual_path(virtual_path)?;
  if segments.is_empty() {
    return Ok(None);
  }

  let mut parent_id: Option<String> = None;
  let mut current_virtual_path = String::from("/");

  for segment in segments {
    current_virtual_path = join_virtual_path(&current_virtual_path, &segment);

    if let Some(existing_id) = find_folder_id_by_virtual_path(&account.files, &current_virtual_path)? {
      parent_id = Some(existing_id);
      continue;
    }

    let created_folder =
      create_folder_record(client, &account.access_token, &segment, parent_id.as_deref())?;
    parent_id = Some(created_folder.id.clone());
    account.files.push(created_folder);
  }

  Ok(parent_id)
}

fn create_folder_record(
  client: &Client,
  access_token: &str,
  folder_name: &str,
  parent_google_id: Option<&str>,
) -> Result<GoogleDriveFileRecordPayload, DriveMutationError> {
  let mut metadata = json!({
    "name": folder_name,
    "mimeType": GOOGLE_FOLDER_MIME_TYPE,
  });

  if let Some(parent_id) = parent_google_id {
    metadata["parents"] = json!([parent_id]);
  }

  let created = client
    .post(GOOGLE_DRIVE_FILES_URL)
    .header(AUTHORIZATION, bearer(access_token))
    .json(&metadata)
    .query(&[("fields", "id,name,mimeType,parents,modifiedTime")])
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<CreatedDriveItemResponse>())
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;

  Ok(created_item_to_file_record(created, None))
}

fn upload_local_file(
  client: &Client,
  account: &MutableAccountContext,
  local_path: &Path,
  file_size: u64,
  parent_google_id: Option<&str>,
) -> Result<GoogleDriveFileRecordPayload, DriveMutationError> {
  let file_name = local_path
    .file_name()
    .and_then(|value| value.to_str())
    .ok_or_else(|| {
      DriveMutationError::Filesystem(format!(
        "failed to determine file name for {}",
        local_path.display()
      ))
    })?;
  let content_type = MimeGuess::from_path(local_path)
    .first_or_octet_stream()
    .essence_str()
    .to_string();

  if file_size == 0 {
    let mut metadata = json!({ "name": file_name });
    if let Some(parent_id) = parent_google_id {
      metadata["parents"] = json!([parent_id]);
    }

    let created = client
      .post(GOOGLE_DRIVE_FILES_URL)
      .header(AUTHORIZATION, bearer(&account.access_token))
      .json(&metadata)
      .query(&[("fields", "id,name,mimeType,parents,modifiedTime")])
      .send()
      .and_then(|response| response.error_for_status())
      .and_then(|response| response.json::<CreatedDriveItemResponse>())
      .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
    return Ok(created_item_to_file_record(created, Some("0".into())));
  }

  let mut metadata = json!({ "name": file_name });
  if let Some(parent_id) = parent_google_id {
    metadata["parents"] = json!([parent_id]);
  }

  let upload_location = client
    .post(GOOGLE_DRIVE_UPLOAD_URL)
    .header(AUTHORIZATION, bearer(&account.access_token))
    .header(CONTENT_TYPE, "application/json; charset=UTF-8")
    .header("X-Upload-Content-Type", &content_type)
    .header("X-Upload-Content-Length", file_size)
    .query(&[
      ("uploadType", "resumable"),
      ("fields", "id,name,mimeType,parents,modifiedTime"),
    ])
    .body(metadata.to_string())
    .send()
    .and_then(|response| response.error_for_status())
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?
    .headers()
    .get(LOCATION)
    .and_then(|value| value.to_str().ok())
    .map(|value| value.to_string())
    .ok_or_else(|| DriveMutationError::GoogleDrive("Google did not return a resumable upload URL".into()))?;

  let file = File::open(local_path)
    .map_err(|err| DriveMutationError::Filesystem(format!("failed to open {}: {err}", local_path.display())))?;
  let uploaded = client
    .put(upload_location)
    .header(CONTENT_TYPE, content_type)
    .header(CONTENT_LENGTH, file_size)
    .header(
      CONTENT_RANGE,
      format!("bytes 0-{}/{}", file_size.saturating_sub(1), file_size),
    )
    .body(file)
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<CreatedDriveItemResponse>())
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;

  Ok(created_item_to_file_record(uploaded, Some(file_size.to_string())))
}

#[derive(Debug)]
struct TransferPayload {
  filename: String,
  mime_type: String,
  bytes: Vec<u8>,
}

fn fetch_transfer_payload(
  client: &Client,
  source_access_token: &str,
  node: &TransferDriveNodeRequest,
) -> Result<TransferPayload, DriveMutationError> {
  if let Some((export_mime, extension)) = workspace_export_for_mime_type(&node.mime_type) {
    let bytes = client
      .get(format!("{GOOGLE_DRIVE_FILES_URL}/{}/export", node.google_id))
      .header(AUTHORIZATION, bearer(source_access_token))
      .query(&[("mimeType", export_mime)])
      .send()
      .and_then(|response| response.error_for_status())
      .and_then(|response| response.bytes())
      .map(|bytes| bytes.to_vec())
      .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
    let filename = append_extension_if_missing(&node.filename, extension)?;
    return Ok(TransferPayload {
      filename,
      mime_type: export_mime.to_string(),
      bytes,
    });
  }

  let bytes = client
    .get(format!("{GOOGLE_DRIVE_FILES_URL}/{}", node.google_id))
    .header(AUTHORIZATION, bearer(source_access_token))
    .query(&[("alt", "media")])
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.bytes())
    .map(|bytes| bytes.to_vec())
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;

  Ok(TransferPayload {
    filename: validate_item_name(&node.filename, false)?,
    mime_type: node.mime_type.clone(),
    bytes,
  })
}

fn upload_bytes_as_file(
  client: &Client,
  account: &MutableAccountContext,
  filename: &str,
  mime_type: &str,
  bytes: Vec<u8>,
  parent_google_id: Option<&str>,
) -> Result<GoogleDriveFileRecordPayload, DriveMutationError> {
  let validated_name = validate_item_name(filename, false)?;
  let mut metadata = json!({ "name": validated_name });
  if let Some(parent_id) = parent_google_id {
    metadata["parents"] = json!([parent_id]);
  }

  if bytes.is_empty() {
    let created = client
      .post(GOOGLE_DRIVE_FILES_URL)
      .header(AUTHORIZATION, bearer(&account.access_token))
      .json(&metadata)
      .query(&[("fields", "id,name,mimeType,parents,modifiedTime")])
      .send()
      .and_then(|response| response.error_for_status())
      .and_then(|response| response.json::<CreatedDriveItemResponse>())
      .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
    return Ok(created_item_to_file_record(created, Some("0".into())));
  }

  let file_size = bytes.len() as u64;
  let upload_location = client
    .post(GOOGLE_DRIVE_UPLOAD_URL)
    .header(AUTHORIZATION, bearer(&account.access_token))
    .header(CONTENT_TYPE, "application/json; charset=UTF-8")
    .header("X-Upload-Content-Type", mime_type)
    .header("X-Upload-Content-Length", file_size)
    .query(&[
      ("uploadType", "resumable"),
      ("fields", "id,name,mimeType,parents,modifiedTime"),
    ])
    .body(metadata.to_string())
    .send()
    .and_then(|response| response.error_for_status())
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?
    .headers()
    .get(LOCATION)
    .and_then(|value| value.to_str().ok())
    .map(|value| value.to_string())
    .ok_or_else(|| DriveMutationError::GoogleDrive("Google did not return a resumable upload URL".into()))?;

  let uploaded = client
    .put(upload_location)
    .header(CONTENT_TYPE, mime_type)
    .header(CONTENT_LENGTH, file_size)
    .header(
      CONTENT_RANGE,
      format!("bytes 0-{}/{}", file_size.saturating_sub(1), file_size),
    )
    .body(bytes)
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<CreatedDriveItemResponse>())
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;

  Ok(created_item_to_file_record(uploaded, Some(file_size.to_string())))
}

fn created_item_to_file_record(
  created: CreatedDriveItemResponse,
  size: Option<String>,
) -> GoogleDriveFileRecordPayload {
  GoogleDriveFileRecordPayload {
    id: created.id,
    name: created.name,
    mime_type: created.mime_type,
    size,
    parents: created.parents,
    trashed: Some(false),
    modified_time: created.modified_time,
    created_time: None,
    viewed_by_me_time: None,
    starred: Some(false),
    shared: Some(false),
    md5_checksum: None,
    thumbnail_link: None,
  }
}

fn patch_drive_item_name(
  client: &Client,
  access_token: &str,
  google_id: &str,
  next_name: &str,
) -> Result<(), DriveMutationError> {
  client
    .patch(format!("{GOOGLE_DRIVE_FILES_URL}/{google_id}"))
    .header(AUTHORIZATION, bearer(access_token))
    .json(&json!({ "name": next_name }))
    .send()
    .and_then(|response| response.error_for_status())
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  Ok(())
}

fn delete_drive_item(
  client: &Client,
  access_token: &str,
  google_id: &str,
) -> Result<(), DriveMutationError> {
  client
    .delete(format!("{GOOGLE_DRIVE_FILES_URL}/{google_id}"))
    .header(AUTHORIZATION, bearer(access_token))
    .send()
    .and_then(|response| response.error_for_status())
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))?;
  Ok(())
}

fn workspace_export_for_mime_type(mime_type: &str) -> Option<(&'static str, &'static str)> {
  match mime_type {
    "application/vnd.google-apps.document" => Some((
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
    )),
    "application/vnd.google-apps.spreadsheet" => Some((
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xlsx",
    )),
    "application/vnd.google-apps.presentation" => Some((
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "pptx",
    )),
    "application/vnd.google-apps.drawing" => Some(("application/pdf", "pdf")),
    _ => None,
  }
}

fn suggested_download_name(
  filename: &str,
  mime_type: &str,
) -> Result<String, DriveMutationError> {
  let trimmed = filename.trim();
  if trimmed.is_empty() {
    return Err(DriveMutationError::InvalidItemName);
  }

  match workspace_export_for_mime_type(mime_type) {
    Some((_, extension)) if !trimmed.to_lowercase().ends_with(&format!(".{extension}")) => {
      Ok(format!("{trimmed}.{extension}"))
    }
    Some(_) => Ok(trimmed.to_string()),
    None => Ok(trimmed.to_string()),
  }
}

fn append_extension_if_missing(
  filename: &str,
  extension: &str,
) -> Result<String, DriveMutationError> {
  let trimmed = validate_item_name(filename, false)?;
  if trimmed.to_lowercase().ends_with(&format!(".{extension}")) {
    Ok(trimmed)
  } else {
    Ok(format!("{trimmed}.{extension}"))
  }
}

fn write_response_to_path(
  response: &mut Response,
  destination: &Path,
) -> Result<(), DriveMutationError> {
  if let Some(parent) = destination.parent() {
    fs::create_dir_all(parent).map_err(|err| {
      DriveMutationError::Filesystem(format!(
        "failed to create {}: {err}",
        parent.display()
      ))
    })?;
  }

  let mut output = File::create(destination).map_err(|err| {
    DriveMutationError::Filesystem(format!(
      "failed to create {}: {err}",
      destination.display()
    ))
  })?;
  io::copy(response, &mut output).map_err(|err| {
    DriveMutationError::Filesystem(format!(
      "failed to write {}: {err}",
      destination.display()
    ))
  })?;
  Ok(())
}

fn dialog_path_to_path_buf(
  file_path: tauri_plugin_dialog::FilePath,
) -> Result<PathBuf, DriveMutationError> {
  file_path
    .into_path()
    .map_err(|err| DriveMutationError::Filesystem(err.to_string()))
}

fn bearer(access_token: &str) -> String {
  format!("Bearer {access_token}")
}

#[cfg(test)]
mod tests {
  use super::{
    join_virtual_path, normalize_virtual_path, select_upload_account, split_virtual_path,
    suggested_download_name, workspace_export_for_mime_type, MutableAccountContext,
  };

  fn account(account_id: &str, free_bytes: u64) -> MutableAccountContext {
    MutableAccountContext {
      account_id: account_id.into(),
      free_bytes,
      access_token: String::new(),
      files: Vec::new(),
    }
  }

  #[test]
  fn upload_account_selection_prefers_highest_free_space_then_account_id() {
    let accounts = vec![account("drive-b", 10), account("drive-a", 10), account("drive-c", 8)];
    let chosen_index = select_upload_account(&accounts, 4).expect("account should be chosen");

    assert_eq!(accounts[chosen_index].account_id, "drive-a");
  }

  #[test]
  fn virtual_paths_normalize_and_split_consistently() {
    assert_eq!(normalize_virtual_path("Projects/2026/").unwrap(), "/Projects/2026");
    assert_eq!(
      split_virtual_path("/Projects/2026").unwrap(),
      vec!["Projects".to_string(), "2026".to_string()]
    );
    assert_eq!(join_virtual_path("/Projects", "Roadmap.pdf"), "/Projects/Roadmap.pdf");
  }

  #[test]
  fn workspace_exports_receive_expected_extensions() {
    assert_eq!(
      workspace_export_for_mime_type("application/vnd.google-apps.document"),
      Some((
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
      ))
    );
    assert_eq!(
      suggested_download_name("Quarterly Plan", "application/vnd.google-apps.spreadsheet")
        .unwrap(),
      "Quarterly Plan.xlsx"
    );
  }
}
