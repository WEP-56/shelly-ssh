import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface DeviceRecord {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  privateKeyPath?: string | null
  sessionId?: string | null
  rememberPassword: boolean
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface SaveDeviceInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authMethod?: 'password' | 'privateKey'
  privateKeyPath?: string | null
  rememberPassword: boolean
}

export interface CommandHistoryRecord {
  id: string
  deviceId?: string | null
  command: string
  createdAt: number
}

export interface SnippetRecord {
  id: string
  name: string
  command: string
  createdAt: number
  updatedAt: number
}

export interface SaveSnippetInput {
  id?: string
  name: string
  command: string
}

export const listDevices = (): Promise<DeviceRecord[]> =>
  invoke('db_list_devices')

export const saveDevice = (input: SaveDeviceInput): Promise<DeviceRecord> =>
  invoke('db_save_device', { input })

export const updateDeviceSession = (deviceId: string, sessionId: string | null): Promise<void> =>
  invoke('db_update_device_session', { deviceId, sessionId })

export const setDevicePinned = (deviceId: string, pinned: boolean): Promise<DeviceRecord> =>
  invoke('db_set_device_pinned', { deviceId, pinned })

export const deleteDevice = (id: string): Promise<void> =>
  invoke('db_delete_device', { id })

export const getDevicePassword = (deviceId: string): Promise<string | null> =>
  invoke('db_get_device_password', { deviceId })

export const saveDevicePassword = (deviceId: string, password: string): Promise<void> =>
  invoke('db_save_device_password', { deviceId, password })

export const deleteDevicePassword = (deviceId: string): Promise<void> =>
  invoke('db_delete_device_password', { deviceId })

export const listCommandHistory = (deviceId?: string, limit = 100): Promise<CommandHistoryRecord[]> =>
  invoke('db_list_command_history', { deviceId: deviceId ?? null, limit })

export const addCommandHistory = (command: string, deviceId?: string): Promise<CommandHistoryRecord> =>
  invoke('db_add_command_history', { command, deviceId: deviceId ?? null })

export const deleteCommandHistory = (id: string): Promise<void> =>
  invoke('db_delete_command_history', { id })

export const clearCommandHistory = (deviceId?: string): Promise<void> =>
  invoke('db_clear_command_history', { deviceId: deviceId ?? null })

export const listSnippets = (): Promise<SnippetRecord[]> =>
  invoke('db_list_snippets')

export const saveSnippet = (input: SaveSnippetInput): Promise<SnippetRecord> =>
  invoke('db_save_snippet', { input })

export const deleteSnippet = (id: string): Promise<void> =>
  invoke('db_delete_snippet', { id })

export const onSnippetUpdated = (cb: (snippet: SnippetRecord) => void): Promise<UnlistenFn> =>
  listen<SnippetRecord>('snippet-updated', e => cb(e.payload))
