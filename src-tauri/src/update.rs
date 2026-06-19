use futures_util::StreamExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Window};
use tokio::io::AsyncWriteExt;

const GITHUB_REPO_URL: &str = "https://github.com/WEP-56/shelly-ssh";
const GITHUB_LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/WEP-56/shelly-ssh/releases/latest";
const UPDATE_PROGRESS_EVENT: &str = "shelly-update-progress";

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    name: String,
    download_url: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    latest_version: String,
    tag_name: String,
    release_name: String,
    release_url: String,
    release_notes: String,
    published_at: Option<String>,
    asset: UpdateAsset,
    available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    path: String,
    file_name: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
    percent: f64,
}

#[tauri::command]
pub fn update_current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn update_check() -> Result<Option<UpdateInfo>, String> {
    let client = github_client()?;
    let release = client
        .get(GITHUB_LATEST_RELEASE_API)
        .send()
        .await
        .map_err(|err| format!("Failed to contact GitHub releases: {err}"))?;
    if release.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !release.status().is_success() {
        return Err(format!(
            "GitHub release check failed with HTTP {}",
            release.status()
        ));
    }
    let release: GitHubRelease = release
        .json()
        .await
        .map_err(|err| format!("Failed to parse GitHub release: {err}"))?;
    let asset = match pick_installer_asset(&release.assets) {
        Some(asset) => asset,
        None => return Ok(None),
    };
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_version = clean_version(&release.tag_name);
    let available = is_newer_version(&latest_version, &current_version);
    if !available {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        current_version,
        latest_version,
        tag_name: release.tag_name.clone(),
        release_name: release.name.unwrap_or_else(|| release.tag_name.clone()),
        release_url: release.html_url,
        release_notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
        asset,
        available,
    }))
}

#[tauri::command]
pub async fn update_download(window: Window, asset: UpdateAsset) -> Result<DownloadedUpdate, String> {
    validate_download_url(&asset.download_url)?;
    validate_installer_name(&asset.name)?;

    let target = update_download_path(&asset.name)?;
    let total = if asset.size > 0 { Some(asset.size) } else { None };
    if target.exists() {
        let size = std::fs::metadata(&target)
            .map_err(|err| format!("Failed to read existing update file: {err}"))?
            .len();
        if total.map_or(size > 0, |expected| size == expected) {
            emit_progress(&window, "finished", size, total)?;
            return Ok(downloaded_update(target, size));
        }
    }

    let partial = target.with_extension(format!(
        "{}.partial",
        target
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ));
    if partial.exists() {
        std::fs::remove_file(&partial)
            .map_err(|err| format!("Failed to clear partial update download: {err}"))?;
    }

    let client = github_client()?;
    let response = client
        .get(&asset.download_url)
        .send()
        .await
        .map_err(|err| format!("Failed to download update: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Update download failed with HTTP {}",
            response.status()
        ));
    }
    let total = response.content_length().or(total);
    emit_progress(&window, "downloading", 0, total)?;

    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|err| format!("Failed to create update file: {err}"))?;
    let mut downloaded = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("Failed while reading update download: {err}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("Failed to write update file: {err}"))?;
        downloaded += chunk.len() as u64;
        emit_progress(&window, "downloading", downloaded, total)?;
    }
    file.flush()
        .await
        .map_err(|err| format!("Failed to flush update file: {err}"))?;
    drop(file);

    if let Some(expected) = total {
        if downloaded != expected {
            let _ = std::fs::remove_file(&partial);
            return Err(format!(
                "Update download size mismatch: expected {expected} bytes, got {downloaded}"
            ));
        }
    }

    if target.exists() {
        std::fs::remove_file(&target)
            .map_err(|err| format!("Failed to replace old update file: {err}"))?;
    }
    std::fs::rename(&partial, &target)
        .map_err(|err| format!("Failed to finalize update download: {err}"))?;
    emit_progress(&window, "finished", downloaded, total)?;
    Ok(downloaded_update(target, downloaded))
}

#[tauri::command]
pub fn update_install_and_exit(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    validate_installer_path(&path)?;
    spawn_installer(&path)?;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(650));
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
pub fn open_github_repository() -> Result<(), String> {
    open_url(GITHUB_REPO_URL)
}

fn github_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("Shelly/{}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|err| format!("Failed to initialize update client: {err}"))
}

fn clean_version(value: &str) -> String {
    value.trim().trim_start_matches('v').to_string()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    match (Version::parse(latest), Version::parse(current)) {
        (Ok(latest), Ok(current)) => latest > current,
        _ => latest != current,
    }
}

fn pick_installer_asset(assets: &[GitHubAsset]) -> Option<UpdateAsset> {
    assets
        .iter()
        .filter_map(|asset| installer_score(&asset.name).map(|score| (score, asset)))
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| UpdateAsset {
            name: asset.name.clone(),
            download_url: asset.browser_download_url.clone(),
            size: asset.size,
        })
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

fn installer_score(name: &str) -> Option<u8> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".sig")
        || lower.ends_with(".zip")
        || lower.ends_with(".tar.gz")
        || lower.ends_with(".tar")
        || lower.ends_with(".gz")
    {
        return None;
    }

    #[cfg(target_os = "windows")]
    {
        if lower.ends_with(".exe") && lower.contains("setup") {
            return Some(50);
        }
        if lower.ends_with(".exe") {
            return Some(45);
        }
        if lower.ends_with(".msi") {
            return Some(40);
        }
        return None;
    }

    #[cfg(target_os = "macos")]
    {
        if lower.ends_with(".dmg") {
            return Some(50);
        }
        return None;
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if lower.ends_with(".appimage") || lower.ends_with(".deb") || lower.ends_with(".rpm") {
            return Some(50);
        }
        None
    }
}

fn validate_download_url(url: &str) -> Result<(), String> {
    if url.starts_with("https://github.com/WEP-56/shelly-ssh/releases/download/") {
        Ok(())
    } else {
        Err("Refusing to download update from an unexpected URL".into())
    }
}

fn validate_installer_name(name: &str) -> Result<(), String> {
    if installer_score(name).is_some() {
        Ok(())
    } else {
        Err("Release asset is not a supported installer for this platform".into())
    }
}

fn update_download_path(file_name: &str) -> Result<PathBuf, String> {
    let safe_name = sanitize_file_name(file_name);
    if safe_name.is_empty() {
        return Err("Release asset file name is invalid".into());
    }
    let dir = std::env::temp_dir().join("shelly-updates");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create update download directory: {err}"))?;
    Ok(dir.join(safe_name))
}

fn sanitize_file_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        .collect()
}

fn downloaded_update(path: PathBuf, size: u64) -> DownloadedUpdate {
    DownloadedUpdate {
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Shelly update")
            .to_string(),
        path: path.to_string_lossy().to_string(),
        size,
    }
}

fn emit_progress(
    window: &Window,
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
) -> Result<(), String> {
    let percent = total
        .filter(|value| *value > 0)
        .map(|value| (downloaded as f64 / value as f64 * 100.0).clamp(0.0, 100.0))
        .unwrap_or(0.0);
    window
        .emit(
            UPDATE_PROGRESS_EVENT,
            UpdateProgress {
                phase,
                downloaded,
                total,
                percent,
            },
        )
        .map_err(|err| format!("Failed to publish update progress: {err}"))
}

fn validate_installer_path(path: &Path) -> Result<(), String> {
    let metadata =
        std::fs::metadata(path).map_err(|err| format!("Failed to read installer file: {err}"))?;
    if !metadata.is_file() {
        return Err("Update installer path is not a file".into());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Update installer file name is invalid".to_string())?;
    validate_installer_name(name)
}

#[cfg(target_os = "windows")]
fn spawn_installer(path: &Path) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let mut command = if extension == "msi" {
        let mut command = Command::new("msiexec.exe");
        command.arg("/i").arg(path);
        command
    } else {
        Command::new(path)
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Failed to start update installer: {err}"))
}

#[cfg(target_os = "macos")]
fn spawn_installer(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Failed to open update package: {err}"))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn spawn_installer(path: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Failed to open update package: {err}"))
}

#[cfg(target_os = "windows")]
fn open_url(url: &str) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Failed to open URL: {err}"))
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Failed to open URL: {err}"))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn open_url(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Failed to open URL: {err}"))
}
