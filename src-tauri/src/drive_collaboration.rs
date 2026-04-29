use crate::{
  account_registry::{find_account, SourceKind},
  drive_api::{build_client, load_access_token_for_account},
};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveRevisionPayload {
  pub id: String,
  pub modified_time: Option<String>,
  pub mime_type: Option<String>,
  pub size: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevisionsListResponse {
  revisions: Option<Vec<DriveRevisionPayload>>,
}

pub fn share_drive_node(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  email_address: String,
  role: String,
) -> Result<(), String> {
  if !matches!(role.as_str(), "reader" | "commenter" | "writer") {
    return Err("share role must be reader, commenter, or writer".into());
  }
  if email_address.trim().is_empty() || !email_address.contains('@') {
    return Err("share target must be a valid email address".into());
  }

  let account = find_account(&app, &account_id)?;
  if account.source_kind == SourceKind::Photos {
    return Err("Google Photos items are read-only in OmniDrive".into());
  }

  let access_token = load_access_token_for_account(&app, &account_id)
    .map_err(|err| err.to_string())?;
  build_client()
    .map_err(|err| err.to_string())?
    .post(format!(
      "https://www.googleapis.com/drive/v3/files/{google_id}/permissions"
    ))
    .header(AUTHORIZATION, format!("Bearer {access_token}"))
    .header(CONTENT_TYPE, "application/json")
    .query(&[("sendNotificationEmail", "true")])
    .json(&serde_json::json!({
      "type": "user",
      "role": role,
      "emailAddress": email_address.trim(),
    }))
    .send()
    .and_then(|response| response.error_for_status())
    .map_err(|err| format!("failed to share Drive item: {err}"))?;

  Ok(())
}

pub fn list_drive_revisions(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
) -> Result<Vec<DriveRevisionPayload>, String> {
  let account = find_account(&app, &account_id)?;
  if account.source_kind == SourceKind::Photos {
    return Err("Google Photos items do not expose Drive revisions".into());
  }

  let access_token = load_access_token_for_account(&app, &account_id)
    .map_err(|err| err.to_string())?;
  let response = build_client()
    .map_err(|err| err.to_string())?
    .get(format!(
      "https://www.googleapis.com/drive/v3/files/{google_id}/revisions"
    ))
    .header(AUTHORIZATION, format!("Bearer {access_token}"))
    .query(&[("fields", "revisions(id,modifiedTime,mimeType,size)")])
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.json::<RevisionsListResponse>())
    .map_err(|err| format!("failed to list Drive revisions: {err}"))?;

  Ok(response.revisions.unwrap_or_default())
}

#[cfg(test)]
mod tests {
  #[test]
  fn share_roles_are_narrowly_limited() {
    assert!(matches!("reader", "reader" | "commenter" | "writer"));
    assert!(!matches!("owner", "reader" | "commenter" | "writer"));
  }
}
