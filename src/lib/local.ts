import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface LocalDataEvent { id: string; data: number[] }

export const localStart  = (cols: number, rows: number): Promise<string> => invoke('local_start', { cols, rows })
export const localInput  = (id: string, data: number[]): Promise<void>   => invoke('local_input', { id, data })
export const localResize = (id: string, cols: number, rows: number): Promise<void> => invoke('local_resize', { id, cols, rows })
export const localStop   = (id: string): Promise<void> => invoke('local_stop', { id })

export const onLocalData   = (cb: (e: LocalDataEvent) => void): Promise<UnlistenFn> =>
  listen<LocalDataEvent>('local-data', e => cb(e.payload))
export const onLocalClosed = (cb: (id: string) => void): Promise<UnlistenFn> =>
  listen<string>('local-closed', e => cb(e.payload))
