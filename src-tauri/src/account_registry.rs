use crate::app_session;
use serde::{Deserialize, Serialize};
use std::{
  fs,
  path::{Path, PathBuf},
  time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
  Drive,
  Photos,
}

impl Default for SourceKind {
  fn default() -> Self {
    Self::Drive
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRegistryEntry {
  pub account_id: String,
  pub label: String,
  pub display_name: String,
  pub email: String,
  #[serde(default)]
  pub source_kind: SourceKind,
  #[serde(default)]
  pub remote_collection_id: Option<String>,
  pub last_synced_at: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountRegistryFile {
  accounts: Vec<AccountRegistryEntry>,
}

pub fn list_accounts(app: &AppHandle) -> Result<Vec<AccountRegistryEntry>, String> {
  Ok(load_registry(app)?.accounts)
}

pub fn find_account(app: &AppHandle, account_id: &str) -> Result<AccountRegistryEntry, String> {
  load_registry(app)?
    .accounts
    .into_iter()
    .find(|account| account.account_id == account_id)
    .ok_or_else(|| format!("account {account_id} is not registered"))
}

pub fn upsert_account(
  app: &AppHandle,
  account_id: &str,
  display_name: &str,
  email: &str,
  source_kind: SourceKind,
  remote_collection_id: Option<String>,
  last_synced_at: Option<String>,
) -> Result<AccountRegistryEntry, String> {
  let mut registry = load_registry(app)?;

  if let Some(existing) = registry
    .accounts
    .iter_mut()
    .find(|account| account.account_id == account_id)
  {
    existing.display_name = display_name.to_string();
    existing.email = email.to_string();
    existing.source_kind = source_kind;
    existing.remote_collection_id = remote_collection_id;
    existing.last_synced_at = last_synced_at;
    let updated = existing.clone();
    save_registry(app, &registry)?;
    return Ok(updated);
  }

  let new_entry = AccountRegistryEntry {
    account_id: account_id.to_string(),
    label: next_label(registry.accounts.len()),
    display_name: display_name.to_string(),
    email: email.to_string(),
    source_kind,
    remote_collection_id,
    last_synced_at,
  };
  registry.accounts.push(new_entry.clone());
  save_registry(app, &registry)?;
  Ok(new_entry)
}

pub fn remove_account(app: &AppHandle, account_id: &str) -> Result<(), String> {
  let mut registry = load_registry(app)?;
  registry.accounts.retain(|account| account.account_id != account_id);
  save_registry(app, &registry)
}

fn load_registry(app: &AppHandle) -> Result<AccountRegistryFile, String> {
  let registry_path = registry_path(app)?;
  if !registry_path.exists() {
    return Ok(AccountRegistryFile::default());
  }

  let contents = fs::read_to_string(&registry_path)
    .map_err(|err| format!("failed to read account registry: {err}"))?;
  let (registry, repaired) = parse_registry_contents(&contents)?;

  if repaired {
    backup_corrupt_registry(&registry_path, &contents)?;
    save_registry(app, &registry)?;
  }

  Ok(registry)
}

fn save_registry(app: &AppHandle, registry: &AccountRegistryFile) -> Result<(), String> {
  let registry_path = registry_path(app)?;
  if let Some(parent) = registry_path.parent() {
    fs::create_dir_all(parent)
      .map_err(|err| format!("failed to create account registry directory: {err}"))?;
  }

  let payload = serde_json::to_string_pretty(registry)
    .map_err(|err| format!("failed to serialize account registry: {err}"))?;
  atomic_write(&registry_path, &payload)
    .map_err(|err| format!("failed to write account registry: {err}"))
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
  app_session::namespaced_config_dir(app).map(|dir| dir.join("accounts.json"))
}

fn next_label(index: usize) -> String {
  let mut current = index;
  let mut label = String::new();

  loop {
    let remainder = current % 26;
    label.insert(0, (b'A' + remainder as u8) as char);

    if current < 26 {
      break;
    }

    current = current / 26 - 1;
  }

  label
}

fn parse_registry_contents(contents: &str) -> Result<(AccountRegistryFile, bool), String> {
  match serde_json::from_str::<AccountRegistryFile>(contents) {
    Ok(registry) => Ok((registry, false)),
    Err(err) => {
      let original_error = err.to_string();
      if !original_error.contains("trailing characters") {
        return Err(format!("failed to parse account registry: {original_error}"));
      }

      let mut candidate = contents.trim_end().to_string();
      loop {
        let Some(last_char) = candidate.chars().last() else {
          break;
        };

        if last_char != '}' && last_char != ']' {
          break;
        }

        candidate.pop();
        candidate = candidate.trim_end().to_string();

        if let Ok(registry) = serde_json::from_str::<AccountRegistryFile>(&candidate) {
          return Ok((registry, true));
        }
      }

      Err(format!("failed to parse account registry: {original_error}"))
    }
  }
}

fn backup_corrupt_registry(registry_path: &Path, contents: &str) -> Result<(), String> {
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs())
    .unwrap_or_default();
  let backup_path = registry_path.with_file_name(format!("accounts.corrupt-{timestamp}.json"));

  fs::write(backup_path, contents)
    .map_err(|err| format!("failed to back up corrupt account registry: {err}"))
}

fn atomic_write(path: &Path, payload: &str) -> Result<(), std::io::Error> {
  let temp_path = path.with_extension("json.tmp");
  fs::write(&temp_path, payload)?;

  if path.exists() {
    fs::remove_file(path)?;
  }

  fs::rename(temp_path, path)
}

#[cfg(test)]
mod tests {
  use super::{next_label, parse_registry_contents};

  #[test]
  fn next_label_counts_like_spreadsheet_columns() {
    assert_eq!(next_label(0), "A");
    assert_eq!(next_label(25), "Z");
    assert_eq!(next_label(26), "AA");
    assert_eq!(next_label(27), "AB");
  }

  #[test]
  fn parse_registry_contents_recovers_extra_closing_braces() {
    let contents = r#"{
  "accounts": [
    {
      "accountId": "drive-a@example.com",
      "label": "A",
      "displayName": "Drive A",
      "email": "drive-a@example.com",
      "lastSyncedAt": null
    }
  ]
}}"#;

    let (registry, repaired) = parse_registry_contents(contents).expect("registry should recover");

    assert!(repaired);
    assert_eq!(registry.accounts.len(), 1);
    assert_eq!(registry.accounts[0].account_id, "drive-a@example.com");
  }

  #[test]
  fn parse_registry_contents_rejects_real_trailing_garbage() {
    let contents = r#"{
  "accounts": []
}
not-json"#;

    let error = parse_registry_contents(contents).expect_err("registry should fail");

    assert!(error.contains("failed to parse account registry"));
    assert!(error.contains("trailing characters"));
  }
}
