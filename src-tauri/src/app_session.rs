use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone)]
pub struct AuthenticatedAppUser {
  pub user_id: String,
  pub email: String,
  pub email_verified: bool,
}

#[derive(Debug, Default)]
pub struct AppSessionState {
  current_user: Mutex<Option<AuthenticatedAppUser>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionSummary {
  pub user_id: String,
  pub email: String,
  pub email_verified: bool,
}

#[derive(Debug, Deserialize)]
struct SupabaseUserResponse {
  id: String,
  email: Option<String>,
  email_confirmed_at: Option<String>,
  confirmed_at: Option<String>,
}

#[derive(Debug)]
pub struct SupabaseConfig {
  pub url: String,
  pub anon_key: String,
}

pub fn set_app_session(
  state: State<'_, AppSessionState>,
  access_token: String,
  supabase_url: Option<String>,
  supabase_anon_key: Option<String>,
) -> Result<AppSessionSummary, String> {
  let config = match SupabaseConfig::from_optional_values(supabase_url, supabase_anon_key) {
    Some(config) => config,
    None => read_supabase_config()?,
  };
  let user = verify_supabase_access_token(&access_token, &config)?;
  let mut current_user = state
    .current_user
    .lock()
    .map_err(|_| "failed to acquire app session lock".to_string())?;
  *current_user = Some(user.clone());

  Ok(AppSessionSummary {
    user_id: user.user_id,
    email: user.email,
    email_verified: user.email_verified,
  })
}

pub fn clear_app_session(state: State<'_, AppSessionState>) -> Result<(), String> {
  let mut current_user = state
    .current_user
    .lock()
    .map_err(|_| "failed to acquire app session lock".to_string())?;
  *current_user = None;
  Ok(())
}

pub fn ensure_authenticated(app: &AppHandle) -> Result<AuthenticatedAppUser, String> {
  let state = app.state::<AppSessionState>();
  let current_user = state
    .current_user
    .lock()
    .map_err(|_| "failed to acquire app session lock".to_string())?;

  current_user
    .clone()
    .ok_or_else(|| "Sign in to OmniDrive before using linked Google accounts.".to_string())
}

pub fn current_user_id(app: &AppHandle) -> Result<String, String> {
  Ok(ensure_authenticated(app)?.user_id)
}

pub fn namespaced_config_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  let user_id = current_user_id(app)?;
  app
    .path()
    .app_config_dir()
    .map(|dir| dir.join("users").join(sanitize_user_namespace(&user_id)))
    .map_err(|err| format!("failed to resolve app config dir: {err}"))
}

pub fn namespaced_cache_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  let user_id = current_user_id(app)?;
  app
    .path()
    .app_cache_dir()
    .map(|dir| dir.join("users").join(sanitize_user_namespace(&user_id)))
    .map_err(|err| format!("failed to resolve app cache dir: {err}"))
}

pub fn token_namespace_key(app_user_id: &str, account_id: &str) -> String {
  format!("omnidrive:{app_user_id}:{account_id}")
}

fn verify_supabase_access_token(
  access_token: &str,
  config: &SupabaseConfig,
) -> Result<AuthenticatedAppUser, String> {
  let response = Client::builder()
    .timeout(std::time::Duration::from_secs(30))
    .build()
    .map_err(|err| format!("failed to create Supabase auth client: {err}"))?
    .get(format!("{}/auth/v1/user", config.url.trim_end_matches('/')))
    .header("apikey", &config.anon_key)
    .bearer_auth(access_token)
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<SupabaseUserResponse>())
    .map_err(|err| format!("failed to verify Supabase session: {err}"))?;

  let email_verified = response
    .email_confirmed_at
    .as_ref()
    .or(response.confirmed_at.as_ref())
    .is_some();

  if !email_verified {
    return Err("Verify your OmniDrive email before opening the workspace.".into());
  }

  Ok(AuthenticatedAppUser {
    user_id: response.id,
    email: response.email.unwrap_or_default(),
    email_verified,
  })
}

fn read_supabase_config() -> Result<SupabaseConfig, String> {
  let url = env_value(&["VITE_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"])
    .ok_or_else(|| "missing VITE_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL".to_string())?;
  let anon_key = env_value(&[
    "VITE_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ])
  .ok_or_else(|| {
    "missing VITE_SUPABASE_ANON_KEY / VITE_SUPABASE_PUBLISHABLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY".to_string()
  })?;

  Ok(SupabaseConfig { url, anon_key })
}

impl SupabaseConfig {
  pub fn from_optional_values(
    supabase_url: Option<String>,
    supabase_anon_key: Option<String>,
  ) -> Option<Self> {
    let url = supabase_url
      .map(|value| value.trim().to_string())
      .filter(|value| !value.is_empty())?;
    let anon_key = supabase_anon_key
      .map(|value| value.trim().to_string())
      .filter(|value| !value.is_empty())?;

    Some(Self { url, anon_key })
  }
}

fn env_value(keys: &[&str]) -> Option<String> {
  keys.iter().find_map(|key| {
    std::env::var(key)
      .ok()
      .map(|value| value.trim().to_string())
      .filter(|value| !value.is_empty())
  })
}

fn sanitize_user_namespace(user_id: &str) -> String {
  let sanitized = user_id
    .chars()
    .map(|character| match character {
      'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => character,
      _ => '_',
    })
    .collect::<String>();

  if sanitized.is_empty() {
    "anonymous".into()
  } else {
    sanitized
  }
}

#[cfg(test)]
mod tests {
  use super::{sanitize_user_namespace, token_namespace_key};

  #[test]
  fn user_namespace_is_sanitized_for_filesystem_paths() {
    assert_eq!(sanitize_user_namespace("user-1"), "user-1");
    assert_eq!(sanitize_user_namespace("zia@example.com"), "zia_example_com");
  }

  #[test]
  fn token_namespace_key_includes_app_user_and_account() {
    assert_eq!(
      token_namespace_key("user-1", "drive-a@example.com"),
      "omnidrive:user-1:drive-a@example.com",
    );
  }
}
