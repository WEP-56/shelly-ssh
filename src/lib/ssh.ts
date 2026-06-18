import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface ConnectOpts {
  host: string
  port: number
  username: string
  password?: string
  authMethod?: 'password' | 'privateKey'
  privateKeyPath?: string | null
  passphrase?: string
}
export interface SshDataEvent { id: string; data: number[] }
export interface SshClosedEvent { id: string; reason: string }
export interface SshHostKeyPromptEvent {
  promptId: string
  host: string
  port: number
  algorithm: string
  fingerprint: string
  knownHostsPath: string
}
export interface KnownHostEntry {
  line: number
  hosts: string
  algorithm: string
  fingerprint: string
  comment?: string | null
  knownHostsPath: string
}
export interface DeviceStats {
  hostname?: string | null
  kernel?: string | null
  uptimeSeconds?: number | null
  loadAvg?: string | null
  memTotalKb?: number | null
  memAvailableKb?: number | null
  swapTotalKb?: number | null
  swapFreeKb?: number | null
  diskTotalKb?: number | null
  diskAvailableKb?: number | null
  diskMount?: string | null
  collectedAt: number
}

export const sshConnect  = (o: ConnectOpts): Promise<string>  => invoke('ssh_connect', o as unknown as Record<string, unknown>)
export const sshInput    = (id: string, data: number[]): Promise<void> => invoke('ssh_input', { id, data })
export const sshResize   = (id: string, cols: number, rows: number): Promise<void> => invoke('ssh_resize', { id, cols, rows })
export const sshCollectDeviceStats = (id: string): Promise<DeviceStats> =>
  invoke('ssh_collect_device_stats', { id })
export const sshDisconnect = (id: string): Promise<void> => invoke('ssh_disconnect', { id })
export const sshHostKeyRespond = (promptId: string, accept: boolean): Promise<void> =>
  invoke('ssh_host_key_respond', { promptId, accept })
export const sshListKnownHosts = (host?: string, port?: number): Promise<KnownHostEntry[]> =>
  invoke('ssh_list_known_hosts', { host: host ?? null, port: port ?? null })
export const sshRemoveKnownHost = (host: string, port: number): Promise<number> =>
  invoke('ssh_remove_known_host', { host, port })

export const onSshData   = (cb: (e: SshDataEvent) => void): Promise<UnlistenFn> =>
  listen<SshDataEvent>('ssh-data', e => cb(e.payload))

export const onSshClosed = (cb: (id: string) => void): Promise<UnlistenFn> =>
  listen<string>('ssh-closed', e => cb(e.payload))

export const onSshClosedDetail = (cb: (e: SshClosedEvent) => void): Promise<UnlistenFn> =>
  listen<SshClosedEvent>('ssh-closed-detail', e => cb(e.payload))

export const onSshHostKeyPrompt = (cb: (e: SshHostKeyPromptEvent) => void): Promise<UnlistenFn> =>
  listen<SshHostKeyPromptEvent>('ssh-host-key-prompt', e => cb(e.payload))
