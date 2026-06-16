import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface ConnectOpts {
  host: string; port: number; username: string; password: string
}
export interface SshDataEvent { id: string; data: number[] }

export const sshConnect  = (o: ConnectOpts): Promise<string>  => invoke('ssh_connect', o as unknown as Record<string, unknown>)
export const sshInput    = (id: string, data: number[]): Promise<void> => invoke('ssh_input', { id, data })
export const sshResize   = (id: string, cols: number, rows: number): Promise<void> => invoke('ssh_resize', { id, cols, rows })
export const sshDisconnect = (id: string): Promise<void> => invoke('ssh_disconnect', { id })

export const onSshData   = (cb: (e: SshDataEvent) => void): Promise<UnlistenFn> =>
  listen<SshDataEvent>('ssh-data', e => cb(e.payload))

export const onSshClosed = (cb: (id: string) => void): Promise<UnlistenFn> =>
  listen<string>('ssh-closed', e => cb(e.payload))
