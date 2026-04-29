#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_session;
mod account_registry;
mod drive_collaboration;
mod drive_api;
mod drive_mutations;
mod drive_preview;
mod local_index;
mod oauth;
mod photos_api;
mod supabase_oauth;
mod token_store;

use oauth::delete_stored_tokens;

fn ensure_app_session(app: &tauri::AppHandle) -> Result<(), String> {
  app_session::ensure_authenticated(app).map(|_| ())
}

#[tauri::command]
fn set_app_session(
  state: tauri::State<'_, app_session::AppSessionState>,
  access_token: String,
  supabase_url: Option<String>,
  supabase_anon_key: Option<String>,
) -> Result<app_session::AppSessionSummary, String> {
  app_session::set_app_session(state, access_token, supabase_url, supabase_anon_key)
}

#[tauri::command]
fn clear_app_session(state: tauri::State<'_, app_session::AppSessionState>) -> Result<(), String> {
  app_session::clear_app_session(state)
}

#[tauri::command]
async fn start_supabase_google_login(
  supabase_url: String,
  supabase_anon_key: String,
) -> Result<supabase_oauth::SupabaseAuthSessionPayload, String> {
  tauri::async_runtime::spawn_blocking(move || {
    supabase_oauth::run_google_login(supabase_url, supabase_anon_key)
  })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn start_google_oauth(
  app: tauri::AppHandle,
  client_id: Option<String>,
) -> Result<oauth::AccountAuthSummary, String> {
  ensure_app_session(&app)?;
  // The login flow waits for a browser callback, so we keep the async runtime free
  // by moving the blocking orchestration onto a dedicated worker thread.
  tauri::async_runtime::spawn_blocking(move || oauth::run_google_oauth_flow(app, client_id))
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn start_google_photos_oauth(
  app: tauri::AppHandle,
  client_id: Option<String>,
) -> Result<oauth::AccountAuthSummary, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || photos_api::run_google_photos_connect(app, client_id))
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn load_drive_snapshots(
  app: tauri::AppHandle,
) -> Result<Vec<drive_api::DriveSnapshotPayload>, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || drive_api::load_drive_snapshots(app))
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_local_index(
  app: tauri::AppHandle,
) -> Result<local_index::LocalIndexPayload, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || local_index::get_local_index(app))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn sync_account_changes(
  app: tauri::AppHandle,
  account_id: String,
) -> Result<local_index::LocalIndexPayload, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || local_index::sync_account_changes(app, account_id))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn list_drive_jobs(
  app: tauri::AppHandle,
) -> Result<Vec<local_index::DriveJobPayload>, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || local_index::list_drive_jobs(app))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn enqueue_drive_job(
  app: tauri::AppHandle,
  job: local_index::EnqueueDriveJobRequest,
) -> Result<local_index::DriveJobPayload, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || local_index::enqueue_drive_job(app, job))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn cancel_drive_job(app: tauri::AppHandle, job_id: String) -> Result<(), String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || local_index::cancel_drive_job(app, job_id))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn update_drive_job(
  app: tauri::AppHandle,
  job_id: String,
  update: local_index::UpdateDriveJobRequest,
) -> Result<(), String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || local_index::update_drive_job(app, job_id, update))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn get_storage_insights(
  app: tauri::AppHandle,
) -> Result<Vec<local_index::StorageInsightPayload>, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || local_index::get_storage_insights(app))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn clear_preview_cache(app: tauri::AppHandle) -> Result<(), String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || local_index::clear_preview_cache(app))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn update_app_settings(
  app: tauri::AppHandle,
  settings: local_index::AppSettingsPayload,
) -> Result<(), String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || local_index::update_app_settings(app, settings))
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn upload_into_virtual_folder(
  app: tauri::AppHandle,
  target_virtual_path: String,
) -> Result<usize, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_mutations::upload_into_virtual_folder(app, target_virtual_path)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())
}

#[tauri::command]
async fn create_virtual_folder(
  app: tauri::AppHandle,
  parent_virtual_path: String,
  folder_name: String,
) -> Result<(), String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_mutations::create_virtual_folder(app, parent_virtual_path, folder_name)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())
}

#[tauri::command]
async fn rename_virtual_folder(
  app: tauri::AppHandle,
  virtual_path: String,
  next_name: String,
) -> Result<usize, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_mutations::rename_virtual_folder(app, virtual_path, next_name)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())
}

#[tauri::command]
async fn delete_virtual_folder(
  app: tauri::AppHandle,
  virtual_path: String,
) -> Result<usize, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_mutations::delete_virtual_folder(app, virtual_path)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())
}

#[tauri::command]
async fn rename_drive_node(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  next_name: String,
) -> Result<(), String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_mutations::rename_drive_node(app, account_id, google_id, next_name)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())
}

#[tauri::command]
async fn delete_drive_node(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
) -> Result<(), String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_mutations::delete_drive_node(app, account_id, google_id)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())
}

#[tauri::command]
async fn download_drive_node(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  filename: String,
  mime_type: String,
) -> Result<Option<String>, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_mutations::download_drive_node(app, account_id, google_id, filename, mime_type)
  })
  .await
  .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn transfer_drive_nodes(
  app: tauri::AppHandle,
  nodes: Vec<drive_mutations::TransferDriveNodeRequest>,
  target_account_id: String,
  target_virtual_path: String,
) -> Result<usize, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_mutations::transfer_drive_nodes(app, nodes, target_account_id, target_virtual_path)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())
}

#[tauri::command]
async fn prepare_drive_node_preview(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  filename: String,
  mime_type: String,
) -> Result<drive_preview::PreviewDescriptorPayload, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_preview::prepare_drive_node_preview(app, account_id, google_id, filename, mime_type)
  })
  .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn lookup_cached_drive_node_preview(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  filename: String,
  mime_type: String,
) -> Result<Option<drive_preview::PreviewDescriptorPayload>, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_preview::lookup_cached_drive_node_preview(app, account_id, google_id, filename, mime_type)
  })
  .await
  .map_err(|err| err.to_string())?
  .map_err(|err| err.to_string())
}

#[tauri::command]
async fn share_drive_node(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  email_address: String,
  role: String,
) -> Result<(), String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_collaboration::share_drive_node(app, account_id, google_id, email_address, role)
  })
  .await
  .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn list_drive_revisions(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
) -> Result<Vec<drive_collaboration::DriveRevisionPayload>, String> {
  ensure_app_session(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    drive_collaboration::list_drive_revisions(app, account_id, google_id)
  })
  .await
  .map_err(|err| err.to_string())?
}

fn main() {
  let _ = dotenvy::dotenv();

  tauri::Builder::default()
    .manage(app_session::AppSessionState::default())
    // The opener plugin gives us a supported way to launch the system browser
    // for the Google consent screen from the Rust backend.
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
      set_app_session,
      clear_app_session,
      start_supabase_google_login,
      start_google_oauth,
      start_google_photos_oauth,
      load_drive_snapshots,
      get_local_index,
      sync_account_changes,
      enqueue_drive_job,
      list_drive_jobs,
      cancel_drive_job,
      update_drive_job,
      get_storage_insights,
      clear_preview_cache,
      update_app_settings,
      upload_into_virtual_folder,
      create_virtual_folder,
      rename_virtual_folder,
      delete_virtual_folder,
      rename_drive_node,
      delete_drive_node,
      download_drive_node,
      transfer_drive_nodes,
      lookup_cached_drive_node_preview,
      prepare_drive_node_preview,
      share_drive_node,
      list_drive_revisions,
      delete_stored_tokens
    ])
    .run(tauri::generate_context!())
    .expect("failed to run OmniDrive");
}
