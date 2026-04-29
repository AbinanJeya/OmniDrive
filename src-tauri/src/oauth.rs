use crate::{
  app_session,
  account_registry::{remove_account, upsert_account, SourceKind},
  drive_api::fetch_profile_from_access_token,
  token_store::{delete_tokens_for_account, save_tokens_for_account, StoredTokenRecord},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
  io::{BufRead, BufReader, Write},
  net::{Shutdown, TcpListener, TcpStream},
  sync::mpsc,
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_opener::open_url;
use thiserror::Error;
use url::Url;

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPES: &[&str] = &["https://www.googleapis.com/auth/drive"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuthSummary {
  pub account_id: String,
  pub label: String,
  pub display_name: String,
  pub email: Option<String>,
  pub token_expires_at_unix: Option<i64>,
  pub scope: Option<String>,
}

#[derive(Debug, Error)]
pub enum OAuthError {
  #[error("missing Google client id")]
  MissingClientId,
  #[error("failed to open local callback listener: {0}")]
  CallbackListener(String),
  #[error("browser launch failed: {0}")]
  BrowserLaunch(String),
  #[error("callback timed out waiting for the user to complete Google sign-in")]
  CallbackTimeout,
  #[error("callback request was malformed")]
  MalformedCallback,
  #[error("callback state did not match the issued OAuth session")]
  StateMismatch,
  #[error("Google token exchange failed: {0}")]
  TokenExchange(String),
  #[error("Google did not return a refresh token and no previous refresh token exists for this account")]
  MissingRefreshToken,
  #[error("failed to persist account data: {0}")]
  Storage(String),
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
  access_token: String,
  refresh_token: Option<String>,
  expires_in: Option<i64>,
  scope: Option<String>,
  token_type: Option<String>,
}

#[derive(Debug, Clone)]
struct OAuthSession {
  client_id: String,
  client_secret: Option<String>,
  redirect_uri: String,
  state: String,
  code_verifier: String,
  scopes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct OAuthGrant {
  pub token_record: StoredTokenRecord,
  pub profile: crate::drive_api::DriveUserProfile,
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
  code: Option<String>,
  state: Option<String>,
  error: Option<String>,
  error_description: Option<String>,
}

pub fn run_google_oauth_flow(
  app: tauri::AppHandle,
  client_id: Option<String>,
) -> Result<AccountAuthSummary, OAuthError> {
  app_session::ensure_authenticated(&app).map_err(OAuthError::Storage)?;
  let OAuthGrant {
    mut token_record,
    profile,
  } = run_oauth_browser_flow(client_id, DEFAULT_SCOPES)?;

  let registry_entry = upsert_account(
    &app,
    &profile.account_id,
    &profile.display_name,
    profile.email.as_deref().unwrap_or(""),
    SourceKind::Drive,
    None,
    None,
  )
  .map_err(OAuthError::Storage)?;

  token_record.account_id = profile.account_id.clone();
  save_tokens_for_account(&app, &profile.account_id, &token_record)
    .map_err(|err| OAuthError::Storage(err.to_string()))?;

  Ok(AccountAuthSummary {
    account_id: profile.account_id,
    label: registry_entry.label,
    display_name: profile.display_name,
    email: profile.email,
    token_expires_at_unix: token_record.expires_at_unix,
    scope: token_record.scope,
  })
}

pub(crate) fn run_oauth_browser_flow(
  client_id: Option<String>,
  scopes: &[&str],
) -> Result<OAuthGrant, OAuthError> {
  let client_id = resolve_client_id(client_id)?;
  let client_secret = resolve_client_secret();

  let listener =
    TcpListener::bind("127.0.0.1:0").map_err(|err| OAuthError::CallbackListener(err.to_string()))?;
  let port = listener
    .local_addr()
    .map_err(|err| OAuthError::CallbackListener(err.to_string()))?
    .port();
  let redirect_uri = format!("http://127.0.0.1:{port}/oauth2/callback");

  let session = OAuthSession {
    client_id,
    client_secret,
    redirect_uri,
    state: generate_state(),
    code_verifier: generate_code_verifier(),
    scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
  };

  let auth_url = build_authorization_url(&session)?;
  let (tx, rx) = mpsc::channel::<Result<OAuthGrant, OAuthError>>();
  let callback_session = session.clone();

  thread::spawn(move || {
    let result = handle_callback(listener, callback_session);
    let _ = tx.send(result);
  });

  open_url(auth_url.as_str(), None::<&str>)
    .map_err(|err| OAuthError::BrowserLaunch(err.to_string()))?;

  rx.recv_timeout(Duration::from_secs(300))
    .map_err(|_| OAuthError::CallbackTimeout)?
}

#[tauri::command]
pub fn delete_stored_tokens(app: tauri::AppHandle, account_id: String) -> Result<(), String> {
  app_session::ensure_authenticated(&app)?;
  match delete_tokens_for_account(&app, &account_id) {
    Ok(()) | Err(keyring::Error::NoEntry) => {}
    Err(err) => return Err(err.to_string()),
  }
  remove_account(&app, &account_id)
}

fn resolve_client_id(client_id: Option<String>) -> Result<String, OAuthError> {
  client_id
    .or_else(|| std::env::var("GOOGLE_CLIENT_ID").ok())
    .or_else(|| option_env!("GOOGLE_CLIENT_ID").map(str::to_string))
    .filter(|value| !value.trim().is_empty())
    .ok_or(OAuthError::MissingClientId)
}

fn resolve_client_secret() -> Option<String> {
  std::env::var("GOOGLE_CLIENT_SECRET")
    .ok()
    .or_else(|| option_env!("GOOGLE_CLIENT_SECRET").map(str::to_string))
    .filter(|value| !value.trim().is_empty())
}

fn generate_state() -> String {
  let mut bytes = [0u8; 32];
  OsRng.fill_bytes(&mut bytes);
  URL_SAFE_NO_PAD.encode(bytes)
}

fn generate_code_verifier() -> String {
  let mut bytes = [0u8; 64];
  OsRng.fill_bytes(&mut bytes);
  URL_SAFE_NO_PAD.encode(bytes)
}

fn code_challenge_from_verifier(verifier: &str) -> String {
  let digest = Sha256::digest(verifier.as_bytes());
  URL_SAFE_NO_PAD.encode(digest)
}

fn build_authorization_url(session: &OAuthSession) -> Result<Url, OAuthError> {
  let mut url =
    Url::parse(GOOGLE_AUTH_URL).map_err(|err| OAuthError::CallbackListener(err.to_string()))?;
  let scope = session.scopes.join(" ");
  url.query_pairs_mut()
    .append_pair("client_id", &session.client_id)
    .append_pair("redirect_uri", &session.redirect_uri)
    .append_pair("response_type", "code")
    .append_pair("scope", &scope)
    .append_pair("access_type", "offline")
    .append_pair("prompt", "consent")
    .append_pair("include_granted_scopes", "true")
    .append_pair("state", &session.state)
    .append_pair("code_challenge", &code_challenge_from_verifier(&session.code_verifier))
    .append_pair("code_challenge_method", "S256");
  Ok(url)
}

fn handle_callback(
  listener: TcpListener,
  session: OAuthSession,
) -> Result<OAuthGrant, OAuthError> {
  let (mut stream, _) = listener
    .accept()
    .map_err(|err| OAuthError::CallbackListener(err.to_string()))?;
  let query = parse_callback_query(&mut stream)?;

  if let Some(err) = query.error {
    let message = query.error_description.unwrap_or(err);
    write_http_response(
      &mut stream,
      400,
      html_page("OAuth failed", &format!("Google reported an error: {message}")),
    )
    .ok();
    let _ = stream.shutdown(Shutdown::Both);
    return Err(OAuthError::MalformedCallback);
  }

  let code = query.code.ok_or(OAuthError::MalformedCallback)?;
  let state = query.state.ok_or(OAuthError::MalformedCallback)?;

  if state != session.state {
    write_http_response(
      &mut stream,
      400,
      html_page(
        "State mismatch",
        "The OAuth callback state did not match the current browser session.",
      ),
    )
    .ok();
    let _ = stream.shutdown(Shutdown::Both);
    return Err(OAuthError::StateMismatch);
  }

  match exchange_code_for_tokens(&session, &code).and_then(|token_record| {
    let profile = fetch_profile_from_access_token(&token_record.access_token)
      .map_err(|err| OAuthError::TokenExchange(err.to_string()))?;

    Ok(OAuthGrant {
      token_record,
      profile,
    })
  }) {
    Ok(grant) => {
      write_http_response(
        &mut stream,
        200,
        html_page(
          "Authorization complete",
          "OmniDrive securely stored the Google refresh token and is ready to use this account.",
        ),
      )
      .ok();
      let _ = stream.shutdown(Shutdown::Both);

      Ok(grant)
    }
    Err(err) => {
      write_http_response(
        &mut stream,
        500,
        html_page(
          "OAuth failed",
          &format!("OmniDrive could not finish the token exchange. No tokens were stored: {err}"),
        ),
      )
      .ok();
      let _ = stream.shutdown(Shutdown::Both);
      Err(err)
    }
  }
}

fn parse_callback_query(stream: &mut TcpStream) -> Result<CallbackQuery, OAuthError> {
  let mut reader = BufReader::new(stream.try_clone().map_err(|_| OAuthError::MalformedCallback)?);
  let mut request_line = String::new();
  reader
    .read_line(&mut request_line)
    .map_err(|_| OAuthError::MalformedCallback)?;

  let request_path = request_line
    .split_whitespace()
    .nth(1)
    .ok_or(OAuthError::MalformedCallback)?;

  let parsed = Url::parse(&format!("http://localhost{request_path}"))
    .map_err(|_| OAuthError::MalformedCallback)?;
  let mut query = CallbackQuery {
    code: None,
    state: None,
    error: None,
    error_description: None,
  };

  for (key, value) in parsed.query_pairs() {
    match key.as_ref() {
      "code" => query.code = Some(value.into_owned()),
      "state" => query.state = Some(value.into_owned()),
      "error" => query.error = Some(value.into_owned()),
      "error_description" => query.error_description = Some(value.into_owned()),
      _ => {}
    }
  }

  Ok(query)
}

fn exchange_code_for_tokens(
  session: &OAuthSession,
  code: &str,
) -> Result<StoredTokenRecord, OAuthError> {
  let client = Client::builder()
    .timeout(Duration::from_secs(30))
    .build()
    .map_err(|err| OAuthError::TokenExchange(err.to_string()))?;

  let mut form_fields = vec![
    ("client_id", session.client_id.as_str()),
    ("code", code),
    ("code_verifier", session.code_verifier.as_str()),
    ("grant_type", "authorization_code"),
    ("redirect_uri", session.redirect_uri.as_str()),
  ];
  if let Some(client_secret) = session.client_secret.as_deref() {
    form_fields.push(("client_secret", client_secret));
  }

  let response = client
    .post(GOOGLE_TOKEN_URL)
    .form(&form_fields)
    .send()
    .map_err(|err| OAuthError::TokenExchange(err.to_string()))?;

  let status = response.status();
  let body = response
    .text()
    .map_err(|err| OAuthError::TokenExchange(err.to_string()))?;

  if !status.is_success() {
    return Err(OAuthError::TokenExchange(format_token_error(status, &body)));
  }

  let response = serde_json::from_str::<GoogleTokenResponse>(&body)
    .map_err(|err| OAuthError::TokenExchange(err.to_string()))?;

  let refresh_token = response
    .refresh_token
    .ok_or(OAuthError::MissingRefreshToken)?;

  let expires_at_unix = response.expires_in.map(|expires_in| {
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or(Duration::from_secs(0))
      .as_secs() as i64
      + expires_in
  });

  Ok(StoredTokenRecord {
    account_id: String::new(),
    client_id: session.client_id.clone(),
    access_token: response.access_token,
    refresh_token,
    token_type: response.token_type.unwrap_or_else(|| "Bearer".to_string()),
    scope: response.scope,
    expires_at_unix,
  })
}

fn format_token_error(status: StatusCode, body: &str) -> String {
  format!("HTTP status {status} from Google token endpoint: {body}")
}

fn html_page(title: &str, message: &str) -> String {
  format!(
    r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <style>
      body {{
        font-family: "Aptos", "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", sans-serif;
        background: #fffaf0;
        color: #1f2937;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }}
      .card {{
        max-width: 560px;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(217, 119, 6, 0.16);
        border-radius: 20px;
        padding: 28px;
        box-shadow: 0 18px 60px rgba(120, 53, 15, 0.12);
      }}
      h1 {{ margin: 0 0 12px; font-size: 22px; color: #92400e; }}
      p {{ margin: 0; line-height: 1.55; color: #4b5563; }}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>{title}</h1>
      <p>{message}</p>
    </div>
  </body>
</html>"#
  )
}

fn write_http_response(
  stream: &mut TcpStream,
  status_code: u16,
  body: String,
) -> Result<(), OAuthError> {
  let status_text = match status_code {
    200 => "OK",
    400 => "Bad Request",
    500 => "Internal Server Error",
    _ => "OK",
  };

  let response = format!(
    "HTTP/1.1 {status_code} {status_text}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
    body.len()
  );
  stream
    .write_all(response.as_bytes())
    .map_err(|_| OAuthError::MalformedCallback)?;
  stream.flush().map_err(|_| OAuthError::MalformedCallback)?;
  Ok(())
}
