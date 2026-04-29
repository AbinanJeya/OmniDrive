use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::Client;
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
use url::Url;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseAuthSessionPayload {
  pub access_token: String,
  pub refresh_token: String,
  pub expires_at: i64,
  pub user: SupabaseAuthUserPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseAuthUserPayload {
  pub id: String,
  pub email: String,
  pub email_confirmed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SupabaseTokenResponse {
  access_token: String,
  refresh_token: String,
  expires_in: Option<i64>,
  user: Option<SupabaseUserResponse>,
}

#[derive(Debug, Deserialize)]
struct SupabaseUserResponse {
  id: String,
  email: Option<String>,
  email_confirmed_at: Option<String>,
  confirmed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
  code: Option<String>,
  error: Option<String>,
  error_description: Option<String>,
}

#[derive(Debug, Clone)]
struct SupabaseOAuthSession {
  supabase_url: String,
  anon_key: String,
  redirect_uri: String,
  code_verifier: String,
}

pub fn run_google_login() -> Result<SupabaseAuthSessionPayload, String> {
  let supabase_url = env_value("VITE_SUPABASE_URL")?;
  let anon_key = env_value("VITE_SUPABASE_ANON_KEY")?;
  let listener =
    TcpListener::bind("127.0.0.1:0").map_err(|err| format!("failed to open auth callback listener: {err}"))?;
  let port = listener
    .local_addr()
    .map_err(|err| format!("failed to read auth callback port: {err}"))?
    .port();

  let session = SupabaseOAuthSession {
    supabase_url,
    anon_key,
    redirect_uri: format!("http://127.0.0.1:{port}/auth/callback"),
    code_verifier: random_urlsafe(64),
  };
  let auth_url = build_authorize_url(&session)?;
  let callback_session = session.clone();
  let (tx, rx) = mpsc::channel::<Result<SupabaseAuthSessionPayload, String>>();

  thread::spawn(move || {
    let result = handle_callback(listener, callback_session);
    let _ = tx.send(result);
  });

  open_url(auth_url.as_str(), None::<&str>)
    .map_err(|err| format!("failed to open Google sign-in: {err}"))?;

  rx.recv_timeout(Duration::from_secs(300))
    .map_err(|_| "Google sign-in timed out waiting for the browser callback.".to_string())?
}

fn build_authorize_url(session: &SupabaseOAuthSession) -> Result<Url, String> {
  let mut url = Url::parse(&format!("{}/auth/v1/authorize", session.supabase_url.trim_end_matches('/')))
    .map_err(|err| format!("invalid Supabase URL: {err}"))?;
  url
    .query_pairs_mut()
    .append_pair("provider", "google")
    .append_pair("redirect_to", &session.redirect_uri)
    .append_pair("scopes", "email profile")
    .append_pair("code_challenge", &code_challenge(&session.code_verifier))
    .append_pair("code_challenge_method", "s256");
  Ok(url)
}

fn handle_callback(
  listener: TcpListener,
  session: SupabaseOAuthSession,
) -> Result<SupabaseAuthSessionPayload, String> {
  let (mut stream, _) = listener
    .accept()
    .map_err(|err| format!("failed to accept auth callback: {err}"))?;
  let query = parse_callback_query(&mut stream)?;

  if let Some(error) = query.error {
    let message = query.error_description.unwrap_or(error);
    let _ = write_http_response(
      &mut stream,
      400,
      html_page("OmniDrive sign-in failed", &format!("Supabase reported an error: {message}")),
    );
    let _ = stream.shutdown(Shutdown::Both);
    return Err(message);
  }

  let code = query.code.ok_or_else(|| "Supabase did not return an auth code.".to_string())?;
  let result = exchange_code_for_session(&session, &code);
  match &result {
    Ok(_) => {
      let _ = write_http_response(
        &mut stream,
        200,
        html_page("OmniDrive sign-in complete", "You can return to OmniDrive now."),
      );
    }
    Err(error) => {
      let _ = write_http_response(
        &mut stream,
        500,
        html_page("OmniDrive sign-in failed", error),
      );
    }
  }
  let _ = stream.shutdown(Shutdown::Both);
  result
}

fn exchange_code_for_session(
  session: &SupabaseOAuthSession,
  code: &str,
) -> Result<SupabaseAuthSessionPayload, String> {
  let response = Client::builder()
    .timeout(Duration::from_secs(30))
    .build()
    .map_err(|err| format!("failed to create Supabase auth client: {err}"))?
    .post(format!("{}/auth/v1/token?grant_type=pkce", session.supabase_url.trim_end_matches('/')))
    .header("apikey", &session.anon_key)
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({
      "auth_code": code,
      "code_verifier": session.code_verifier,
    }))
    .send()
    .map_err(|err| format!("failed to exchange Supabase auth code: {err}"))?;

  let status = response.status();
  let body = response
    .text()
    .map_err(|err| format!("failed to read Supabase auth response: {err}"))?;
  if !status.is_success() {
    return Err(format!("Supabase auth exchange returned {status}: {body}"));
  }

  let payload = serde_json::from_str::<SupabaseTokenResponse>(&body)
    .map_err(|err| format!("failed to parse Supabase auth response: {err}"))?;
  let user = payload
    .user
    .ok_or_else(|| "Supabase did not return a user for this Google sign-in.".to_string())?;
  let expires_at = now_unix() + payload.expires_in.unwrap_or(3600);

  Ok(SupabaseAuthSessionPayload {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at,
    user: SupabaseAuthUserPayload {
      id: user.id,
      email: user.email.unwrap_or_default(),
      email_confirmed_at: user.email_confirmed_at.or(user.confirmed_at),
    },
  })
}

fn parse_callback_query(stream: &mut TcpStream) -> Result<CallbackQuery, String> {
  let mut reader = BufReader::new(stream.try_clone().map_err(|err| err.to_string())?);
  let mut request_line = String::new();
  reader
    .read_line(&mut request_line)
    .map_err(|err| format!("failed to read auth callback: {err}"))?;
  let request_path = request_line
    .split_whitespace()
    .nth(1)
    .ok_or_else(|| "auth callback request was malformed".to_string())?;
  let parsed = Url::parse(&format!("http://localhost{request_path}"))
    .map_err(|err| format!("auth callback URL was malformed: {err}"))?;

  let mut query = CallbackQuery {
    code: None,
    error: None,
    error_description: None,
  };
  for (key, value) in parsed.query_pairs() {
    match key.as_ref() {
      "code" => query.code = Some(value.into_owned()),
      "error" => query.error = Some(value.into_owned()),
      "error_description" => query.error_description = Some(value.into_owned()),
      _ => {}
    }
  }
  Ok(query)
}

fn write_http_response(stream: &mut TcpStream, status_code: u16, body: String) -> Result<(), String> {
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
    .and_then(|_| stream.flush())
    .map_err(|err| format!("failed to write auth callback response: {err}"))
}

fn html_page(title: &str, message: &str) -> String {
  format!(
    r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#031426;color:#dbeafe;font-family:Segoe UI,Arial,sans-serif}}main{{max-width:520px;padding:28px;border-radius:24px;background:rgba(7,21,39,.92);border:1px solid rgba(165,243,252,.14);box-shadow:0 28px 80px rgba(0,0,0,.34)}}h1{{margin:0 0 12px;color:#cffafe;font-size:24px}}p{{margin:0;line-height:1.55;color:#94a3b8}}</style></head><body><main><h1>{title}</h1><p>{message}</p></main></body></html>"#
  )
}

fn env_value(key: &str) -> Result<String, String> {
  std::env::var(key)
    .ok()
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| format!("missing {key}"))
}

fn code_challenge(verifier: &str) -> String {
  URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_urlsafe(len: usize) -> String {
  let mut bytes = vec![0u8; len];
  OsRng.fill_bytes(&mut bytes);
  URL_SAFE_NO_PAD.encode(bytes)
}

fn now_unix() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs() as i64)
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
  use super::{build_authorize_url, code_challenge, SupabaseOAuthSession};

  #[test]
  fn code_challenge_is_url_safe_base64_sha256() {
    assert_eq!(
      code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  }

  #[test]
  fn authorize_url_does_not_override_supabase_provider_state() {
    let session = SupabaseOAuthSession {
      supabase_url: "https://demo.supabase.co".into(),
      anon_key: "anon-key".into(),
      redirect_uri: "http://127.0.0.1:49152/auth/callback".into(),
      code_verifier: "code-verifier".into(),
    };

    let url = build_authorize_url(&session).expect("authorize url");

    assert_eq!(url.as_str().split('?').next(), Some("https://demo.supabase.co/auth/v1/authorize"));
    assert_eq!(url.query_pairs().find(|(key, _)| key == "state"), None);
    assert_eq!(
      url.query_pairs().find(|(key, _)| key == "redirect_to").map(|(_, value)| value.into_owned()),
      Some("http://127.0.0.1:49152/auth/callback".into()),
    );
  }
}
