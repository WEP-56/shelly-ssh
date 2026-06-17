use crate::{
    db::Db,
    ssh::{SessionStore, SshConnectionInfo},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use uuid::Uuid;

pub type FileJobStore = Arc<Mutex<HashMap<String, FileJob>>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileJob {
    pub id: String,
    pub device_id: String,
    pub session_id: Option<String>,
    pub kind: FileJobKind,
    pub path: String,
    pub local_path: Option<String>,
    pub status: FileJobStatus,
    pub progress: u8,
    pub message: Option<String>,
    pub entries: Option<Vec<RemoteFileEntry>>,
    pub content: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum FileJobKind {
    ListDir,
    Download,
    Upload,
    Delete,
    Rename,
    Mkdir,
    CreateFile,
    Preview,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum FileJobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn emit_job(app: &AppHandle, job: &FileJob) {
    let _ = app.emit("file-job-updated", job);
}

#[tauri::command]
pub async fn file_queue_list_dir(
    device_id: String,
    session_id: Option<String>,
    path: String,
    jobs: State<'_, FileJobStore>,
    sessions: State<'_, SessionStore>,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let connection = resolve_connection(&device_id, session_id.as_deref(), &sessions, &db).await?;
    let now = now_ms();
    let job = FileJob {
        id: Uuid::new_v4().to_string(),
        device_id,
        session_id,
        kind: FileJobKind::ListDir,
        path: if path.trim().is_empty() {
            ".".into()
        } else {
            path
        },
        local_path: None,
        status: FileJobStatus::Queued,
        progress: 0,
        message: Some("Queued in background worker".into()),
        entries: None,
        content: None,
        created_at: now,
        updated_at: now,
    };

    jobs.lock().await.insert(job.id.clone(), job.clone());
    emit_job(&app, &job);

    let store = jobs.inner().clone();
    let app2 = app.clone();
    let job_id = job.id.clone();
    let list_path = job.path.clone();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            10,
            "Starting SFTP worker",
        )
        .await;

        let canceled = {
            let guard = store.lock().await;
            guard
                .get(&job_id)
                .map(|job| job.status == FileJobStatus::Canceled)
                .unwrap_or(true)
        };
        if canceled {
            return;
        }

        let result =
            tokio::task::spawn_blocking(move || list_dir_blocking(connection, &list_path)).await;
        match result {
            Ok(Ok(entries)) => {
                update_job_with_entries(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Succeeded,
                    100,
                    "Directory loaded",
                    Some(entries),
                )
                .await;
            }
            Ok(Err(err)) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
            }
            Err(err) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Failed,
                    100,
                    &err.to_string(),
                )
                .await;
            }
        }
    });

    Ok(job)
}

#[tauri::command]
pub async fn file_queue_preview(
    device_id: String,
    session_id: Option<String>,
    path: String,
    jobs: State<'_, FileJobStore>,
    sessions: State<'_, SessionStore>,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let connection = resolve_connection(&device_id, session_id.as_deref(), &sessions, &db).await?;
    let now = now_ms();
    let job = FileJob {
        id: Uuid::new_v4().to_string(),
        device_id,
        session_id,
        kind: FileJobKind::Preview,
        path,
        local_path: None,
        status: FileJobStatus::Queued,
        progress: 0,
        message: Some("Queued in background worker".into()),
        entries: None,
        content: None,
        created_at: now,
        updated_at: now,
    };

    jobs.lock().await.insert(job.id.clone(), job.clone());
    emit_job(&app, &job);

    let store = jobs.inner().clone();
    let app2 = app.clone();
    let job_id = job.id.clone();
    let preview_path = job.path.clone();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            20,
            "Reading remote file",
        )
        .await;
        let result =
            tokio::task::spawn_blocking(move || preview_file_blocking(connection, &preview_path))
                .await;
        match result {
            Ok(Ok(content)) => {
                update_job_content(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Succeeded,
                    100,
                    "Preview loaded",
                    Some(content),
                )
                .await;
            }
            Ok(Err(err)) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
            }
            Err(err) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Failed,
                    100,
                    &err.to_string(),
                )
                .await;
            }
        }
    });

    Ok(job)
}

#[tauri::command]
pub async fn file_queue_download(
    device_id: String,
    session_id: Option<String>,
    remote_path: String,
    local_path: String,
    jobs: State<'_, FileJobStore>,
    sessions: State<'_, SessionStore>,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let connection = resolve_connection(&device_id, session_id.as_deref(), &sessions, &db).await?;
    let now = now_ms();
    let job = FileJob {
        id: Uuid::new_v4().to_string(),
        device_id,
        session_id,
        kind: FileJobKind::Download,
        path: remote_path,
        local_path: Some(local_path),
        status: FileJobStatus::Queued,
        progress: 0,
        message: Some("Queued in background worker".into()),
        entries: None,
        content: None,
        created_at: now,
        updated_at: now,
    };

    jobs.lock().await.insert(job.id.clone(), job.clone());
    emit_job(&app, &job);

    let store = jobs.inner().clone();
    let app2 = app.clone();
    let job_id = job.id.clone();
    let remote_path = job.path.clone();
    let local_path = job.local_path.clone().unwrap_or_default();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            15,
            "Downloading remote file",
        )
        .await;
        let result = tokio::task::spawn_blocking(move || {
            download_file_blocking(connection, &remote_path, &local_path)
        })
        .await;
        match result {
            Ok(Ok(())) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Succeeded,
                    100,
                    "Download complete",
                )
                .await;
            }
            Ok(Err(err)) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
            }
            Err(err) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Failed,
                    100,
                    &err.to_string(),
                )
                .await;
            }
        }
    });

    Ok(job)
}

#[tauri::command]
pub async fn file_queue_upload(
    device_id: String,
    session_id: Option<String>,
    local_path: String,
    remote_path: String,
    jobs: State<'_, FileJobStore>,
    sessions: State<'_, SessionStore>,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let connection = resolve_connection(&device_id, session_id.as_deref(), &sessions, &db).await?;
    let now = now_ms();
    let job = FileJob {
        id: Uuid::new_v4().to_string(),
        device_id,
        session_id,
        kind: FileJobKind::Upload,
        path: remote_path,
        local_path: Some(local_path),
        status: FileJobStatus::Queued,
        progress: 0,
        message: Some("Queued in background worker".into()),
        entries: None,
        content: None,
        created_at: now,
        updated_at: now,
    };

    jobs.lock().await.insert(job.id.clone(), job.clone());
    emit_job(&app, &job);

    let store = jobs.inner().clone();
    let app2 = app.clone();
    let job_id = job.id.clone();
    let remote_path = job.path.clone();
    let local_path = job.local_path.clone().unwrap_or_default();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            15,
            "Uploading local file",
        )
        .await;
        let result = tokio::task::spawn_blocking(move || {
            upload_file_blocking(connection, &local_path, &remote_path)
        })
        .await;
        match result {
            Ok(Ok(())) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Succeeded,
                    100,
                    "Upload complete",
                )
                .await;
            }
            Ok(Err(err)) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
            }
            Err(err) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Failed,
                    100,
                    &err.to_string(),
                )
                .await;
            }
        }
    });

    Ok(job)
}

#[tauri::command]
pub async fn file_queue_delete(
    device_id: String,
    session_id: Option<String>,
    path: String,
    is_dir: bool,
    jobs: State<'_, FileJobStore>,
    sessions: State<'_, SessionStore>,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let connection = resolve_connection(&device_id, session_id.as_deref(), &sessions, &db).await?;
    let now = now_ms();
    let job = FileJob {
        id: Uuid::new_v4().to_string(),
        device_id,
        session_id,
        kind: FileJobKind::Delete,
        path,
        local_path: None,
        status: FileJobStatus::Queued,
        progress: 0,
        message: Some("Queued in background worker".into()),
        entries: None,
        content: None,
        created_at: now,
        updated_at: now,
    };

    jobs.lock().await.insert(job.id.clone(), job.clone());
    emit_job(&app, &job);

    let store = jobs.inner().clone();
    let app2 = app.clone();
    let job_id = job.id.clone();
    let delete_path = job.path.clone();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            25,
            "Deleting remote entry",
        )
        .await;
        let result =
            tokio::task::spawn_blocking(move || delete_blocking(connection, &delete_path, is_dir))
                .await;
        match result {
            Ok(Ok(())) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Succeeded,
                    100,
                    "Delete complete",
                )
                .await;
            }
            Ok(Err(err)) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
            }
            Err(err) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Failed,
                    100,
                    &err.to_string(),
                )
                .await;
            }
        }
    });

    Ok(job)
}

#[tauri::command]
pub async fn file_queue_rename(
    device_id: String,
    session_id: Option<String>,
    path: String,
    target_path: String,
    jobs: State<'_, FileJobStore>,
    sessions: State<'_, SessionStore>,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let connection = resolve_connection(&device_id, session_id.as_deref(), &sessions, &db).await?;
    let now = now_ms();
    let job = FileJob {
        id: Uuid::new_v4().to_string(),
        device_id,
        session_id,
        kind: FileJobKind::Rename,
        path,
        local_path: Some(target_path),
        status: FileJobStatus::Queued,
        progress: 0,
        message: Some("Queued in background worker".into()),
        entries: None,
        content: None,
        created_at: now,
        updated_at: now,
    };

    jobs.lock().await.insert(job.id.clone(), job.clone());
    emit_job(&app, &job);

    let store = jobs.inner().clone();
    let app2 = app.clone();
    let job_id = job.id.clone();
    let path = job.path.clone();
    let target_path = job.local_path.clone().unwrap_or_default();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            25,
            "Renaming remote entry",
        )
        .await;
        let result =
            tokio::task::spawn_blocking(move || rename_blocking(connection, &path, &target_path))
                .await;
        match result {
            Ok(Ok(())) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Succeeded,
                    100,
                    "Rename complete",
                )
                .await;
            }
            Ok(Err(err)) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
            }
            Err(err) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Failed,
                    100,
                    &err.to_string(),
                )
                .await;
            }
        }
    });

    Ok(job)
}

#[tauri::command]
pub async fn file_queue_mkdir(
    device_id: String,
    session_id: Option<String>,
    path: String,
    jobs: State<'_, FileJobStore>,
    sessions: State<'_, SessionStore>,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let connection = resolve_connection(&device_id, session_id.as_deref(), &sessions, &db).await?;
    let now = now_ms();
    let job = FileJob {
        id: Uuid::new_v4().to_string(),
        device_id,
        session_id,
        kind: FileJobKind::Mkdir,
        path,
        local_path: None,
        status: FileJobStatus::Queued,
        progress: 0,
        message: Some("Queued in background worker".into()),
        entries: None,
        content: None,
        created_at: now,
        updated_at: now,
    };

    jobs.lock().await.insert(job.id.clone(), job.clone());
    emit_job(&app, &job);

    let store = jobs.inner().clone();
    let app2 = app.clone();
    let job_id = job.id.clone();
    let mkdir_path = job.path.clone();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            25,
            "Creating remote folder",
        )
        .await;
        let result =
            tokio::task::spawn_blocking(move || mkdir_blocking(connection, &mkdir_path)).await;
        match result {
            Ok(Ok(())) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Succeeded,
                    100,
                    "Folder created",
                )
                .await;
            }
            Ok(Err(err)) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
            }
            Err(err) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Failed,
                    100,
                    &err.to_string(),
                )
                .await;
            }
        }
    });

    Ok(job)
}

#[tauri::command]
pub async fn file_queue_create_file(
    device_id: String,
    session_id: Option<String>,
    path: String,
    jobs: State<'_, FileJobStore>,
    sessions: State<'_, SessionStore>,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let connection = resolve_connection(&device_id, session_id.as_deref(), &sessions, &db).await?;
    let now = now_ms();
    let job = FileJob {
        id: Uuid::new_v4().to_string(),
        device_id,
        session_id,
        kind: FileJobKind::CreateFile,
        path,
        local_path: None,
        status: FileJobStatus::Queued,
        progress: 0,
        message: Some("Queued in background worker".into()),
        entries: None,
        content: None,
        created_at: now,
        updated_at: now,
    };

    jobs.lock().await.insert(job.id.clone(), job.clone());
    emit_job(&app, &job);

    let store = jobs.inner().clone();
    let app2 = app.clone();
    let job_id = job.id.clone();
    let file_path = job.path.clone();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            25,
            "Creating remote file",
        )
        .await;
        let result =
            tokio::task::spawn_blocking(move || create_file_blocking(connection, &file_path)).await;
        match result {
            Ok(Ok(())) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Succeeded,
                    100,
                    "File created",
                )
                .await;
            }
            Ok(Err(err)) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
            }
            Err(err) => {
                update_job(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Failed,
                    100,
                    &err.to_string(),
                )
                .await;
            }
        }
    });

    Ok(job)
}

#[tauri::command]
pub async fn file_list_jobs(
    device_id: Option<String>,
    jobs: State<'_, FileJobStore>,
) -> Result<Vec<FileJob>, String> {
    let mut list: Vec<FileJob> = jobs
        .lock()
        .await
        .values()
        .filter(|job| {
            device_id
                .as_ref()
                .map(|id| &job.device_id == id)
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(list)
}

#[tauri::command]
pub async fn file_cancel_job(
    job_id: String,
    jobs: State<'_, FileJobStore>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let mut guard = jobs.lock().await;
    let job = guard
        .get_mut(&job_id)
        .ok_or_else(|| "file job not found".to_string())?;
    job.status = FileJobStatus::Canceled;
    job.progress = 100;
    job.message = Some("Canceled".into());
    job.entries = None;
    job.content = None;
    job.updated_at = now_ms();
    let job = job.clone();
    drop(guard);
    emit_job(&app, &job);
    Ok(job)
}

async fn update_job(
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
    status: FileJobStatus,
    progress: u8,
    message: &str,
) {
    let mut guard = store.lock().await;
    let Some(job) = guard.get_mut(job_id) else {
        return;
    };
    if job.status == FileJobStatus::Canceled {
        return;
    }
    job.status = status;
    job.progress = progress;
    job.message = Some(message.into());
    job.entries = None;
    job.content = None;
    job.updated_at = now_ms();
    let job = job.clone();
    drop(guard);
    emit_job(app, &job);
}

async fn update_job_with_entries(
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
    status: FileJobStatus,
    progress: u8,
    message: &str,
    entries: Option<Vec<RemoteFileEntry>>,
) {
    let mut guard = store.lock().await;
    let Some(job) = guard.get_mut(job_id) else {
        return;
    };
    if job.status == FileJobStatus::Canceled {
        return;
    }
    job.status = status;
    job.progress = progress;
    job.message = Some(message.into());
    job.entries = entries;
    job.content = None;
    job.updated_at = now_ms();
    let job = job.clone();
    drop(guard);
    emit_job(app, &job);
}

async fn update_job_content(
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
    status: FileJobStatus,
    progress: u8,
    message: &str,
    content: Option<String>,
) {
    let mut guard = store.lock().await;
    let Some(job) = guard.get_mut(job_id) else {
        return;
    };
    if job.status == FileJobStatus::Canceled {
        return;
    }
    job.status = status;
    job.progress = progress;
    job.message = Some(message.into());
    job.entries = None;
    job.content = content;
    job.updated_at = now_ms();
    let job = job.clone();
    drop(guard);
    emit_job(app, &job);
}

async fn resolve_connection(
    device_id: &str,
    session_id: Option<&str>,
    sessions: &State<'_, SessionStore>,
    db: &State<'_, Db>,
) -> Result<SshConnectionInfo, String> {
    if let Some(session_id) = session_id {
        if let Some(session) = sessions.lock().await.get(session_id) {
            return Ok(session.connection.clone());
        }
    }

    let device = db.device(device_id)?;
    if !device.remember_password {
        return Err("Remote files need an active session or a remembered password".into());
    }
    let password = db.device_password(device_id, Some(&device))?.ok_or_else(|| {
        "Saved password is missing. Reconnect this device once with remember password enabled."
            .to_string()
    })?;
    Ok(SshConnectionInfo {
        host: device.host,
        port: device.port,
        username: device.username,
        password,
    })
}

fn list_dir_blocking(
    connection: SshConnectionInfo,
    path: &str,
) -> Result<Vec<RemoteFileEntry>, String> {
    let (_session, sftp) = connect_sftp(connection)?;
    let mut entries: Vec<RemoteFileEntry> = sftp
        .readdir(Path::new(path))
        .map_err(|e| format!("failed to read directory: {e}"))?
        .into_iter()
        .filter_map(|(entry_path, stat)| {
            let name = entry_path.file_name()?.to_string_lossy().to_string();
            if name == "." || name == ".." {
                return None;
            }
            Some(RemoteFileEntry {
                name,
                path: entry_path.to_string_lossy().replace('\\', "/"),
                is_dir: stat.is_dir(),
                size: stat.size,
                modified_at: stat.mtime,
                permissions: stat.perm,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn preview_file_blocking(connection: SshConnectionInfo, path: &str) -> Result<String, String> {
    const MAX_PREVIEW_BYTES: u64 = 512 * 1024;
    let (_session, sftp) = connect_sftp(connection)?;
    let stat = sftp
        .stat(Path::new(path))
        .map_err(|e| format!("failed to stat remote file: {e}"))?;
    if stat.is_dir() {
        return Err("Cannot preview a directory".into());
    }
    if stat.size.unwrap_or(0) > MAX_PREVIEW_BYTES {
        return Err("File is too large for preview".into());
    }

    let mut remote = sftp
        .open(Path::new(path))
        .map_err(|e| format!("failed to open remote file: {e}"))?;
    let mut buf = Vec::new();
    remote
        .read_to_end(&mut buf)
        .map_err(|e| format!("failed to read remote file: {e}"))?;
    if buf.iter().any(|byte| *byte == 0) {
        return Err("Binary files cannot be previewed yet".into());
    }
    String::from_utf8(buf).map_err(|_| "File is not valid UTF-8 text".to_string())
}

fn download_file_blocking(
    connection: SshConnectionInfo,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    if local_path.trim().is_empty() {
        return Err("Local path is required".into());
    }
    let (_session, sftp) = connect_sftp(connection)?;
    let mut remote = sftp
        .open(Path::new(remote_path))
        .map_err(|e| format!("failed to open remote file: {e}"))?;
    let local = Path::new(local_path);
    if let Some(parent) = local.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create local directory: {e}"))?;
        }
    }
    let mut file = File::create(local).map_err(|e| format!("failed to create local file: {e}"))?;
    std::io::copy(&mut remote, &mut file)
        .map_err(|e| format!("failed to write local file: {e}"))?;
    Ok(())
}

fn upload_file_blocking(
    connection: SshConnectionInfo,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    if local_path.trim().is_empty() || remote_path.trim().is_empty() {
        return Err("Local path and remote path are required".into());
    }
    let (_session, sftp) = connect_sftp(connection)?;
    let mut file =
        File::open(Path::new(local_path)).map_err(|e| format!("failed to open local file: {e}"))?;
    let mut remote = sftp
        .create(Path::new(remote_path))
        .map_err(|e| format!("failed to create remote file: {e}"))?;
    std::io::copy(&mut file, &mut remote)
        .map_err(|e| format!("failed to upload remote file: {e}"))?;
    remote
        .flush()
        .map_err(|e| format!("failed to flush remote file: {e}"))?;
    Ok(())
}

fn delete_blocking(connection: SshConnectionInfo, path: &str, is_dir: bool) -> Result<(), String> {
    let (_session, sftp) = connect_sftp(connection)?;
    if is_dir {
        sftp.rmdir(Path::new(path))
            .map_err(|e| format!("failed to delete remote directory: {e}"))?;
    } else {
        sftp.unlink(Path::new(path))
            .map_err(|e| format!("failed to delete remote file: {e}"))?;
    }
    Ok(())
}

fn rename_blocking(
    connection: SshConnectionInfo,
    path: &str,
    target_path: &str,
) -> Result<(), String> {
    if target_path.trim().is_empty() {
        return Err("Target path is required".into());
    }
    let (_session, sftp) = connect_sftp(connection)?;
    sftp.rename(Path::new(path), Path::new(target_path), None)
        .map_err(|e| format!("failed to rename remote entry: {e}"))?;
    Ok(())
}

fn mkdir_blocking(connection: SshConnectionInfo, path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Folder path is required".into());
    }
    let (_session, sftp) = connect_sftp(connection)?;
    sftp.mkdir(Path::new(path), 0o755)
        .map_err(|e| format!("failed to create remote folder: {e}"))?;
    Ok(())
}

fn create_file_blocking(connection: SshConnectionInfo, path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("File path is required".into());
    }
    let (_session, sftp) = connect_sftp(connection)?;
    let mut remote = sftp
        .create(Path::new(path))
        .map_err(|e| format!("failed to create remote file: {e}"))?;
    remote
        .flush()
        .map_err(|e| format!("failed to flush remote file: {e}"))?;
    Ok(())
}

fn connect_sftp(connection: SshConnectionInfo) -> Result<(ssh2::Session, ssh2::Sftp), String> {
    let tcp = TcpStream::connect((connection.host.as_str(), connection.port))
        .map_err(|e| format!("failed to connect for SFTP: {e}"))?;
    let mut session = ssh2::Session::new().map_err(|e| e.to_string())?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {e}"))?;
    session
        .userauth_password(&connection.username, &connection.password)
        .map_err(|e| format!("SSH authentication failed: {e}"))?;
    if !session.authenticated() {
        return Err("SSH authentication failed".into());
    }

    let sftp = session
        .sftp()
        .map_err(|e| format!("failed to start SFTP: {e}"))?;
    Ok((session, sftp))
}
