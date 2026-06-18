import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type FileJobKind = 'listDir' | 'download' | 'upload' | 'delete' | 'rename' | 'mkdir' | 'createFile' | 'preview'
export type FileJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type UploadConflictPolicy = 'overwrite' | 'skip' | 'fail'

export interface FileJob {
  id: string
  deviceId: string
  sessionId?: string | null
  kind: FileJobKind
  path: string
  localPath?: string | null
  status: FileJobStatus
  progress: number
  message?: string | null
  entries?: RemoteFileEntry[] | null
  content?: string | null
  failedEntries?: FileJobFailure[] | null
  createdAt: number
  updatedAt: number
}

export interface FileJobFailure {
  localPath: string
  remotePath: string
  message: string
}

export interface RemoteFileEntry {
  name: string
  path: string
  isDir: boolean
  size?: number | null
  modifiedAt?: number | null
  permissions?: number | null
}

export const queueListDir = (deviceId: string, sessionId: string | null, path: string): Promise<FileJob> =>
  invoke('file_queue_list_dir', { deviceId, sessionId, path })

export const queuePreview = (deviceId: string, sessionId: string | null, path: string): Promise<FileJob> =>
  invoke('file_queue_preview', { deviceId, sessionId, path })

export const queueDownload = (
  deviceId: string,
  sessionId: string | null,
  remotePath: string,
  localPath: string,
): Promise<FileJob> =>
  invoke('file_queue_download', { deviceId, sessionId, remotePath, localPath })

export const queueUpload = (
  deviceId: string,
  sessionId: string | null,
  localPath: string,
  remotePath: string,
  conflictPolicy: UploadConflictPolicy = 'overwrite',
): Promise<FileJob> =>
  invoke('file_queue_upload', { deviceId, sessionId, localPath, remotePath, conflictPolicy })

export const queueDelete = (
  deviceId: string,
  sessionId: string | null,
  path: string,
  isDir: boolean,
): Promise<FileJob> =>
  invoke('file_queue_delete', { deviceId, sessionId, path, isDir })

export const queueRename = (
  deviceId: string,
  sessionId: string | null,
  path: string,
  targetPath: string,
): Promise<FileJob> =>
  invoke('file_queue_rename', { deviceId, sessionId, path, targetPath })

export const queueMkdir = (
  deviceId: string,
  sessionId: string | null,
  path: string,
): Promise<FileJob> =>
  invoke('file_queue_mkdir', { deviceId, sessionId, path })

export const queueCreateFile = (
  deviceId: string,
  sessionId: string | null,
  path: string,
): Promise<FileJob> =>
  invoke('file_queue_create_file', { deviceId, sessionId, path })

export const listFileJobs = (deviceId?: string): Promise<FileJob[]> =>
  invoke('file_list_jobs', { deviceId: deviceId ?? null })

export const cancelFileJob = (jobId: string): Promise<FileJob> =>
  invoke('file_cancel_job', { jobId })

export const onFileJobUpdated = (cb: (job: FileJob) => void): Promise<UnlistenFn> =>
  listen<FileJob>('file-job-updated', e => cb(e.payload))
