use crate::{
  app_session,
  account_registry::{find_account, SourceKind},
  drive_api::{build_client, load_access_token_for_account, GOOGLE_FOLDER_MIME_TYPE},
  drive_mutations::DriveMutationError,
  photos_api::fetch_picked_media_item_bytes,
};
use calamine::{open_workbook_auto_from_rs, Data, Reader};
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use reqwest::{
  blocking::Client,
  header::AUTHORIZATION,
  StatusCode,
};
use serde::Serialize;
use std::{
  fs,
  io::{Cursor, Read},
  path::{Path, PathBuf},
};
use thiserror::Error;
use zip::ZipArchive;

const GOOGLE_DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetSheetPayload {
  pub name: String,
  pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDescriptorPayload {
  pub kind: String,
  pub filename: String,
  pub mime_type: String,
  pub account_id: String,
  pub google_id: String,
  pub local_path: Option<String>,
  pub html_content: Option<String>,
  pub text_content: Option<String>,
  pub sheets: Option<Vec<SpreadsheetSheetPayload>>,
  pub note: Option<String>,
}

#[derive(Debug, Error)]
pub enum PreviewError {
  #[error("failed to load Google Drive context: {0}")]
  Context(String),
  #[error("failed to resolve preview cache directory: {0}")]
  CacheDirectory(String),
  #[error("failed to create preview cache directory: {0}")]
  CacheCreate(String),
  #[error("failed to download file preview: {0}")]
  Download(String),
  #[error("failed to write preview cache file: {0}")]
  CacheWrite(String),
  #[error("failed to parse document preview: {0}")]
  Document(String),
  #[error("failed to parse spreadsheet preview: {0}")]
  Spreadsheet(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewKind {
  Pdf,
  Image,
  Audio,
  Video,
  Text,
  Docx,
  Xlsx,
  Unsupported,
}

#[derive(Debug, Clone, Copy)]
struct WorkspaceExportTarget {
  mime_type: &'static str,
  extension: &'static str,
}

pub fn prepare_drive_node_preview(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  filename: String,
  mime_type: String,
) -> Result<PreviewDescriptorPayload, PreviewError> {
  let access_token = load_access_token_for_account(&app, &account_id)
    .map_err(|err| PreviewError::Context(err.to_string()))?;
  let preview_kind = preview_kind_for_file(&mime_type, &filename);
  let registry_entry =
    find_account(&app, &account_id).map_err(|err| PreviewError::Context(err.to_string()))?;

  if preview_kind == PreviewKind::Unsupported || mime_type == GOOGLE_FOLDER_MIME_TYPE {
    return Ok(unsupported_preview(
      account_id,
      google_id,
      filename,
      mime_type,
      "OmniDrive cannot preview this file type in-app yet.".into(),
    ));
  }

  let bytes = match registry_entry.source_kind {
    SourceKind::Drive => {
      let client = build_client().map_err(|err| PreviewError::Download(err.to_string()))?;
      if let Some(export_target) = workspace_export_target(&mime_type) {
        match export_workspace_bytes(&client, &access_token, &google_id, export_target.mime_type)
        {
          Ok(bytes) => bytes,
          Err(err) => {
            return Ok(unsupported_preview(
              account_id,
              google_id,
              filename,
              mime_type,
              format!("Google Drive could not export this file for preview: {err}"),
            ))
          }
        }
      } else {
        download_blob_bytes(&client, &access_token, &google_id)
          .map_err(|err| PreviewError::Download(err.to_string()))?
      }
    }
    SourceKind::Photos => {
      let session_id = registry_entry.remote_collection_id.ok_or_else(|| {
        PreviewError::Context(format!(
          "Google Photos account {account_id} is missing a picker session id"
        ))
      })?;
      fetch_picked_media_item_bytes(&access_token, &session_id, &google_id, &mime_type)
        .map_err(|err| PreviewError::Download(err.to_string()))?
    }
  };

  match preview_kind {
    PreviewKind::Pdf | PreviewKind::Image | PreviewKind::Audio | PreviewKind::Video => {
      let export_extension = workspace_export_target(&mime_type).map(|target| target.extension);
      let local_path = write_preview_cache_file(
        &app,
        &account_id,
        &google_id,
        &filename,
        export_extension,
        &bytes,
      )?;
      Ok(PreviewDescriptorPayload {
        kind: preview_kind.as_str().into(),
        filename,
        mime_type,
        account_id,
        google_id,
        local_path: Some(local_path.display().to_string()),
        html_content: None,
        text_content: None,
        sheets: None,
        note: None,
      })
    }
    PreviewKind::Text => Ok(PreviewDescriptorPayload {
      kind: preview_kind.as_str().into(),
      filename,
      mime_type,
      account_id,
      google_id,
      local_path: None,
      html_content: None,
      text_content: Some(
        String::from_utf8(bytes).unwrap_or_else(|err| String::from_utf8_lossy(err.as_bytes()).into_owned()),
      ),
      sheets: None,
      note: None,
    }),
    PreviewKind::Docx => Ok(PreviewDescriptorPayload {
      kind: preview_kind.as_str().into(),
      filename,
      mime_type,
      account_id,
      google_id,
      local_path: None,
      html_content: Some(parse_docx_preview_html(&bytes)?),
      text_content: None,
      sheets: None,
      note: None,
    }),
    PreviewKind::Xlsx => Ok(PreviewDescriptorPayload {
      kind: preview_kind.as_str().into(),
      filename,
      mime_type,
      account_id,
      google_id,
      local_path: None,
      html_content: None,
      text_content: None,
      sheets: Some(parse_spreadsheet_preview(&bytes)?),
      note: None,
    }),
    PreviewKind::Unsupported => Ok(unsupported_preview(
      account_id,
      google_id,
      filename,
      mime_type,
      "OmniDrive cannot preview this file type in-app yet.".into(),
    )),
  }
}

pub fn lookup_cached_drive_node_preview(
  app: tauri::AppHandle,
  account_id: String,
  google_id: String,
  filename: String,
  mime_type: String,
) -> Result<Option<PreviewDescriptorPayload>, PreviewError> {
  let preview_kind = preview_kind_for_file(&mime_type, &filename);
  if !matches!(
    preview_kind,
    PreviewKind::Pdf | PreviewKind::Image | PreviewKind::Audio | PreviewKind::Video
  ) || mime_type == GOOGLE_FOLDER_MIME_TYPE
  {
    return Ok(None);
  }

  let export_extension = workspace_export_target(&mime_type).map(|target| target.extension);
  let preview_path = preview_cache_path(
    &app,
    &account_id,
    &google_id,
    &filename,
    export_extension,
  )?;

  if !preview_path.exists() {
    return Ok(None);
  }

  Ok(Some(PreviewDescriptorPayload {
    kind: preview_kind.as_str().into(),
    filename,
    mime_type,
    account_id,
    google_id,
    local_path: Some(preview_path.display().to_string()),
    html_content: None,
    text_content: None,
    sheets: None,
    note: None,
  }))
}

fn unsupported_preview(
  account_id: String,
  google_id: String,
  filename: String,
  mime_type: String,
  note: String,
) -> PreviewDescriptorPayload {
  PreviewDescriptorPayload {
    kind: PreviewKind::Unsupported.as_str().into(),
    filename,
    mime_type,
    account_id,
    google_id,
    local_path: None,
    html_content: None,
    text_content: None,
    sheets: None,
    note: Some(note),
  }
}

fn write_preview_cache_file(
  app: &tauri::AppHandle,
  account_id: &str,
  google_id: &str,
  filename: &str,
  override_extension: Option<&str>,
  bytes: &[u8],
) -> Result<PathBuf, PreviewError> {
  let preview_path = preview_cache_path(app, account_id, google_id, filename, override_extension)?;
  fs::write(&preview_path, bytes).map_err(|err| PreviewError::CacheWrite(err.to_string()))?;
  Ok(preview_path)
}

fn preview_cache_path(
  app: &tauri::AppHandle,
  account_id: &str,
  google_id: &str,
  filename: &str,
  override_extension: Option<&str>,
) -> Result<PathBuf, PreviewError> {
  let cache_dir = app_session::namespaced_cache_dir(app)
    .map_err(PreviewError::CacheDirectory)?
    .join("previews");
  fs::create_dir_all(&cache_dir).map_err(|err| PreviewError::CacheCreate(err.to_string()))?;

  let extension = override_extension
    .map(str::to_string)
    .or_else(|| file_extension(filename))
    .unwrap_or_else(|| "bin".into());
  let safe_stem = sanitize_filename(filename);

  Ok(cache_dir.join(format!(
    "{account_id}-{google_id}-{safe_stem}.{extension}"
  )))
}

fn download_blob_bytes(
  client: &Client,
  access_token: &str,
  google_id: &str,
) -> Result<Vec<u8>, DriveMutationError> {
  client
    .get(format!("{GOOGLE_DRIVE_FILES_URL}/{google_id}"))
    .header(AUTHORIZATION, bearer(access_token))
    .query(&[("alt", "media")])
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.bytes())
    .map(|bytes| bytes.to_vec())
    .map_err(|err| DriveMutationError::GoogleDrive(err.to_string()))
}

fn export_workspace_bytes(
  client: &Client,
  access_token: &str,
  google_id: &str,
  export_mime_type: &str,
) -> Result<Vec<u8>, PreviewError> {
  let response = client
    .get(format!("{GOOGLE_DRIVE_FILES_URL}/{google_id}/export"))
    .header(AUTHORIZATION, bearer(access_token))
    .query(&[("mimeType", export_mime_type)])
    .send()
    .map_err(|err| PreviewError::Download(err.to_string()))?;
  let status = response.status();
  let bytes = response
    .bytes()
    .map_err(|err| PreviewError::Download(err.to_string()))?;

  if status == StatusCode::BAD_REQUEST || status == StatusCode::FORBIDDEN {
    return Err(PreviewError::Download(format!(
      "Google export returned {status} for preview conversion",
    )));
  }

  if !status.is_success() {
    return Err(PreviewError::Download(format!(
      "Google export returned {status} for preview conversion",
    )));
  }

  Ok(bytes.to_vec())
}

fn parse_docx_preview_html(bytes: &[u8]) -> Result<String, PreviewError> {
  let cursor = Cursor::new(bytes.to_vec());
  let mut archive = ZipArchive::new(cursor).map_err(|err| PreviewError::Document(err.to_string()))?;
  let mut document_xml = String::new();
  archive
    .by_name("word/document.xml")
    .map_err(|err| PreviewError::Document(err.to_string()))?
    .read_to_string(&mut document_xml)
    .map_err(|err| PreviewError::Document(err.to_string()))?;

  let mut reader = XmlReader::from_reader(Cursor::new(document_xml.into_bytes()));
  let mut buffer = Vec::new();
  let mut fragments = Vec::<String>::new();
  let mut current_paragraph = String::new();
  let mut table_rows = Vec::<Vec<String>>::new();
  let mut current_row = Vec::<String>::new();
  let mut current_cell: Option<String> = None;
  let mut inside_table = false;

  loop {
    match reader.read_event_into(&mut buffer) {
      Ok(Event::Start(event)) => match event.name().as_ref() {
        b"w:tbl" => {
          inside_table = true;
          table_rows.clear();
        }
        b"w:tr" => current_row.clear(),
        b"w:tc" => current_cell = Some(String::new()),
        _ => {}
      },
      Ok(Event::Empty(event)) => match event.name().as_ref() {
        b"w:br" => append_preview_text(&mut current_paragraph, &mut current_cell, "\n"),
        b"w:tab" => append_preview_text(&mut current_paragraph, &mut current_cell, "\t"),
        _ => {}
      },
      Ok(Event::Text(event)) => {
        let text = String::from_utf8_lossy(event.as_ref()).into_owned();
        append_preview_text(&mut current_paragraph, &mut current_cell, &text);
      }
      Ok(Event::End(event)) => match event.name().as_ref() {
        b"w:p" if !inside_table => {
          let paragraph = current_paragraph.trim();
          if !paragraph.is_empty() {
            fragments.push(format!("<p>{}</p>", html_escape(paragraph)));
          }
          current_paragraph.clear();
        }
        b"w:tc" => {
          if let Some(cell) = current_cell.take() {
            current_row.push(cell.trim().to_string());
          }
        }
        b"w:tr" => {
          if !current_row.is_empty() {
            table_rows.push(current_row.clone());
          }
        }
        b"w:tbl" => {
          if !table_rows.is_empty() {
            fragments.push(render_html_table(&table_rows));
          }
          inside_table = false;
          table_rows.clear();
        }
        _ => {}
      },
      Ok(Event::Eof) => break,
      Err(err) => return Err(PreviewError::Document(err.to_string())),
      _ => {}
    }

    buffer.clear();
  }

  if fragments.is_empty() {
    return Err(PreviewError::Document(
      "The DOCX file did not contain any previewable text.".into(),
    ));
  }

  Ok(fragments.join(""))
}

fn parse_spreadsheet_preview(bytes: &[u8]) -> Result<Vec<SpreadsheetSheetPayload>, PreviewError> {
  let cursor = Cursor::new(bytes.to_vec());
  let mut workbook = open_workbook_auto_from_rs(cursor)
    .map_err(|err| PreviewError::Spreadsheet(err.to_string()))?;
  let sheet_names = workbook.sheet_names().to_owned();
  let mut sheets = Vec::new();

  for sheet_name in sheet_names {
    if let Ok(range) = workbook.worksheet_range(&sheet_name) {
      let rows = range
        .rows()
        .map(|row| row.iter().map(cell_to_string).collect::<Vec<_>>())
        .collect::<Vec<_>>();
      sheets.push(SpreadsheetSheetPayload { name: sheet_name, rows });
    }
  }

  if sheets.is_empty() {
    return Err(PreviewError::Spreadsheet(
      "The workbook did not expose any readable sheets.".into(),
    ));
  }

  Ok(sheets)
}

fn cell_to_string(cell: &Data) -> String {
  match cell {
    Data::Empty => String::new(),
    _ => cell.to_string(),
  }
}

fn append_preview_text(
  current_paragraph: &mut String,
  current_cell: &mut Option<String>,
  next: &str,
) {
  if let Some(cell) = current_cell.as_mut() {
    cell.push_str(next);
  } else {
    current_paragraph.push_str(next);
  }
}

fn render_html_table(rows: &[Vec<String>]) -> String {
  let row_html = rows
    .iter()
    .map(|row| {
      let cells = row
        .iter()
        .map(|cell| format!("<td>{}</td>", html_escape(cell)))
        .collect::<Vec<_>>()
        .join("");
      format!("<tr>{cells}</tr>")
    })
    .collect::<Vec<_>>()
    .join("");

  format!("<table><tbody>{row_html}</tbody></table>")
}

fn html_escape(value: &str) -> String {
  value
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
}

fn sanitize_filename(filename: &str) -> String {
  let stem = Path::new(filename)
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("preview");
  stem
    .chars()
    .map(|character| {
      if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
        character
      } else {
        '-'
      }
    })
    .collect::<String>()
}

fn file_extension(filename: &str) -> Option<String> {
  Path::new(filename)
    .extension()
    .and_then(|value| value.to_str())
    .map(|value| value.to_lowercase())
}

fn preview_kind_for_file(mime_type: &str, filename: &str) -> PreviewKind {
  let extension = file_extension(filename);

  if mime_type == "application/pdf" || extension.as_deref() == Some("pdf") {
    return PreviewKind::Pdf;
  }

  if mime_type.starts_with("image/") {
    return PreviewKind::Image;
  }

  if mime_type.starts_with("audio/") {
    return PreviewKind::Audio;
  }

  if mime_type.starts_with("video/") {
    return PreviewKind::Video;
  }

  if mime_type == "application/vnd.google-apps.document"
    || mime_type.contains("wordprocessingml")
    || mime_type == "application/msword"
  {
    return PreviewKind::Docx;
  }

  if mime_type == "application/vnd.google-apps.spreadsheet"
    || mime_type.contains("spreadsheetml")
    || mime_type == "application/vnd.ms-excel"
  {
    return PreviewKind::Xlsx;
  }

  if mime_type.starts_with("text/")
    || matches!(
      extension.as_deref(),
      Some("txt" | "md" | "markdown" | "json" | "csv" | "tsv" | "log" | "xml" | "yml" | "yaml")
    )
  {
    return PreviewKind::Text;
  }

  PreviewKind::Unsupported
}

fn workspace_export_target(mime_type: &str) -> Option<WorkspaceExportTarget> {
  match mime_type {
    "application/vnd.google-apps.document" => Some(WorkspaceExportTarget {
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: "docx",
    }),
    "application/vnd.google-apps.spreadsheet" => Some(WorkspaceExportTarget {
      mime_type:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx",
    }),
    _ => None,
  }
}

fn bearer(access_token: &str) -> String {
  format!("Bearer {access_token}")
}

impl PreviewKind {
  fn as_str(self) -> &'static str {
    match self {
      PreviewKind::Pdf => "pdf",
      PreviewKind::Image => "image",
      PreviewKind::Audio => "audio",
      PreviewKind::Video => "video",
      PreviewKind::Text => "text",
      PreviewKind::Docx => "docx",
      PreviewKind::Xlsx => "xlsx",
      PreviewKind::Unsupported => "unsupported",
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{preview_kind_for_file, workspace_export_target, PreviewKind};

  #[test]
  fn preview_kind_resolves_supported_formats() {
    assert_eq!(preview_kind_for_file("application/pdf", "Plan.pdf"), PreviewKind::Pdf);
    assert_eq!(
      preview_kind_for_file(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Plan.docx",
      ),
      PreviewKind::Docx,
    );
    assert_eq!(
      preview_kind_for_file(
        "application/vnd.google-apps.spreadsheet",
        "Forecast",
      ),
      PreviewKind::Xlsx,
    );
    assert_eq!(preview_kind_for_file("audio/mpeg", "Theme.mp3"), PreviewKind::Audio);
    assert_eq!(
      preview_kind_for_file("application/octet-stream", "Archive.bin"),
      PreviewKind::Unsupported
    );
  }

  #[test]
  fn workspace_files_map_to_preview_exports() {
    let document_target =
      workspace_export_target("application/vnd.google-apps.document").expect("doc export target");
    assert_eq!(document_target.extension, "docx");

    let sheet_target = workspace_export_target("application/vnd.google-apps.spreadsheet")
      .expect("sheet export target");
    assert_eq!(sheet_target.extension, "xlsx");
  }
}
