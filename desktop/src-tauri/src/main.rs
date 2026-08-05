#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod rpc;

use rpc::{RpcState, rpc_kill, rpc_send, rpc_spawn};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn pasted_images_dir() -> PathBuf {
    std::env::temp_dir().join("reasonix-pasted-images")
}

#[derive(Serialize)]
struct FileEntry {
    path: String,
    depth: u32,
    kind: &'static str,
    name: String,
}

const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "out"];
const MAX_ENTRIES: usize = 800;

fn walk_dir(dir: &Path, depth: u32, max_depth: u32, out: &mut Vec<FileEntry>) {
    if depth > max_depth || out.len() >= MAX_ENTRIES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name())
    });
    for entry in items {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // Hidden files (.git, .next, .env) and well-known noise dirs.
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else { continue };
        let path = entry.path().to_string_lossy().into_owned();
        if file_type.is_dir() {
            out.push(FileEntry {
                path: path.clone(),
                depth,
                kind: "dir",
                name,
            });
            walk_dir(&entry.path(), depth + 1, max_depth, out);
        } else if file_type.is_file() {
            out.push(FileEntry {
                path,
                depth,
                kind: "file",
                name,
            });
        }
    }
}

#[tauri::command]
fn list_workspace_tree(root: String, max_depth: u32) -> Result<Vec<FileEntry>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut out = Vec::new();
    walk_dir(root_path, 0, max_depth.min(4), &mut out);
    Ok(out)
}

#[derive(Serialize)]
struct GitStatusEntry {
    path: String,
    kind: &'static str,
}

#[tauri::command]
fn git_status(root: String) -> Result<Vec<GitStatusEntry>, String> {
    use std::process::Command;
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut cmd = Command::new("git");
    cmd.arg("status").arg("--porcelain").arg("-z").current_dir(root_path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()), // not a git repo / no git on PATH — silent
    };
    if !output.status.success() {
        return Ok(Vec::new()); // not a git repo — silent
    }
    let mut out = Vec::new();
    for rec in output.stdout.split(|&b| b == 0) {
        if rec.len() < 4 {
            continue;
        }
        // `git status --porcelain -z` format: `XY ` + path, where X / Y are
        // index / worktree statuses. Map both to a coarse `kind`.
        let x = rec[0];
        let y = rec[1];
        let kind = match (x, y) {
            (b'?', b'?') => "untracked",
            (b'A', _) | (_, b'A') => "added",
            (b'D', _) | (_, b'D') => "deleted",
            (b'M', _) | (_, b'M') => "modified",
            (b'R', _) | (_, b'R') => "renamed",
            _ => continue,
        };
        let path = String::from_utf8_lossy(&rec[3..]).into_owned();
        out.push(GitStatusEntry { path, kind });
    }
    Ok(out)
}

/// Probe whether an editor command resolves and runs — used to auto-detect
/// a code editor when none is configured. On Windows this goes through
/// cmd.exe so `.cmd` shims (code.cmd, cursor.cmd) resolve via PATH; a
/// missing command exits with 9009, so a successful `--version` run is a
/// reliable probe.
fn probe_editor(candidate: &str) -> bool {
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let probe = Command::new("cmd")
            .arg("/c")
            .arg(format!("{candidate} --version"))
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
        return matches!(probe, Ok(out) if out.status.success());
    }
    #[cfg(not(windows))]
    {
        let probe = Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
        return matches!(probe, Ok(out) if out.status.success());
    }
}

/// Auto-detect a code editor for the "no editor configured" case. Without
/// this the frontend falls back to the OS default handler, and on Windows
/// `.ts` is registered to media players (MPEG transport stream) — so
/// `loop.ts` would open in the media player instead of an editor. Probes
/// the editors this app knows understand `-g path:line`, in order.
fn detect_editor_command() -> Option<String> {
    for candidate in ["code", "cursor", "windsurf"] {
        if probe_editor(candidate) {
            return Some(candidate.to_string());
        }
    }
    None
}

#[tauri::command]
fn open_in_editor(command: String, path: String, line: Option<u32>) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let trimmed = command.trim();
    // Empty command = no editor configured in settings. Auto-detect one
    // (VS Code / Cursor / Windsurf) so file links never fall through to the
    // OS default handler (Windows would open `.ts` in the media player).
    let resolved = if trimmed.is_empty() {
        match detect_editor_command() {
            Some(candidate) => candidate,
            None => {
                return Err(
                    "no editor configured and none detected (tried code, cursor, windsurf)".into(),
                );
            }
        }
    } else {
        trimmed.to_string()
    };
    // VS Code / Cursor / Windsurf understand `-g path:line`; harmless for others if `line` is None.
    let mut cmd;
    #[cfg(windows)]
    {
        // Spawn through cmd.exe so `.cmd` shims (code.cmd, cursor.cmd) resolve via PATH.
        // Normalize forward slashes to backslashes — cmd.exe doesn't handle them reliably.
        let normalized = path.replace('/', "\\");
        cmd = Command::new("cmd");
        cmd.arg("/c").arg(&resolved);
        if let Some(l) = line {
            cmd.arg("-g").arg(format!("{}:{}", normalized, l));
        } else {
            cmd.arg(&normalized);
        }
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        cmd = Command::new(&resolved);
        if let Some(l) = line {
            cmd.arg("-g").arg(format!("{}:{}", path, l));
        } else {
            cmd.arg(&path);
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().map_err(|e| format!("spawn {resolved}: {e}"))?;
    Ok(())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("write failed: {e}"))
}

fn sanitize_image_extension(raw: Option<&str>) -> String {
    let cleaned = raw
        .map(|s| s.trim().trim_start_matches('.').to_ascii_lowercase())
        .unwrap_or_default();
    let ok = !cleaned.is_empty()
        && cleaned.len() <= 8
        && cleaned.chars().all(|c| c.is_ascii_alphanumeric());
    if ok { cleaned } else { "png".to_string() }
}

#[tauri::command]
fn save_clipboard_image(bytes: Vec<u8>, extension: Option<String>) -> Result<String, String> {
    let ext = sanitize_image_extension(extension.as_deref());
    let dir = pasted_images_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock error: {e}"))?
        .as_millis();
    let path = dir.join(format!("reasonix-pasted-{ts}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn purge_old_pasted_images(max_age: Duration) {
    let dir = pasted_images_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let cutoff = SystemTime::now().checked_sub(max_age);
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() { continue }
        let Ok(modified) = metadata.modified() else { continue };
        if cutoff.is_some_and(|t| modified < t) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(RpcState::default())
        .invoke_handler(tauri::generate_handler![
            rpc_spawn,
            rpc_send,
            rpc_kill,
            open_in_editor,
            list_workspace_tree,
            git_status,
            write_text_file,
            save_clipboard_image
        ])
        .setup(|app| {
            use tauri::Manager;
            std::thread::spawn(|| purge_old_pasted_images(Duration::from_secs(24 * 60 * 60)));
            if let Some(w) = app.get_webview_window("main") {
                // HiDPI fit: the JSON config asks for 1024x720 logical px.
                // On Windows laptops at 200% scale (1920x1080 → 960x540
                // effective logical px) that overflows the screen and the
                // window opens partially off-canvas. Clamp to 90% of the
                // monitor's available logical size whenever the configured
                // size doesn't fit, then recenter.
                if let Ok(Some(monitor)) = w.current_monitor() {
                    let scale = monitor.scale_factor();
                    let phys = monitor.size();
                    let avail_w = phys.width as f64 / scale;
                    let avail_h = phys.height as f64 / scale;
                    let want_w = 1024_f64.min(avail_w * 0.9);
                    let want_h = 720_f64.min(avail_h * 0.9);
                    if want_w < 1024.0 || want_h < 720.0 {
                        let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize {
                            width: want_w,
                            height: want_h,
                        }));
                        let _ = w.center();
                    }
                }
                if std::env::var("REASONIX_DEVTOOLS").is_ok() {
                    #[cfg(debug_assertions)]
                    w.open_devtools();
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build failed")
        .run(|app, event| {
            // Tauri 2 normally exits the process via Exit; managed-state drops
            // don't always run. ExitRequested fires before that, so we kill the
            // Node child here too — belt-and-braces vs the Drop on RpcHandle.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                let state = app.state::<RpcState>();
                let _ = rpc::rpc_kill(state);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::sanitize_image_extension;

    #[test]
    fn accepts_alphanumeric_extensions() {
        assert_eq!(sanitize_image_extension(Some("png")), "png");
        assert_eq!(sanitize_image_extension(Some("JPG")), "jpg");
        assert_eq!(sanitize_image_extension(Some(".webp")), "webp");
        assert_eq!(sanitize_image_extension(Some("svg")), "svg");
    }

    #[test]
    fn falls_back_when_missing_or_invalid() {
        assert_eq!(sanitize_image_extension(None), "png");
        assert_eq!(sanitize_image_extension(Some("")), "png");
        assert_eq!(sanitize_image_extension(Some("   ")), "png");
    }

    #[test]
    fn rejects_path_separators_and_traversal() {
        assert_eq!(sanitize_image_extension(Some("png/../../foo")), "png");
        assert_eq!(sanitize_image_extension(Some("png\\foo")), "png");
        assert_eq!(sanitize_image_extension(Some("../bin")), "png");
        assert_eq!(sanitize_image_extension(Some("p.n.g")), "png");
    }

    #[test]
    fn rejects_overlong_extensions() {
        assert_eq!(sanitize_image_extension(Some("verylongext")), "png");
    }
}
