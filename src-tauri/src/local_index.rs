use crate::{
  app_session,
  account_registry,
  drive_api::{self, AccountStatePayload, DriveSnapshotPayload, GoogleDriveFileRecordPayload},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
  fs,
  path::PathBuf,
  time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsPayload {
  pub theme_mode: String,
  #[serde(default = "default_theme_variant")]
  pub theme_variant: String,
  pub default_view_mode: String,
  #[serde(default = "default_grid_card_size")]
  pub grid_card_size: u64,
  pub sync_interval_minutes: u64,
  pub preview_cache_limit_mb: u64,
  pub notifications_enabled: bool,
  pub safe_transfer_enabled: bool,
  pub download_directory: Option<String>,
  pub has_completed_first_run: bool,
}

impl Default for AppSettingsPayload {
  fn default() -> Self {
    Self {
      theme_mode: "dark".into(),
      theme_variant: default_theme_variant(),
      default_view_mode: "list".into(),
      grid_card_size: default_grid_card_size(),
      sync_interval_minutes: 15,
      preview_cache_limit_mb: 512,
      notifications_enabled: true,
      safe_transfer_enabled: true,
      download_directory: None,
      has_completed_first_run: false,
    }
  }
}

fn default_theme_variant() -> String {
  "classic".into()
}

fn default_grid_card_size() -> u64 {
  220
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatePayload {
  pub account_id: String,
  pub start_page_token: Option<String>,
  pub last_synced_at: Option<String>,
  pub last_full_scan_at: Option<String>,
  pub last_error: Option<String>,
  pub sync_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveJobPayload {
  pub id: String,
  pub kind: String,
  pub status: String,
  pub label: String,
  pub progress: f64,
  pub source_account_id: Option<String>,
  pub target_account_id: Option<String>,
  pub created_at: String,
  pub updated_at: String,
  pub error_message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueDriveJobRequest {
  pub kind: String,
  pub label: String,
  pub source_account_id: Option<String>,
  pub target_account_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDriveJobRequest {
  pub status: String,
  pub progress: f64,
  pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInsightPayload {
  pub id: String,
  pub kind: String,
  pub title: String,
  pub description: String,
  pub severity: String,
  pub account_id: Option<String>,
  pub node_ids: Vec<String>,
  pub reclaimable_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroupPayload {
  pub id: String,
  pub reason: String,
  pub node_ids: Vec<String>,
  pub reclaimable_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalIndexPayload {
  pub accounts: Vec<AccountStatePayload>,
  pub nodes: Vec<serde_json::Value>,
  pub sync_states: Vec<SyncStatePayload>,
  pub jobs: Vec<DriveJobPayload>,
  pub settings: AppSettingsPayload,
  pub insights: Vec<StorageInsightPayload>,
  pub duplicate_groups: Vec<DuplicateGroupPayload>,
  pub last_indexed_at: Option<String>,
}

pub fn get_local_index(app: AppHandle) -> Result<LocalIndexPayload, String> {
  let store = LocalIndexStore::open(index_path(&app)?)?;
  store.load_payload()
}

pub fn save_drive_snapshots(app: &AppHandle, snapshots: &[DriveSnapshotPayload]) -> Result<(), String> {
  let store = LocalIndexStore::open(index_path(app)?)?;
  store.save_drive_snapshots(snapshots)
}

pub fn sync_account_changes(app: AppHandle, account_id: String) -> Result<LocalIndexPayload, String> {
  let store = LocalIndexStore::open(index_path(&app)?)?;
  match sync_drive_account_into_store(&app, &store, &account_id) {
    Ok(()) => {}
    Err(err) => {
      let _ = store.upsert_sync_error(&account_id, &err);
      return Err(err);
    }
  }
  store.load_payload()
}

pub fn list_drive_jobs(app: AppHandle) -> Result<Vec<DriveJobPayload>, String> {
  LocalIndexStore::open(index_path(&app)?)?.list_jobs()
}

pub fn enqueue_drive_job(
  app: AppHandle,
  job: EnqueueDriveJobRequest,
) -> Result<DriveJobPayload, String> {
  LocalIndexStore::open(index_path(&app)?)?.enqueue_job(job)
}

pub fn cancel_drive_job(app: AppHandle, job_id: String) -> Result<(), String> {
  LocalIndexStore::open(index_path(&app)?)?.cancel_job(&job_id)
}

pub fn update_drive_job(
  app: AppHandle,
  job_id: String,
  update: UpdateDriveJobRequest,
) -> Result<(), String> {
  LocalIndexStore::open(index_path(&app)?)?.update_job(&job_id, update)
}

pub fn get_storage_insights(app: AppHandle) -> Result<Vec<StorageInsightPayload>, String> {
  Ok(LocalIndexStore::open(index_path(&app)?)?.compute_insights().0)
}

pub fn update_app_settings(
  app: AppHandle,
  settings: AppSettingsPayload,
) -> Result<(), String> {
  LocalIndexStore::open(index_path(&app)?)?.save_settings(&settings)
}

pub fn clear_preview_cache(app: AppHandle) -> Result<(), String> {
  let preview_dir = app_session::namespaced_cache_dir(&app)?.join("previews");

  if preview_dir.exists() {
    fs::remove_dir_all(&preview_dir)
      .map_err(|err| format!("failed to clear preview cache: {err}"))?;
  }

  fs::create_dir_all(&preview_dir)
    .map_err(|err| format!("failed to recreate preview cache: {err}"))
}

pub struct LocalIndexStore {
  connection: Connection,
}

impl LocalIndexStore {
  pub fn open(path: PathBuf) -> Result<Self, String> {
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create local index directory: {err}"))?;
    }

    let connection = Connection::open(path)
      .map_err(|err| format!("failed to open local SQLite index: {err}"))?;
    let store = Self { connection };
    store.initialize()?;
    Ok(store)
  }

  fn initialize(&self) -> Result<(), String> {
    self.connection
      .execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS drive_snapshots (
          account_id TEXT PRIMARY KEY,
          account_json TEXT NOT NULL,
          files_json TEXT NOT NULL,
          indexed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_states (
          account_id TEXT PRIMARY KEY,
          start_page_token TEXT,
          last_synced_at TEXT,
          last_full_scan_at TEXT,
          last_error TEXT,
          sync_version INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS drive_jobs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          label TEXT NOT NULL,
          progress REAL NOT NULL,
          source_account_id TEXT,
          target_account_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          error_message TEXT
        );
        "#,
      )
      .map_err(|err| format!("failed to initialize local SQLite index: {err}"))?;

    if self.load_settings()?.is_none() {
      self.save_settings(&AppSettingsPayload::default())?;
    }

    Ok(())
  }

  pub fn save_drive_snapshots(&self, snapshots: &[DriveSnapshotPayload]) -> Result<(), String> {
    let indexed_at = now_rfc3339();
    for snapshot in snapshots {
      let account_json = serde_json::to_string(&snapshot.account)
        .map_err(|err| format!("failed to serialize indexed account: {err}"))?;
      let files_json = serde_json::to_string(&snapshot.files)
        .map_err(|err| format!("failed to serialize indexed files: {err}"))?;

      self.connection
        .execute(
          r#"
          INSERT INTO drive_snapshots (account_id, account_json, files_json, indexed_at)
          VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(account_id) DO UPDATE SET
            account_json = excluded.account_json,
            files_json = excluded.files_json,
            indexed_at = excluded.indexed_at
          "#,
          params![&snapshot.account.account_id, account_json, files_json, indexed_at],
        )
        .map_err(|err| format!("failed to write local snapshot index: {err}"))?;
    }
    Ok(())
  }

  pub fn load_payload(&self) -> Result<LocalIndexPayload, String> {
    let snapshots = self.load_snapshots()?;
    let (insights, duplicate_groups) = self.compute_insights();
    Ok(LocalIndexPayload {
      accounts: snapshots.iter().map(|snapshot| snapshot.account.clone()).collect(),
      nodes: Vec::new(),
      sync_states: self.list_sync_states()?,
      jobs: self.list_jobs()?,
      settings: self.load_settings()?.unwrap_or_default(),
      insights,
      duplicate_groups,
      last_indexed_at: self.last_indexed_at()?,
    })
  }

  pub fn save_settings(&self, settings: &AppSettingsPayload) -> Result<(), String> {
    validate_settings(settings)?;
    let payload_json = serde_json::to_string(settings)
      .map_err(|err| format!("failed to serialize app settings: {err}"))?;
    self.connection
      .execute(
        r#"
        INSERT INTO app_settings (id, payload_json, updated_at)
        VALUES (1, ?1, ?2)
        ON CONFLICT(id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
        "#,
        params![payload_json, now_rfc3339()],
      )
      .map_err(|err| format!("failed to save app settings: {err}"))?;
    Ok(())
  }

  fn load_settings(&self) -> Result<Option<AppSettingsPayload>, String> {
    self.connection
      .query_row(
        "SELECT payload_json FROM app_settings WHERE id = 1",
        [],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .map_err(|err| format!("failed to load app settings: {err}"))?
      .map(|payload| {
        serde_json::from_str::<AppSettingsPayload>(&payload)
          .map_err(|err| format!("failed to parse app settings: {err}"))
      })
      .transpose()
  }

  pub fn list_jobs(&self) -> Result<Vec<DriveJobPayload>, String> {
    let mut statement = self
      .connection
      .prepare(
        r#"
        SELECT id, kind, status, label, progress, source_account_id, target_account_id,
               created_at, updated_at, error_message
        FROM drive_jobs
        ORDER BY updated_at DESC
        "#,
      )
      .map_err(|err| format!("failed to prepare job query: {err}"))?;

    let rows = statement
      .query_map([], |row| {
        Ok(DriveJobPayload {
          id: row.get(0)?,
          kind: row.get(1)?,
          status: row.get(2)?,
          label: row.get(3)?,
          progress: row.get(4)?,
          source_account_id: row.get(5)?,
          target_account_id: row.get(6)?,
          created_at: row.get(7)?,
          updated_at: row.get(8)?,
          error_message: row.get(9)?,
        })
      })
      .map_err(|err| format!("failed to query jobs: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
      .map_err(|err| format!("failed to read jobs: {err}"))
  }

  pub fn enqueue_job(&self, job: EnqueueDriveJobRequest) -> Result<DriveJobPayload, String> {
    validate_job_kind(&job.kind)?;
    let now = now_rfc3339();
    let payload = DriveJobPayload {
      id: format!("job-{}", now_unix_millis()),
      kind: job.kind,
      status: "queued".into(),
      label: if job.label.trim().is_empty() {
        "Untitled job".into()
      } else {
        job.label
      },
      progress: 0.0,
      source_account_id: job.source_account_id,
      target_account_id: job.target_account_id,
      created_at: now.clone(),
      updated_at: now,
      error_message: None,
    };

    self.connection
      .execute(
        r#"
        INSERT INTO drive_jobs
          (id, kind, status, label, progress, source_account_id, target_account_id, created_at, updated_at, error_message)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
        params![
          &payload.id,
          &payload.kind,
          &payload.status,
          &payload.label,
          payload.progress,
          &payload.source_account_id,
          &payload.target_account_id,
          &payload.created_at,
          &payload.updated_at,
          &payload.error_message
        ],
      )
      .map_err(|err| format!("failed to enqueue drive job: {err}"))?;

    Ok(payload)
  }

  pub fn cancel_job(&self, job_id: &str) -> Result<(), String> {
    let updated = self
      .connection
      .execute(
        "UPDATE drive_jobs SET status = 'cancelled', updated_at = ?1 WHERE id = ?2 AND status NOT IN ('completed', 'failed')",
        params![now_rfc3339(), job_id],
      )
      .map_err(|err| format!("failed to cancel drive job: {err}"))?;

    if updated == 0 {
      return Err(format!("drive job {job_id} was not found or cannot be cancelled"));
    }

    Ok(())
  }

  pub fn update_job(&self, job_id: &str, update: UpdateDriveJobRequest) -> Result<(), String> {
    validate_job_status(&update.status)?;
    let progress = if update.progress.is_finite() {
      update.progress.clamp(0.0, 100.0)
    } else {
      0.0
    };

    let updated = self
      .connection
      .execute(
        r#"
        UPDATE drive_jobs
        SET status = ?1, progress = ?2, error_message = ?3, updated_at = ?4
        WHERE id = ?5
        "#,
        params![
          &update.status,
          progress,
          &update.error_message,
          now_rfc3339(),
          job_id
        ],
      )
      .map_err(|err| format!("failed to update drive job: {err}"))?;

    if updated == 0 {
      return Err(format!("drive job {job_id} was not found"));
    }

    Ok(())
  }

  fn load_snapshots(&self) -> Result<Vec<DriveSnapshotPayload>, String> {
    let mut statement = self
      .connection
      .prepare("SELECT account_json, files_json FROM drive_snapshots ORDER BY account_id")
      .map_err(|err| format!("failed to prepare snapshot query: {err}"))?;
    let rows = statement
      .query_map([], |row| {
        let account_json: String = row.get(0)?;
        let files_json: String = row.get(1)?;
        Ok((account_json, files_json))
      })
      .map_err(|err| format!("failed to query local snapshots: {err}"))?;

    rows
      .map(|row| {
        let (account_json, files_json) =
          row.map_err(|err| format!("failed to read local snapshot row: {err}"))?;
        let account = serde_json::from_str::<AccountStatePayload>(&account_json)
          .map_err(|err| format!("failed to parse indexed account: {err}"))?;
        let files = serde_json::from_str::<Vec<GoogleDriveFileRecordPayload>>(&files_json)
          .map_err(|err| format!("failed to parse indexed files: {err}"))?;
        Ok(DriveSnapshotPayload { account, files })
      })
      .collect()
  }

  fn list_sync_states(&self) -> Result<Vec<SyncStatePayload>, String> {
    let mut statement = self
      .connection
      .prepare(
        r#"
        SELECT account_id, start_page_token, last_synced_at, last_full_scan_at, last_error, sync_version
        FROM sync_states
        ORDER BY account_id
        "#,
      )
      .map_err(|err| format!("failed to prepare sync state query: {err}"))?;

    let rows = statement
      .query_map([], |row| {
        Ok(SyncStatePayload {
          account_id: row.get(0)?,
          start_page_token: row.get(1)?,
          last_synced_at: row.get(2)?,
          last_full_scan_at: row.get(3)?,
          last_error: row.get(4)?,
          sync_version: row.get::<_, i64>(5)?.max(0) as u64,
        })
      })
      .map_err(|err| format!("failed to query sync states: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
      .map_err(|err| format!("failed to read sync states: {err}"))
  }

  fn last_indexed_at(&self) -> Result<Option<String>, String> {
    self.connection
      .query_row("SELECT MAX(indexed_at) FROM drive_snapshots", [], |row| row.get(0))
      .map_err(|err| format!("failed to read last indexed timestamp: {err}"))
  }

  fn compute_insights(&self) -> (Vec<StorageInsightPayload>, Vec<DuplicateGroupPayload>) {
    let snapshots = self.load_snapshots().unwrap_or_default();
    let mut insights = Vec::new();
    let mut flat_files = Vec::new();

    for snapshot in &snapshots {
      if snapshot.account.source_kind == "photos" {
        insights.push(StorageInsightPayload {
          id: format!("photos-limit:{}", snapshot.account.account_id),
          kind: "photosLimit".into(),
          title: format!("Photos {} uses Picker batches", snapshot.account.label),
          description: "Google Photos access is limited to user-picked batches of up to 2000 items.".into(),
          severity: "info".into(),
          account_id: Some(snapshot.account.account_id.clone()),
          node_ids: Vec::new(),
          reclaimable_bytes: 0,
        });
      }

      if snapshot.account.is_connected && snapshot.account.total_bytes > 0 {
        let free_percent = snapshot.account.free_bytes as f64 / snapshot.account.total_bytes as f64;
        if free_percent <= 0.1 {
          insights.push(StorageInsightPayload {
            id: format!("low-space:{}", snapshot.account.account_id),
            kind: "lowSpace".into(),
            title: format!("Drive {} is almost full", snapshot.account.label),
            description: format!("{:.1}% free on {}.", free_percent * 100.0, snapshot.account.display_name),
            severity: if free_percent <= 0.075 { "critical" } else { "warning" }.into(),
            account_id: Some(snapshot.account.account_id.clone()),
            node_ids: Vec::new(),
            reclaimable_bytes: 0,
          });
        }
      }

      for file in &snapshot.files {
        if file.trashed.unwrap_or(false) || file.mime_type == drive_api::GOOGLE_FOLDER_MIME_TYPE {
          continue;
        }
        let size = parse_u64(file.size.as_deref());
        if size > 0 {
          flat_files.push((snapshot.account.account_id.clone(), file.clone(), size));
        }
      }
    }

    let duplicate_groups = duplicate_groups_from_files(&flat_files);
    if !duplicate_groups.is_empty() {
      insights.push(StorageInsightPayload {
        id: "duplicates".into(),
        kind: "duplicates".into(),
        title: "Possible duplicates".into(),
        description: format!("{} duplicate groups can be reviewed safely.", duplicate_groups.len()),
        severity: "warning".into(),
        account_id: None,
        node_ids: duplicate_groups
          .iter()
          .flat_map(|group| group.node_ids.clone())
          .collect(),
        reclaimable_bytes: duplicate_groups.iter().map(|group| group.reclaimable_bytes).sum(),
      });
    }

    (insights, duplicate_groups)
  }

  fn upsert_sync_success(
    &self,
    account_id: &str,
    start_page_token: Option<String>,
    full_scan: bool,
  ) -> Result<(), String> {
    let now = now_rfc3339();
    self.connection
      .execute(
        r#"
        INSERT INTO sync_states
          (account_id, start_page_token, last_synced_at, last_full_scan_at, last_error, sync_version)
        VALUES (?1, ?2, ?3, ?4, NULL, 1)
        ON CONFLICT(account_id) DO UPDATE SET
          start_page_token = COALESCE(excluded.start_page_token, sync_states.start_page_token),
          last_synced_at = excluded.last_synced_at,
          last_full_scan_at = CASE WHEN ?5 THEN excluded.last_full_scan_at ELSE sync_states.last_full_scan_at END,
          last_error = NULL,
          sync_version = sync_states.sync_version + 1
        "#,
        params![
          account_id,
          start_page_token,
          now,
          if full_scan { Some(now.clone()) } else { None },
          full_scan
        ],
      )
      .map_err(|err| format!("failed to update sync state: {err}"))?;
    Ok(())
  }

  fn upsert_sync_error(&self, account_id: &str, error: &str) -> Result<(), String> {
    self.connection
      .execute(
        r#"
        INSERT INTO sync_states
          (account_id, start_page_token, last_synced_at, last_full_scan_at, last_error, sync_version)
        VALUES (?1, NULL, NULL, NULL, ?2, 0)
        ON CONFLICT(account_id) DO UPDATE SET
          last_error = excluded.last_error
        "#,
        params![account_id, error],
      )
      .map_err(|err| format!("failed to record sync error: {err}"))?;
    Ok(())
  }

  fn sync_state_for_account(&self, account_id: &str) -> Result<Option<SyncStatePayload>, String> {
    self.connection
      .query_row(
        r#"
        SELECT account_id, start_page_token, last_synced_at, last_full_scan_at, last_error, sync_version
        FROM sync_states
        WHERE account_id = ?1
        "#,
        params![account_id],
        |row| {
          Ok(SyncStatePayload {
            account_id: row.get(0)?,
            start_page_token: row.get(1)?,
            last_synced_at: row.get(2)?,
            last_full_scan_at: row.get(3)?,
            last_error: row.get(4)?,
            sync_version: row.get::<_, i64>(5)?.max(0) as u64,
          })
        },
      )
      .optional()
      .map_err(|err| format!("failed to load sync state: {err}"))
  }
}

fn sync_drive_account_into_store(
  app: &AppHandle,
  store: &LocalIndexStore,
  account_id: &str,
) -> Result<(), String> {
  let entry = account_registry::find_account(app, account_id)?;
  if entry.source_kind == account_registry::SourceKind::Photos {
    return Err("Google Photos sync is limited to Picker sessions and cannot use Drive changes".into());
  }

  let access_token = drive_api::load_access_token_for_account(app, account_id)
    .map_err(|err| err.to_string())?;
  let existing_sync_state = store.sync_state_for_account(account_id)?;
  let files = if let Some(page_token) = existing_sync_state
    .as_ref()
    .and_then(|state| state.start_page_token.clone())
  {
    apply_drive_changes(&access_token, account_id, &page_token, store)?
  } else {
    let files = drive_api::fetch_all_files(account_id, &access_token)
      .map_err(|err| err.to_string())?;
    let start_page_token = fetch_start_page_token(&access_token)?;
    let account = load_indexed_account_or_placeholder(store, account_id, &entry)?;
    store.save_drive_snapshots(&[DriveSnapshotPayload {
      account,
      files: files.clone(),
    }])?;
    store.upsert_sync_success(account_id, Some(start_page_token), true)?;
    files
  };

  if files.is_empty() {
    store.upsert_sync_success(account_id, None, false)?;
  }

  Ok(())
}

fn apply_drive_changes(
  access_token: &str,
  account_id: &str,
  page_token: &str,
  store: &LocalIndexStore,
) -> Result<Vec<GoogleDriveFileRecordPayload>, String> {
  let mut snapshot = store
    .load_snapshots()?
    .into_iter()
    .find(|snapshot| snapshot.account.account_id == account_id)
    .ok_or_else(|| format!("account {account_id} is not indexed yet"))?;
  let mut files_by_id = snapshot
    .files
    .into_iter()
    .map(|file| (file.id.clone(), file))
    .collect::<std::collections::HashMap<_, _>>();
  let mut next_page_token = Some(page_token.to_string());
  let mut new_start_page_token = None;

  while let Some(token) = next_page_token {
    let response = fetch_changes_page(access_token, &token)?;
    for change in response.changes {
      if change.removed.unwrap_or(false) {
        files_by_id.remove(&change.file_id);
        continue;
      }
      if let Some(file) = change.file {
        files_by_id.insert(file.id.clone(), file);
      }
    }
    next_page_token = response.next_page_token;
    new_start_page_token = response.new_start_page_token.or(new_start_page_token);
  }

  snapshot.files = files_by_id.into_values().collect();
  snapshot.files.sort_by(|left, right| left.id.cmp(&right.id));
  store.save_drive_snapshots(&[snapshot.clone()])?;
  store.upsert_sync_success(account_id, new_start_page_token, false)?;
  Ok(snapshot.files)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesPageResponse {
  changes: Vec<DriveChangePayload>,
  next_page_token: Option<String>,
  new_start_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveChangePayload {
  file_id: String,
  removed: Option<bool>,
  file: Option<GoogleDriveFileRecordPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartPageTokenResponse {
  start_page_token: String,
}

fn fetch_changes_page(access_token: &str, page_token: &str) -> Result<ChangesPageResponse, String> {
  drive_api::build_client()
    .map_err(|err| err.to_string())?
    .get("https://www.googleapis.com/drive/v3/changes")
    .bearer_auth(access_token)
    .query(&[
      ("pageToken", page_token),
      ("spaces", "drive"),
      (
        "fields",
        "changes(fileId,removed,file(id,name,mimeType,size,parents,trashed,modifiedTime,createdTime,viewedByMeTime,starred,shared,md5Checksum,thumbnailLink)),nextPageToken,newStartPageToken",
      ),
    ])
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<ChangesPageResponse>())
    .map_err(|err| format!("failed to fetch Drive changes: {err}"))
}

fn fetch_start_page_token(access_token: &str) -> Result<String, String> {
  drive_api::build_client()
    .map_err(|err| err.to_string())?
    .get("https://www.googleapis.com/drive/v3/changes/startPageToken")
    .bearer_auth(access_token)
    .query(&[("fields", "startPageToken")])
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<StartPageTokenResponse>())
    .map(|payload| payload.start_page_token)
    .map_err(|err| format!("failed to fetch Drive start page token: {err}"))
}

fn load_indexed_account_or_placeholder(
  store: &LocalIndexStore,
  account_id: &str,
  entry: &account_registry::AccountRegistryEntry,
) -> Result<AccountStatePayload, String> {
  Ok(store
    .load_snapshots()?
    .into_iter()
    .find(|snapshot| snapshot.account.account_id == account_id)
    .map(|snapshot| snapshot.account)
    .unwrap_or(AccountStatePayload {
      account_id: account_id.to_string(),
      label: entry.label.clone(),
      display_name: entry.display_name.clone(),
      email: Some(entry.email.clone()),
      source_kind: "drive".into(),
      is_connected: true,
      total_bytes: 0,
      used_bytes: 0,
      free_bytes: 0,
      last_synced_at: entry.last_synced_at.clone(),
      load_error: None,
    }))
}

fn duplicate_groups_from_files(
  files: &[(String, GoogleDriveFileRecordPayload, u64)],
) -> Vec<DuplicateGroupPayload> {
  let mut groups: std::collections::HashMap<String, Vec<(String, GoogleDriveFileRecordPayload, u64)>> =
    std::collections::HashMap::new();

  for (account_id, file, size) in files {
    let key = file
      .md5_checksum
      .as_ref()
      .map(|checksum| format!("checksum:{checksum}"))
      .unwrap_or_else(|| format!("name-size:{}:{size}", file.name.to_lowercase()));
    groups
      .entry(key)
      .or_default()
      .push((account_id.clone(), file.clone(), *size));
  }

  let mut duplicate_groups = groups
    .into_iter()
    .filter_map(|(key, mut group)| {
      if group.len() < 2 {
        return None;
      }
      group.sort_by(|left, right| left.1.name.cmp(&right.1.name));
      let reclaimable_bytes = group.iter().skip(1).map(|item| item.2).sum();
      Some(DuplicateGroupPayload {
        id: key.clone(),
        reason: if key.starts_with("checksum:") { "checksum" } else { "nameAndSize" }.into(),
        node_ids: group
          .into_iter()
          .map(|(account_id, file, _)| format!("{account_id}:{}", file.id))
          .collect(),
        reclaimable_bytes,
      })
    })
    .collect::<Vec<_>>();
  duplicate_groups.sort_by(|left, right| right.reclaimable_bytes.cmp(&left.reclaimable_bytes));
  duplicate_groups
}

fn validate_settings(settings: &AppSettingsPayload) -> Result<(), String> {
  if !matches!(settings.theme_mode.as_str(), "dark" | "light") {
    return Err("themeMode must be dark or light".into());
  }
  if !matches!(settings.theme_variant.as_str(), "classic" | "gold" | "mono") {
    return Err("themeVariant must be classic, gold, or mono".into());
  }
  if !matches!(settings.default_view_mode.as_str(), "list" | "grid") {
    return Err("defaultViewMode must be list or grid".into());
  }
  if !(140..=320).contains(&settings.grid_card_size) {
    return Err("gridCardSize must be between 140 and 320".into());
  }
  if !(1..=1440).contains(&settings.sync_interval_minutes) {
    return Err("syncIntervalMinutes must be between 1 and 1440".into());
  }
  if !(64..=8192).contains(&settings.preview_cache_limit_mb) {
    return Err("previewCacheLimitMb must be between 64 and 8192".into());
  }
  Ok(())
}

fn validate_job_kind(kind: &str) -> Result<(), String> {
  match kind {
    "upload" | "download" | "transfer" | "copy" | "delete" | "rename" | "createFolder" => Ok(()),
    _ => Err(format!("unsupported drive job kind: {kind}")),
  }
}

fn validate_job_status(status: &str) -> Result<(), String> {
  match status {
    "queued" | "running" | "paused" | "failed" | "retrying" | "completed" | "cancelled" => Ok(()),
    _ => Err(format!("unsupported drive job status: {status}")),
  }
}

fn parse_u64(value: Option<&str>) -> u64 {
  value.and_then(|raw| raw.parse::<u64>().ok()).unwrap_or_default()
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
  app_session::namespaced_config_dir(app).map(|dir| dir.join("omnidrive-index.sqlite3"))
}

fn now_unix_millis() -> u128 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis())
    .unwrap_or_default()
}

fn now_rfc3339() -> String {
  time::OffsetDateTime::now_utc()
    .format(&time::format_description::well_known::Rfc3339)
    .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
  use super::{AppSettingsPayload, EnqueueDriveJobRequest, LocalIndexStore, UpdateDriveJobRequest};
  use std::{env, fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

  fn temp_index_path(name: &str) -> PathBuf {
    let suffix = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|duration| duration.as_nanos())
      .unwrap_or_default();
    env::temp_dir().join(format!("omnidrive-{name}-{suffix}.sqlite3"))
  }

  #[test]
  fn settings_round_trip_through_sqlite_index() {
    let path = temp_index_path("settings");
    let store = LocalIndexStore::open(path.clone()).expect("store opens");
    let settings = AppSettingsPayload {
      theme_mode: "light".into(),
      theme_variant: "gold".into(),
      default_view_mode: "grid".into(),
      grid_card_size: 260,
      sync_interval_minutes: 30,
      preview_cache_limit_mb: 1024,
      notifications_enabled: false,
      safe_transfer_enabled: true,
      download_directory: Some("C:\\Downloads".into()),
      has_completed_first_run: true,
    };

    store.save_settings(&settings).expect("settings save");
    let payload = store.load_payload().expect("payload loads");

    assert_eq!(payload.settings.theme_mode, "light");
    assert_eq!(payload.settings.theme_variant, "gold");
    assert_eq!(payload.settings.default_view_mode, "grid");
    assert_eq!(payload.settings.grid_card_size, 260);
    assert_eq!(payload.settings.preview_cache_limit_mb, 1024);
    let _ = fs::remove_file(path);
  }

  #[test]
  fn job_queue_persists_and_cancels_jobs() {
    let path = temp_index_path("jobs");
    let store = LocalIndexStore::open(path.clone()).expect("store opens");
    let job = store
      .enqueue_job(EnqueueDriveJobRequest {
        kind: "transfer".into(),
        label: "Move archive".into(),
        source_account_id: Some("drive-a".into()),
        target_account_id: Some("drive-b".into()),
      })
      .expect("job enqueued");

    assert_eq!(job.status, "queued");
    store
      .update_job(
        &job.id,
        UpdateDriveJobRequest {
          status: "running".into(),
          progress: 45.0,
          error_message: None,
        },
      )
      .expect("job updated");
    let running_jobs = store.list_jobs().expect("running jobs load");
    assert_eq!(running_jobs[0].status, "running");
    assert_eq!(running_jobs[0].progress, 45.0);

    store.cancel_job(&job.id).expect("job cancelled");
    let jobs = store.list_jobs().expect("jobs load");

    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].status, "cancelled");
    let _ = fs::remove_file(path);
  }
}
