#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod diagnostics;
mod rpc;

use diagnostics::record_frontend_diagnostic;
use rpc::{RpcState, rpc_kill, rpc_send, rpc_spawn};
use serde::Serialize;
use std::path::Path;

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

/// Search `root` (bounded, skipping hidden entries and well-known noise
/// dirs) for files whose basename matches `name` (case-insensitive).
fn find_by_basename(root: &Path, name: &str) -> Vec<String> {
    const MAX_DEPTH: u32 = 6;
    const MAX_VISITED: usize = 20_000;
    const MAX_MATCHES: usize = 20;
    let mut queue: std::collections::VecDeque<(std::path::PathBuf, u32)> =
        std::collections::VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));
    let mut matches = Vec::new();
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if depth > MAX_DEPTH || visited >= MAX_VISITED || matches.len() >= MAX_MATCHES {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if visited >= MAX_VISITED || matches.len() >= MAX_MATCHES {
                break;
            }
            visited += 1;
            let entry_name = entry.file_name();
            let name_str = entry_name.to_string_lossy();
            if name_str.starts_with('.') || SKIP_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_dir() {
                queue.push_back((entry.path(), depth + 1));
            } else if file_type.is_file() && name_str.eq_ignore_ascii_case(name) {
                matches.push(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    matches.sort();
    matches
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum WorkspaceFileResolution {
    Exact { path: String },
    Unique { path: String },
    Ambiguous { paths: Vec<String> },
    NotFound,
}

fn resolve_workspace_file_impl(path: &str, workspace: Option<&str>) -> WorkspaceFileResolution {
    let candidate = if Path::new(path).is_absolute() {
        path.to_string()
    } else if let Some(ws) = workspace {
        Path::new(ws).join(path).to_string_lossy().into_owned()
    } else {
        path.to_string()
    };
    if std::fs::metadata(&candidate).is_ok() {
        return WorkspaceFileResolution::Exact { path: candidate };
    }
    let Some(ws) = workspace else {
        return WorkspaceFileResolution::NotFound;
    };
    let Some(base) = Path::new(path).file_name().and_then(|name| name.to_str()) else {
        return WorkspaceFileResolution::NotFound;
    };
    match find_by_basename(Path::new(ws), base).as_slice() {
        [] => WorkspaceFileResolution::NotFound,
        [path] => WorkspaceFileResolution::Unique { path: path.clone() },
        paths => WorkspaceFileResolution::Ambiguous {
            paths: paths.to_vec(),
        },
    }
}

#[tauri::command]
fn resolve_workspace_file(
    path: String,
    workspace: Option<String>,
) -> Result<WorkspaceFileResolution, String> {
    Ok(resolve_workspace_file_impl(&path, workspace.as_deref()))
}

/// Resolve an existing path for legacy reveal callers. Ambiguous basename
/// matches deliberately do not resolve to an arbitrary file.
fn resolve_existing(path: &str, workspace: Option<&str>) -> String {
    match resolve_workspace_file_impl(path, workspace) {
        WorkspaceFileResolution::Exact { path } | WorkspaceFileResolution::Unique { path } => path,
        WorkspaceFileResolution::Ambiguous { .. } | WorkspaceFileResolution::NotFound => {
            if Path::new(path).is_absolute() {
                path.to_string()
            } else if let Some(ws) = workspace {
                Path::new(ws).join(path).to_string_lossy().into_owned()
            } else {
                path.to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{WorkspaceFileResolution, resolve_workspace_file_impl};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reasonix-file-resolution-{nonce}"));
        std::fs::create_dir_all(root.join("one")).expect("create one");
        std::fs::create_dir_all(root.join("two")).expect("create two");
        root
    }

    #[test]
    fn resolves_exact_and_unique_workspace_files() {
        let root = fixture();
        let exact = root.join("one").join("exact.qci");
        let unique = root.join("two").join("unique.qci");
        std::fs::write(&exact, "exact").expect("write exact");
        std::fs::write(&unique, "unique").expect("write unique");
        let workspace = root.to_string_lossy();

        assert!(matches!(
            resolve_workspace_file_impl("one/exact.qci", Some(&workspace)),
            WorkspaceFileResolution::Exact { path } if PathBuf::from(&path) == exact
        ));
        assert!(matches!(
            resolve_workspace_file_impl("unique.qci", Some(&workspace)),
            WorkspaceFileResolution::Unique { path } if PathBuf::from(&path) == unique
        ));

        std::fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn reports_ambiguous_and_missing_workspace_files() {
        let root = fixture();
        std::fs::write(root.join("one").join("shared.qci"), "one").expect("write one");
        std::fs::write(root.join("two").join("shared.qci"), "two").expect("write two");
        let workspace = root.to_string_lossy();

        assert!(matches!(
            resolve_workspace_file_impl("shared.qci", Some(&workspace)),
            WorkspaceFileResolution::Ambiguous { paths } if paths.len() == 2
        ));
        assert!(matches!(
            resolve_workspace_file_impl("missing.qci", Some(&workspace)),
            WorkspaceFileResolution::NotFound
        ));

        std::fs::remove_dir_all(root).expect("remove fixture");
    }
}

/// Reveal a file or directory in the OS file explorer: a file opens its
/// parent folder with the item selected (Explorer / Finder), a directory
/// opens the directory itself. Replaces the old "open in code editor"
/// flow — no editor detection, no editor config.
#[tauri::command]
fn reveal_in_explorer(path: String, workspace: Option<String>) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let resolved = resolve_existing(&path, workspace.as_deref());
    let is_dir = std::fs::metadata(&resolved).map(|m| m.is_dir()).unwrap_or(false);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let normalized = resolved.replace('/', "\\");
        let mut cmd = Command::new("explorer.exe");
        if is_dir {
            cmd.arg(&normalized);
        } else {
            cmd.arg("/select,").arg(&normalized);
        }
        cmd.creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.spawn().map_err(|e| format!("spawn explorer.exe: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        if is_dir {
            cmd.arg(&resolved);
        } else {
            cmd.arg("-R").arg(&resolved);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn().map_err(|e| format!("spawn open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "select file" on Linux — open the parent directory.
        let target = if is_dir {
            resolved.clone()
        } else {
            std::path::Path::new(&resolved)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| resolved.clone())
        };
        let mut cmd = Command::new("xdg-open");
        cmd.arg(&target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn().map_err(|e| format!("spawn xdg-open: {e}"))?;
        return Ok(());
    }
}

/// Open a file with the native OS "Open with…" chooser, so the user can pick
/// which app handles it (notepad++, notepad, etc.) instead of a hardcoded
/// editor. On Windows this uses `rundll32.exe shell32.dll,OpenAs_RunDLL`,
/// which pops the same dialog Explorer uses for right-click → "Open with…".
/// On other platforms there is no portable equivalent, so fall back to the OS
/// default handler (the `open` / `xdg-open` behaviour).
#[tauri::command]
fn open_with_dialog(path: String) -> Result<(), String> {
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let normalized = path.replace('/', "\\");
        let mut cmd = Command::new("rundll32.exe");
        cmd.arg("shell32.dll,OpenAs_RunDLL")
            .arg(&normalized)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.spawn()
            .map_err(|e| format!("spawn rundll32 OpenAs_RunDLL: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn().map_err(|e| format!("spawn open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn().map_err(|e| format!("spawn xdg-open: {e}"))?;
        return Ok(());
    }
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("write failed: {e}"))
}

fn main() {
    let diagnostics_path = diagnostics::initialize().unwrap_or_else(|error| {
        eprintln!("[diagnostics] initialization failed: {error}");
        std::process::exit(1);
    });
    std::panic::set_hook(Box::new(|info| {
        let _ = diagnostics::record("error", "host.panic", serde_json::json!({ "message": info.to_string() }));
    }));
    if let Err(error) = diagnostics::record(
        "info",
        "host.tauri_build_starting",
        serde_json::json!({ "diagnosticsPath": diagnostics_path }),
    ) {
        eprintln!("[diagnostics] write failed: {error}");
        std::process::exit(1);
    }
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
            record_frontend_diagnostic,
            resolve_workspace_file,
            reveal_in_explorer,
            open_with_dialog,
            list_workspace_tree,
            git_status,
            write_text_file
        ])
        .setup(|app| {
            use tauri::Manager;
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
                let _ = diagnostics::record("info", "host.exit_requested", serde_json::json!({}));
                let state = app.state::<RpcState>();
                let _ = rpc::rpc_kill(state);
            }
        });
}


