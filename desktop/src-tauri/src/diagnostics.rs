use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{create_dir_all, read_dir, remove_file, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const RETAINED_FILES: usize = 10;
const PREFIX: &str = "reasonix-host-";
const MAX_FRONTEND_DETAILS_BYTES: usize = 64 * 1024;
const MAX_FRONTEND_NODES: usize = 2_000;
const MAX_FRONTEND_DEPTH: usize = 6;

struct Sink {
    file: File,
    path: PathBuf,
    bytes: u64,
    sequence: u64,
    started: Instant,
    launch_id: String,
    segment: u32,
}

static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();

fn diagnostics_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "neither USERPROFILE nor HOME is available".to_string())?;
    Ok(PathBuf::from(home).join(".reasonix").join("diagnostics"))
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn prune(directory: &PathBuf) -> Result<(), String> {
    let mut files: Vec<_> = read_dir(directory)
        .map_err(|error| format!("read diagnostics directory: {error}"))?
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(PREFIX))
        .collect();
    files.sort_by_key(|entry| entry.metadata().and_then(|meta| meta.modified()).ok());
    let remove_count = files.len().saturating_sub(RETAINED_FILES - 1);
    for stale in files.into_iter().take(remove_count) {
        remove_file(stale.path()).map_err(|error| format!("remove old diagnostics: {error}"))?;
    }
    Ok(())
}

pub fn initialize() -> Result<PathBuf, String> {
    let directory = diagnostics_dir()?;
    create_dir_all(&directory).map_err(|error| format!("create diagnostics directory: {error}"))?;
    prune(&directory)?;
    let launch_id = format!("{}-{}", std::process::id(), unix_ms());
    let path = directory.join(format!("{PREFIX}{launch_id}.jsonl"));
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("open diagnostics file: {error}"))?;
    let sink = Sink {
        file,
        path: path.clone(),
        bytes: 0,
        sequence: 0,
        started: Instant::now(),
        launch_id,
        segment: 0,
    };
    SINK.set(Mutex::new(sink)).map_err(|_| "diagnostics already initialized".to_string())?;
    record("info", "host.started", json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH
    }))?;
    Ok(path)
}

pub fn launch_id() -> Option<String> {
    SINK.get()
        .and_then(|sink| sink.lock().ok().map(|sink| sink.launch_id.clone()))
}

pub fn record(level: &str, event: &str, details: Value) -> Result<(), String> {
    let sink = SINK.get().ok_or_else(|| "diagnostics not initialized".to_string())?;
    let mut sink = sink.lock().map_err(|_| "diagnostics lock poisoned".to_string())?;
    sink.sequence += 1;
    let record = json!({
        "tsUnixMs": unix_ms(),
        "monotonicMs": sink.started.elapsed().as_secs_f64() * 1000.0,
        "launchId": sink.launch_id,
        "sequence": sink.sequence,
        "pid": std::process::id(),
        "source": "host",
        "level": level,
        "event": event,
        "details": details
    });
    let mut line = serde_json::to_vec(&record).map_err(|error| format!("encode diagnostics: {error}"))?;
    line.push(b'\n');
    if sink.bytes + line.len() as u64 > MAX_FILE_BYTES {
        sink.segment += 1;
        let directory = sink
            .path
            .parent()
            .ok_or_else(|| "diagnostics path has no parent".to_string())?
            .to_path_buf();
        let path = directory.join(format!("{PREFIX}{}-{}.jsonl", sink.launch_id, sink.segment));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("rotate diagnostics file: {error}"))?;
        sink.file = file;
        sink.path = path;
        sink.bytes = 0;
        prune(&directory)?;
    }
    sink.file.write_all(&line).map_err(|error| format!("write diagnostics: {error}"))?;
    sink.file.flush().map_err(|error| format!("flush diagnostics: {error}"))?;
    sink.bytes += line.len() as u64;
    Ok(())
}

fn validate_frontend_value(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
    *nodes += 1;
    if *nodes > MAX_FRONTEND_NODES {
        return Err(format!("frontend diagnostic exceeds {MAX_FRONTEND_NODES} nodes"));
    }
    if depth > MAX_FRONTEND_DEPTH {
        return Err(format!("frontend diagnostic exceeds depth {MAX_FRONTEND_DEPTH}"));
    }
    match value {
        Value::Array(items) => {
            for item in items {
                validate_frontend_value(item, depth + 1, nodes)?;
            }
        }
        Value::Object(fields) => {
            for child in fields.values() {
                validate_frontend_value(child, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(Serialize)]
pub struct FrontendDiagnosticResponse {
    pub recorded: bool,
}

#[tauri::command]
pub fn record_frontend_diagnostic(
    level: String,
    event: String,
    details: Value,
) -> Result<FrontendDiagnosticResponse, String> {
    let safe_level = match level.as_str() {
        "error" | "warn" | "info" | "debug" | "verbose" => level,
        _ => "debug".to_string(),
    };
    let encoded_bytes = serde_json::to_vec(&details)
        .map_err(|error| format!("encode frontend diagnostic: {error}"))?
        .len();
    if encoded_bytes > MAX_FRONTEND_DETAILS_BYTES {
        return Err(format!(
            "frontend diagnostic exceeds {MAX_FRONTEND_DETAILS_BYTES} bytes"
        ));
    }
    validate_frontend_value(&details, 0, &mut 0)?;
    let safe_event: String = event
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "_.:-".contains(*character))
        .take(160)
        .collect();
    record(&safe_level, if safe_event.is_empty() { "frontend.unnamed" } else { &safe_event }, details)?;
    Ok(FrontendDiagnosticResponse { recorded: true })
}
