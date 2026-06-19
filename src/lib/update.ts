import { invoke } from '@tauri-apps/api/core'

export interface UpdateAsset {
  name: string
  downloadUrl: string
  size: number
}

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  tagName: string
  releaseName: string
  releaseUrl: string
  releaseNotes: string
  publishedAt?: string | null
  asset: UpdateAsset
  available: boolean
}

export interface DownloadedUpdate {
  path: string
  fileName: string
  size: number
}

export interface UpdateProgress {
  phase: 'downloading' | 'finished'
  downloaded: number
  total?: number | null
  percent: number
}

export const getCurrentVersion = (): Promise<string> => invoke('update_current_version')
export const checkForUpdates = (): Promise<UpdateInfo | null> => invoke('update_check')
export const downloadUpdate = (asset: UpdateAsset): Promise<DownloadedUpdate> => invoke('update_download', { asset })
export const installUpdateAndExit = (path: string): Promise<void> => invoke('update_install_and_exit', { path })
export const openGithubRepository = (): Promise<void> => invoke('open_github_repository')
