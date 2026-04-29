use crate::app_session;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const SERVICE_NAME: &str = "omnidrive.google.oauth.tokens";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTokenRecord {
  pub account_id: String,
  #[serde(default)]
  pub client_id: String,
  pub access_token: String,
  pub refresh_token: String,
  pub token_type: String,
  pub scope: Option<String>,
  pub expires_at_unix: Option<i64>,
}

pub fn save_tokens_for_account(
  app: &AppHandle,
  account_id: &str,
  record: &StoredTokenRecord,
) -> Result<(), keyring::Error> {
  // We key each entry by account_id so multiple Google accounts can coexist
  // without secrets leaking into app-managed storage.
  let app_user_id = app_session::current_user_id(app)
    .map_err(|err| keyring::Error::PlatformFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, err))))?;
  let entry = Entry::new(SERVICE_NAME, &app_session::token_namespace_key(&app_user_id, account_id))?;
  let serialized = serde_json::to_string(record)
    .map_err(|err| keyring::Error::PlatformFailure(Box::new(err)))?;
  entry.set_password(&serialized)
}

pub fn load_tokens_for_account(app: &AppHandle, account_id: &str) -> Result<StoredTokenRecord, keyring::Error> {
  let app_user_id = app_session::current_user_id(app)
    .map_err(|err| keyring::Error::PlatformFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, err))))?;
  let entry = Entry::new(SERVICE_NAME, &app_session::token_namespace_key(&app_user_id, account_id))?;
  let serialized = entry.get_password()?;
  let record = serde_json::from_str(&serialized)
    .map_err(|err| keyring::Error::PlatformFailure(Box::new(err)))?;
  Ok(record)
}

pub fn delete_tokens_for_account(app: &AppHandle, account_id: &str) -> Result<(), keyring::Error> {
  let app_user_id = app_session::current_user_id(app)
    .map_err(|err| keyring::Error::PlatformFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, err))))?;
  let entry = Entry::new(SERVICE_NAME, &app_session::token_namespace_key(&app_user_id, account_id))?;
  entry.delete_credential()
}
