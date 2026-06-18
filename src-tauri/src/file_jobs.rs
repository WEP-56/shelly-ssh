use crate::ssh::{SessionStore, SshSharedHandle};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;

pub type FileJobStore = Arc<Mutex<HashMap<String, FileJob>>>;
pub type SftpTransferLimiter = Arc<Semaphore>;
pub const SFTP_MAX_CONCURRENT_TRANSFERS: usize = 3;
const RUSSH_SFTP_OPEN_TIMEOUT_SECS: u64 = 15;

#[derive(Clone)]
enum SftpAccess {
    Russh {
        handle: SshSharedHandle,
    },
}

#[derive(Clone, Copy)]
enum UploadConflictPolicy {
    Overwrite,
    Skip,
    Fail,
}

impl UploadConflictPolicy {
    fn from_input(value: Option<String>) -> Self {
        match value.as_deref() {
            Some("skip") => Self::Skip,
            Some("fail") => Self::Fail,
            _ => Self::Overwrite,
        }
    }
}

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
    pub failed_entries: Option<Vec<FileJobFailure>>,
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
pub struct FileJobFailure {
    pub local_path: String,
    pub remote_path: String,
    pub message: String,
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
    app: AppHandle,
) -> Result<FileJob, String> {
    let access = resolve_access(session_id.as_deref(), &sessions).await?;
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
        failed_entries: None,
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

        let result = list_dir(access, &list_path).await;
        match result {
            Ok(entries) => {
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
            Err(err) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
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
    app: AppHandle,
) -> Result<FileJob, String> {
    let access = resolve_access(session_id.as_deref(), &sessions).await?;
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
        failed_entries: None,
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
        let result = preview_file(access, &preview_path).await;
        match result {
            Ok(content) => {
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
            Err(err) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
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
    transfer_limiter: State<'_, SftpTransferLimiter>,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let access = resolve_access(session_id.as_deref(), &sessions).await?;
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
        failed_entries: None,
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
    let limiter = transfer_limiter.inner().clone();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            5,
            "Waiting for SFTP transfer slot",
        )
        .await;
        let Ok(_permit) = limiter.acquire_owned().await else {
            update_job(
                &store,
                &app2,
                &job_id,
                FileJobStatus::Failed,
                100,
                "SFTP transfer limiter closed",
            )
            .await;
            return;
        };
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            15,
            "Downloading remote file",
        )
        .await;
        if is_job_canceled(&store, &job_id).await {
            return;
        }
        let result =
            download_file_tracked(access, &remote_path, &local_path, &store, &app2, &job_id).await;
        match result {
            Ok(()) => {
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
            Err(err) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
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
    conflict_policy: Option<String>,
    jobs: State<'_, FileJobStore>,
    transfer_limiter: State<'_, SftpTransferLimiter>,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> Result<FileJob, String> {
    let access = resolve_access(session_id.as_deref(), &sessions).await?;
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
        failed_entries: None,
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
    let conflict_policy = UploadConflictPolicy::from_input(conflict_policy);
    let limiter = transfer_limiter.inner().clone();
    tokio::spawn(async move {
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            5,
            "Waiting for SFTP transfer slot",
        )
        .await;
        let Ok(_permit) = limiter.acquire_owned().await else {
            update_job(
                &store,
                &app2,
                &job_id,
                FileJobStatus::Failed,
                100,
                "SFTP transfer limiter closed",
            )
            .await;
            return;
        };
        update_job(
            &store,
            &app2,
            &job_id,
            FileJobStatus::Running,
            15,
            "Uploading local file",
        )
        .await;
        if is_job_canceled(&store, &job_id).await {
            return;
        }
        let result =
            upload_file_tracked(access, &local_path, &remote_path, conflict_policy, &store, &app2, &job_id).await;
        match result {
            Ok(failures) if failures.is_empty() => {
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
            Ok(failures) => {
                let sample = failures
                    .iter()
                    .take(3)
                    .map(|failure| format!("{}: {}", failure.local_path, failure.message))
                    .collect::<Vec<_>>()
                    .join("; ");
                let message = format!(
                    "Folder upload completed with {} failed entries: {}",
                    failures.len(),
                    sample
                );
                update_job_with_failures(
                    &store,
                    &app2,
                    &job_id,
                    FileJobStatus::Failed,
                    100,
                    &message,
                    failures,
                )
                .await;
            }
            Err(err) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
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
    app: AppHandle,
) -> Result<FileJob, String> {
    let access = resolve_access(session_id.as_deref(), &sessions).await?;
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
        failed_entries: None,
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
        let result = delete_entry(access, &delete_path, is_dir).await;
        match result {
            Ok(()) => {
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
            Err(err) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
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
    app: AppHandle,
) -> Result<FileJob, String> {
    let access = resolve_access(session_id.as_deref(), &sessions).await?;
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
        failed_entries: None,
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
        let result = rename_entry(access, &path, &target_path).await;
        match result {
            Ok(()) => {
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
            Err(err) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
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
    app: AppHandle,
) -> Result<FileJob, String> {
    let access = resolve_access(session_id.as_deref(), &sessions).await?;
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
        failed_entries: None,
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
        let result = mkdir_entry(access, &mkdir_path).await;
        match result {
            Ok(()) => {
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
            Err(err) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
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
    app: AppHandle,
) -> Result<FileJob, String> {
    let access = resolve_access(session_id.as_deref(), &sessions).await?;
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
        failed_entries: None,
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
        let result = create_file_entry(access, &file_path).await;
        match result {
            Ok(()) => {
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
            Err(err) => {
                update_job(&store, &app2, &job_id, FileJobStatus::Failed, 100, &err).await;
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
    job.failed_entries = None;
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
    job.failed_entries = None;
    job.updated_at = now_ms();
    let job = job.clone();
    drop(guard);
    emit_job(app, &job);
}

async fn is_job_canceled(store: &FileJobStore, job_id: &str) -> bool {
    store
        .lock()
        .await
        .get(job_id)
        .map(|job| job.status == FileJobStatus::Canceled)
        .unwrap_or(true)
}

fn transfer_progress(base: u8, transferred: u64, total: u64) -> u8 {
    if total == 0 {
        return base;
    }
    let span = 99u64.saturating_sub(base as u64);
    (base as u64 + transferred.saturating_mul(span) / total)
        .min(99)
        .max(base as u64) as u8
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
    job.failed_entries = None;
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
    job.failed_entries = None;
    job.updated_at = now_ms();
    let job = job.clone();
    drop(guard);
    emit_job(app, &job);
}

async fn update_job_with_failures(
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
    status: FileJobStatus,
    progress: u8,
    message: &str,
    failures: Vec<FileJobFailure>,
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
    job.failed_entries = Some(failures);
    job.updated_at = now_ms();
    let job = job.clone();
    drop(guard);
    emit_job(app, &job);
}

async fn resolve_access(
    session_id: Option<&str>,
    sessions: &State<'_, SessionStore>,
) -> Result<SftpAccess, String> {
    if let Some(session_id) = session_id {
        if let Some(session) = sessions.lock().await.get(session_id) {
            return Ok(SftpAccess::Russh {
                handle: session.handle.clone(),
            });
        }
    }

    Err("Remote files require an active SSH session. Connect the device first.".into())
}

async fn list_dir(access: SftpAccess, path: &str) -> Result<Vec<RemoteFileEntry>, String> {
    match access {
        SftpAccess::Russh { handle } => list_dir_russh(handle, path).await,
    }
}

async fn preview_file(access: SftpAccess, path: &str) -> Result<String, String> {
    match access {
        SftpAccess::Russh { handle } => preview_file_russh(handle, path).await,
    }
}

async fn download_file_tracked(
    access: SftpAccess,
    remote_path: &str,
    local_path: &str,
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
) -> Result<(), String> {
    match access {
        SftpAccess::Russh { handle } => {
            download_file_russh_tracked(handle, remote_path, local_path, store, app, job_id).await
        }
    }
}

async fn upload_file_tracked(
    access: SftpAccess,
    local_path: &str,
    remote_path: &str,
    conflict_policy: UploadConflictPolicy,
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
) -> Result<Vec<FileJobFailure>, String> {
    match access {
        SftpAccess::Russh { handle } => {
            upload_file_russh_tracked(handle, local_path, remote_path, conflict_policy, store, app, job_id).await
        }
    }
}

async fn delete_entry(access: SftpAccess, path: &str, is_dir: bool) -> Result<(), String> {
    match access {
        SftpAccess::Russh { handle } => delete_russh(handle, path, is_dir).await,
    }
}

async fn rename_entry(access: SftpAccess, path: &str, target_path: &str) -> Result<(), String> {
    match access {
        SftpAccess::Russh { handle } => rename_russh(handle, path, target_path).await,
    }
}

async fn mkdir_entry(access: SftpAccess, path: &str) -> Result<(), String> {
    match access {
        SftpAccess::Russh { handle } => mkdir_russh(handle, path).await,
    }
}

async fn create_file_entry(access: SftpAccess, path: &str) -> Result<(), String> {
    match access {
        SftpAccess::Russh { handle } => create_file_russh(handle, path).await,
    }
}

async fn open_russh_sftp(
    handle: SshSharedHandle,
) -> Result<russh_sftp::client::SftpSession, String> {
    tokio::time::timeout(Duration::from_secs(RUSSH_SFTP_OPEN_TIMEOUT_SECS), async {
        let channel = {
            let h = handle.lock().await;
            h.channel_open_session()
                .await
                .map_err(|e| format!("failed to open SFTP channel: {e}"))?
        };
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("failed to start SFTP subsystem: {e}"))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("failed to initialize SFTP: {e}"))?;
        sftp.set_timeout(RUSSH_SFTP_OPEN_TIMEOUT_SECS);
        Ok(sftp)
    })
    .await
    .map_err(|_| format!("SFTP subsystem timed out after {RUSSH_SFTP_OPEN_TIMEOUT_SECS}s"))?
}

async fn list_dir_russh(
    handle: SshSharedHandle,
    path: &str,
) -> Result<Vec<RemoteFileEntry>, String> {
    let sftp = open_russh_sftp(handle).await?;
    let entries = sftp
        .read_dir(path)
        .await
        .map_err(|e| format!("failed to read directory: {e}"))?;
    let mut entries: Vec<RemoteFileEntry> = entries
        .map(|entry| {
            let name = entry.file_name();
            let meta = entry.metadata();
            RemoteFileEntry {
                path: join_remote_path(path, &name),
                name,
                is_dir: entry.file_type().is_dir(),
                size: meta.size,
                modified_at: meta.mtime.map(u64::from),
                permissions: meta.permissions,
            }
        })
        .filter(|entry| entry.name != "." && entry.name != "..")
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

async fn preview_file_russh(handle: SshSharedHandle, path: &str) -> Result<String, String> {
    const MAX_PREVIEW_BYTES: u64 = 512 * 1024;
    let sftp = open_russh_sftp(handle).await?;
    let meta = sftp
        .metadata(path)
        .await
        .map_err(|e| format!("failed to stat remote file: {e}"))?;
    if meta.is_dir() {
        return Err("Cannot preview a directory".into());
    }
    if meta.size.unwrap_or(0) > MAX_PREVIEW_BYTES {
        return Err("File is too large for preview".into());
    }

    let buf = sftp
        .read(path)
        .await
        .map_err(|e| format!("failed to read remote file: {e}"))?;
    if buf.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("File is too large for preview".into());
    }
    if buf.iter().any(|byte| *byte == 0) {
        return Err("Binary files cannot be previewed yet".into());
    }
    String::from_utf8(buf).map_err(|_| "File is not valid UTF-8 text".to_string())
}

async fn download_file_russh_tracked(
    handle: SshSharedHandle,
    remote_path: &str,
    local_path: &str,
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
) -> Result<(), String> {
    if local_path.trim().is_empty() {
        return Err("Local path is required".into());
    }
    let sftp = open_russh_sftp(handle).await?;
    let meta = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| format!("failed to stat remote file: {e}"))?;
    if meta.is_dir() {
        return download_dir_russh_tracked(
            &sftp,
            remote_path,
            Path::new(local_path),
            store,
            app,
            job_id,
        )
        .await;
    }
    let total = meta.size.unwrap_or(0);
    let mut remote = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("failed to open remote file: {e}"))?;
    let local = Path::new(local_path);
    if let Some(parent) = local.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("failed to create local directory: {e}"))?;
        }
    }

    let file_name = local
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid local path".to_string())?;
    let tmp_path = local.with_file_name(format!("{file_name}.part"));
    let result: Result<(), String> = async {
        let mut file = tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| format!("failed to create local file: {e}"))?;
        let mut transferred = 0u64;
        let mut last_progress = 15u8;
        let mut buf = vec![0u8; 32768];
        loop {
            if is_job_canceled(store, job_id).await {
                return Err("Canceled".into());
            }
            let n = remote
                .read(&mut buf)
                .await
                .map_err(|e| format!("failed to read remote file: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .await
                .map_err(|e| format!("failed to write local file: {e}"))?;
            transferred += n as u64;
            let progress = transfer_progress(15, transferred, total);
            if progress > last_progress {
                last_progress = progress;
                let msg = if total > 0 {
                    format!("Downloading remote file ({transferred}/{total} bytes)")
                } else {
                    format!("Downloading remote file ({transferred} bytes)")
                };
                update_job(store, app, job_id, FileJobStatus::Running, progress, &msg).await;
            }
        }
        let _ = remote.shutdown().await;
        file.shutdown()
            .await
            .map_err(|e| format!("failed to flush local file: {e}"))?;
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            let _ = tokio::fs::remove_file(local).await;
            tokio::fs::rename(&tmp_path, local)
                .await
                .map_err(|e| format!("failed to finalize local file: {e}"))
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            Err(err)
        }
    }
}

async fn download_dir_russh_tracked(
    sftp: &russh_sftp::client::SftpSession,
    remote_root: &str,
    local_root: &Path,
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
) -> Result<(), String> {
    tokio::fs::create_dir_all(local_root)
        .await
        .map_err(|e| format!("failed to create local directory: {e}"))?;
    let mut stack = vec![(
        remote_root.trim_end_matches('/').to_string(),
        local_root.to_path_buf(),
    )];
    let mut files_done = 0u64;
    while let Some((remote_dir, local_dir)) = stack.pop() {
        if is_job_canceled(store, job_id).await {
            return Err("Canceled".into());
        }
        tokio::fs::create_dir_all(&local_dir)
            .await
            .map_err(|e| format!("failed to create local directory: {e}"))?;
        let entries = sftp
            .read_dir(&remote_dir)
            .await
            .map_err(|e| format!("failed to read remote directory: {e}"))?;
        for entry in entries {
            let name = entry.file_name();
            let remote_path = join_remote_path(&remote_dir, &name);
            let local_path = local_dir.join(&name);
            if entry.file_type().is_dir() {
                stack.push((remote_path, local_path));
            } else {
                download_one_file_russh(sftp, &remote_path, &local_path).await?;
                files_done += 1;
                update_job(
                    store,
                    app,
                    job_id,
                    FileJobStatus::Running,
                    50,
                    &format!("Downloading folder ({files_done} files)"),
                )
                .await;
            }
        }
    }
    Ok(())
}

async fn download_one_file_russh(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create local directory: {e}"))?;
    }
    let mut remote = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("failed to open remote file: {e}"))?;
    let file_name = local_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid local path".to_string())?;
    let tmp_path = local_path.with_file_name(format!("{file_name}.part"));
    let result: Result<(), String> = async {
        let mut file = tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| format!("failed to create local file: {e}"))?;
        let mut buf = vec![0u8; 32768];
        loop {
            let n = remote
                .read(&mut buf)
                .await
                .map_err(|e| format!("failed to read remote file: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .await
                .map_err(|e| format!("failed to write local file: {e}"))?;
        }
        let _ = remote.shutdown().await;
        file.shutdown()
            .await
            .map_err(|e| format!("failed to flush local file: {e}"))?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            let _ = tokio::fs::remove_file(local_path).await;
            tokio::fs::rename(&tmp_path, local_path)
                .await
                .map_err(|e| format!("failed to finalize local file: {e}"))
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            Err(err)
        }
    }
}

async fn upload_file_russh_tracked(
    handle: SshSharedHandle,
    local_path: &str,
    remote_path: &str,
    conflict_policy: UploadConflictPolicy,
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
) -> Result<Vec<FileJobFailure>, String> {
    if local_path.trim().is_empty() || remote_path.trim().is_empty() {
        return Err("Local path and remote path are required".into());
    }
    let local_meta = tokio::fs::symlink_metadata(Path::new(local_path))
        .await
        .map_err(|e| format!("failed to stat local path: {e}"))?;
    let sftp = open_russh_sftp(handle).await?;
    if local_meta.is_dir() {
        return upload_dir_russh_tracked(
            &sftp,
            Path::new(local_path),
            remote_path,
            conflict_policy,
            store,
            app,
            job_id,
        )
        .await;
    }
    if local_meta.file_type().is_symlink() {
        upload_symlink_russh(&sftp, Path::new(local_path), remote_path, conflict_policy).await?;
        return Ok(Vec::new());
    }
    let total = local_meta.len();
    let mut file = tokio::fs::File::open(Path::new(local_path))
        .await
        .map_err(|e| format!("failed to open local file: {e}"))?;
    let tmp_remote_path = remote_part_path(remote_path);
    match check_remote_conflict(&sftp, remote_path, conflict_policy).await? {
        ConflictDecision::Proceed => {}
        ConflictDecision::Skip => return Ok(Vec::new()),
    }
    let mut remote = sftp
        .create(&tmp_remote_path)
        .await
        .map_err(|e| format!("failed to create remote file: {e}"))?;

    let result: Result<(), String> = async {
        let mut transferred = 0u64;
        let mut last_progress = 15u8;
        let mut buf = vec![0u8; 32768];
        loop {
            if is_job_canceled(store, job_id).await {
                let _ = remote.shutdown().await;
                return Err("Canceled".into());
            }
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| format!("failed to read local file: {e}"))?;
            if n == 0 {
                break;
            }
            remote
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("failed to upload remote file: {e}"))?;
            transferred += n as u64;
            let progress = transfer_progress(15, transferred, total);
            if progress > last_progress {
                last_progress = progress;
                let msg = if total > 0 {
                    format!("Uploading local file ({transferred}/{total} bytes)")
                } else {
                    format!("Uploading local file ({transferred} bytes)")
                };
                update_job(store, app, job_id, FileJobStatus::Running, progress, &msg).await;
            }
        }
        remote
            .shutdown()
            .await
            .map_err(|e| format!("failed to flush remote file: {e}"))?;
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            let _ = sftp.remove_file(remote_path).await;
            sftp.rename(&tmp_remote_path, remote_path)
                .await
                .map_err(|e| format!("failed to finalize remote file: {e}"))?;
            preserve_remote_metadata(&sftp, remote_path, &local_meta).await;
            Ok(Vec::new())
        }
        Err(err) => {
            let _ = sftp.remove_file(&tmp_remote_path).await;
            Err(err)
        }
    }
}

async fn upload_dir_russh_tracked(
    sftp: &russh_sftp::client::SftpSession,
    local_root: &Path,
    remote_root: &str,
    conflict_policy: UploadConflictPolicy,
    store: &FileJobStore,
    app: &AppHandle,
    job_id: &str,
) -> Result<Vec<FileJobFailure>, String> {
    create_remote_dir_if_missing(sftp, remote_root).await?;
    let mut stack = vec![(local_root.to_path_buf(), remote_root.trim_end_matches('/').to_string())];
    let mut files_done = 0u64;
    let mut failures = Vec::new();
    while let Some((local_dir, remote_dir)) = stack.pop() {
        if is_job_canceled(store, job_id).await {
            return Err("Canceled".into());
        }
        let mut entries = tokio::fs::read_dir(&local_dir)
            .await
            .map_err(|e| format!("failed to read local directory {}: {e}", local_dir.display()))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| format!("failed to read local directory entry: {e}"))?
        {
            let local_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let remote_path = join_remote_path(&remote_dir, &name);
            let meta = tokio::fs::symlink_metadata(&local_path)
                .await
                .map_err(|e| format!("failed to stat local path {}: {e}", local_path.display()))?;
            let result = if meta.is_dir() {
                create_remote_dir_if_missing(sftp, &remote_path).await?;
                preserve_remote_metadata(sftp, &remote_path, &meta).await;
                stack.push((local_path.clone(), remote_path.clone()));
                Ok(())
            } else if meta.file_type().is_symlink() {
                upload_symlink_russh(sftp, &local_path, &remote_path, conflict_policy).await
            } else {
                upload_one_file_russh(sftp, &local_path, &remote_path, &meta, conflict_policy).await
            };
            if let Err(err) = result {
                failures.push(FileJobFailure {
                    local_path: local_path.display().to_string(),
                    remote_path: remote_path.clone(),
                    message: err,
                });
            } else if !meta.is_dir() {
                files_done += 1;
                update_job(
                    store,
                    app,
                    job_id,
                    FileJobStatus::Running,
                    50,
                    &format!("Uploading folder ({files_done} entries)"),
                )
                .await;
            }
        }
    }
    Ok(failures)
}

async fn upload_one_file_russh(
    sftp: &russh_sftp::client::SftpSession,
    local_path: &Path,
    remote_path: &str,
    meta: &std::fs::Metadata,
    conflict_policy: UploadConflictPolicy,
) -> Result<(), String> {
    match check_remote_conflict(sftp, remote_path, conflict_policy).await? {
        ConflictDecision::Proceed => {}
        ConflictDecision::Skip => return Ok(()),
    }
    let mut file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("failed to open local file: {e}"))?;
    let tmp_remote_path = remote_part_path(remote_path);
    let mut remote = sftp
        .create(&tmp_remote_path)
        .await
        .map_err(|e| format!("failed to create remote file: {e}"))?;
    let result: Result<(), String> = async {
        let mut buf = vec![0u8; 32768];
        loop {
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| format!("failed to read local file: {e}"))?;
            if n == 0 {
                break;
            }
            remote
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("failed to upload remote file: {e}"))?;
        }
        remote
            .shutdown()
            .await
            .map_err(|e| format!("failed to flush remote file: {e}"))?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            let _ = sftp.remove_file(remote_path).await;
            sftp.rename(&tmp_remote_path, remote_path)
                .await
                .map_err(|e| format!("failed to finalize remote file: {e}"))?;
            preserve_remote_metadata(sftp, remote_path, meta).await;
            Ok(())
        }
        Err(err) => {
            let _ = sftp.remove_file(&tmp_remote_path).await;
            Err(err)
        }
    }
}

async fn upload_symlink_russh(
    sftp: &russh_sftp::client::SftpSession,
    local_path: &Path,
    remote_path: &str,
    conflict_policy: UploadConflictPolicy,
) -> Result<(), String> {
    match check_remote_conflict(sftp, remote_path, conflict_policy).await? {
        ConflictDecision::Proceed => {}
        ConflictDecision::Skip => return Ok(()),
    }
    let target = tokio::fs::read_link(local_path)
        .await
        .map_err(|e| format!("failed to read local symlink: {e}"))?;
    let target = target.to_string_lossy().to_string();
    let _ = sftp.remove_file(remote_path).await;
    sftp.symlink(remote_path, target)
        .await
        .map_err(|e| format!("failed to create remote symlink: {e}"))
}

enum ConflictDecision {
    Proceed,
    Skip,
}

async fn check_remote_conflict(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    policy: UploadConflictPolicy,
) -> Result<ConflictDecision, String> {
    match sftp.metadata(remote_path).await {
        Ok(_) => match policy {
            UploadConflictPolicy::Overwrite => Ok(ConflictDecision::Proceed),
            UploadConflictPolicy::Skip => Ok(ConflictDecision::Skip),
            UploadConflictPolicy::Fail => {
                Err(format!("remote path already exists: {remote_path}"))
            }
        },
        Err(_) => Ok(ConflictDecision::Proceed),
    }
}

async fn create_remote_dir_if_missing(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
) -> Result<(), String> {
    match sftp.create_dir(remote_path).await {
        Ok(()) => Ok(()),
        Err(_) => {
            let meta = sftp
                .metadata(remote_path)
                .await
                .map_err(|e| format!("failed to create remote directory: {e}"))?;
            if meta.is_dir() {
                Ok(())
            } else {
                Err("remote path exists and is not a directory".into())
            }
        }
    }
}

async fn preserve_remote_metadata(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    meta: &std::fs::Metadata,
) {
    let attrs = russh_sftp::protocol::FileAttributes::from(meta);
    let _ = sftp.set_metadata(remote_path, attrs).await;
}

async fn delete_russh(handle: SshSharedHandle, path: &str, is_dir: bool) -> Result<(), String> {
    let sftp = open_russh_sftp(handle).await?;
    if is_dir {
        remove_dir_all_russh(&sftp, path).await
    } else {
        sftp.remove_file(path)
            .await
            .map_err(|e| format!("failed to delete remote file: {e}"))
    }
}

async fn remove_dir_all_russh(
    sftp: &russh_sftp::client::SftpSession,
    root: &str,
) -> Result<(), String> {
    let mut stack = vec![root.trim_end_matches('/').to_string()];
    let mut dirs = Vec::new();
    while let Some(dir) = stack.pop() {
        dirs.push(dir.clone());
        let entries = sftp
            .read_dir(&dir)
            .await
            .map_err(|e| format!("failed to read remote directory before delete: {e}"))?;
        for entry in entries {
            let path = join_remote_path(&dir, &entry.file_name());
            if entry.file_type().is_dir() {
                stack.push(path);
            } else {
                sftp.remove_file(&path)
                    .await
                    .map_err(|e| format!("failed to delete remote file: {e}"))?;
            }
        }
    }
    for dir in dirs.iter().rev() {
        sftp.remove_dir(dir)
            .await
            .map_err(|e| format!("failed to delete remote directory: {e}"))?;
    }
    Ok(())
}

async fn rename_russh(
    handle: SshSharedHandle,
    path: &str,
    target_path: &str,
) -> Result<(), String> {
    if target_path.trim().is_empty() {
        return Err("Target path is required".into());
    }
    let sftp = open_russh_sftp(handle).await?;
    sftp.rename(path, target_path)
        .await
        .map_err(|e| format!("failed to rename remote entry: {e}"))
}

async fn mkdir_russh(handle: SshSharedHandle, path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Folder path is required".into());
    }
    let sftp = open_russh_sftp(handle).await?;
    sftp.create_dir(path)
        .await
        .map_err(|e| format!("failed to create remote folder: {e}"))
}

async fn create_file_russh(handle: SshSharedHandle, path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("File path is required".into());
    }
    let sftp = open_russh_sftp(handle).await?;
    let mut remote = sftp
        .create(path)
        .await
        .map_err(|e| format!("failed to create remote file: {e}"))?;
    remote
        .shutdown()
        .await
        .map_err(|e| format!("failed to flush remote file: {e}"))
}

fn join_remote_path(dir: &str, name: &str) -> String {
    let dir = if dir.trim().is_empty() { "." } else { dir };
    if dir == "/" {
        format!("/{name}")
    } else if dir == "." {
        name.to_string()
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

fn remote_part_path(path: &str) -> String {
    if path.ends_with('/') {
        format!("{}upload.part", path)
    } else {
        format!("{path}.part")
    }
}
