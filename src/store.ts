import { create } from 'zustand'
import type { DeviceStats } from './lib/ssh'

export interface Connection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod?: 'password' | 'privateKey'
  privateKeyPath?: string | null
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  sessionId?: string
  rememberPassword?: boolean
  pinned?: boolean
  deviceStats?: DeviceStats | null
}

export interface ConnectDraft {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authMethod?: 'password' | 'privateKey'
  privateKeyPath?: string | null
  rememberPassword?: boolean
  pinned?: boolean
}

export interface CommandHistoryEntry {
  id: string
  command: string
  connectionName?: string
  lastUsedAt: number
}

export interface CommandSnippet {
  id: string
  name: string
  command: string
  createdAt?: number
  updatedAt?: number
}

export type RightDockTab = 'files' | 'history' | 'snippets'
export type BottomPanelMode = 'powershell' | 'agent'
export type Language = 'en' | 'zh-CN'
export type BuiltInThemeMode = 'dark' | 'light' | 'vscode' | 'codex' | 'claude'
export type ThemeMode = BuiltInThemeMode | `custom:${string}`
export type UiFontSize = 'small' | 'medium' | 'large'
export type TerminalCursorStyle = 'block' | 'underline' | 'bar'
export type AuthMethod = 'password' | 'privateKey'
export type DefaultAuthMethod = AuthMethod | 'lastUsed'
export type UnknownHostKeyPolicy = 'prompt' | 'reject'
export type PostConnectAction = 'terminal' | 'files' | 'terminalFiles'

export const builtInThemeModes: BuiltInThemeMode[] = ['dark', 'light', 'vscode', 'codex', 'claude']

export interface CustomThemeColors {
  background: string
  surface: string
  surface2: string
  surface3: string
  text: string
  textMuted: string
  textSubtle: string
  accent: string
  red: string
  green: string
  terminalBackground: string
  terminalForeground: string
  terminalCursor: string
}

export interface CustomTheme {
  id: string
  name: string
  colors: CustomThemeColors
  backgroundImagePath?: string
  terminalBackgroundOpacity: number
  createdAt: number
  updatedAt: number
}

export const defaultCustomThemeColors: CustomThemeColors = {
  background: '#111315',
  surface: '#181c20',
  surface2: '#222830',
  surface3: '#2c3440',
  text: '#e6edf3',
  textMuted: '#a6b2bf',
  textSubtle: '#6f7d8c',
  accent: '#4aa3ff',
  red: '#ff6b6b',
  green: '#58d68d',
  terminalBackground: '#101418',
  terminalForeground: '#e6edf3',
  terminalCursor: '#4aa3ff',
}

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  scrollback: number
  paddingX: number
  paddingY: number
  bell: boolean
  copyOnSelect: boolean
  rightClickPaste: boolean
  rightClickSelectsWord: boolean
}

export interface ConnectionSettings {
  defaultPort: number
  connectTimeoutSecs: number
  keepaliveEnabled: boolean
  keepaliveIntervalSecs: number
  keepaliveMaxCount: number
  defaultAuthMethod: DefaultAuthMethod
  lastAuthMethod: AuthMethod
  defaultPrivateKeyPath: string
  unknownHostKeyPolicy: UnknownHostKeyPolicy
  strictHostKeyChecking: boolean
  postConnectAction: PostConnectAction
  autoReconnect: boolean
  autoReconnectMaxAttempts: number
  autoReconnectIntervalSecs: number
  restoreTerminalContent: boolean
}

export const defaultTerminalSettings: TerminalSettings = {
  fontFamily: '"JetBrains Mono","Cascadia Code",monospace',
  fontSize: 13,
  lineHeight: 1.5,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 1000,
  paddingX: 14,
  paddingY: 10,
  bell: false,
  copyOnSelect: false,
  rightClickPaste: false,
  rightClickSelectsWord: true,
}

export const defaultConnectionSettings: ConnectionSettings = {
  defaultPort: 22,
  connectTimeoutSecs: 15,
  keepaliveEnabled: true,
  keepaliveIntervalSecs: 30,
  keepaliveMaxCount: 3,
  defaultAuthMethod: 'password',
  lastAuthMethod: 'password',
  defaultPrivateKeyPath: '',
  unknownHostKeyPolicy: 'prompt',
  strictHostKeyChecking: true,
  postConnectAction: 'terminal',
  autoReconnect: false,
  autoReconnectMaxAttempts: 3,
  autoReconnectIntervalSecs: 5,
  restoreTerminalContent: true,
}

interface S {
  conns: Connection[]
  activeId: string | null
  sidebarOpen: boolean
  sidebarWidth: number
  rightOpen: boolean
  rightTab: RightDockTab
  rightDockWidth: number
  filePreviewWidth: number
  showConnect: boolean
  connectDraft: ConnectDraft | null
  commandPaletteOpen: boolean
  commandHistory: CommandHistoryEntry[]
  commandSnippets: CommandSnippet[]
  localOpen: boolean
  localHeight: number
  bottomPanelMode: BottomPanelMode
  language: Language
  themeMode: ThemeMode
  customThemes: CustomTheme[]
  uiFontSize: UiFontSize
  terminalSettings: TerminalSettings
  connectionSettings: ConnectionSettings
  defaultDownloadDir: string
  autoCheckUpdates: boolean
  showSettings: boolean
  setCommandPaletteOpen: (v: boolean) => void
  toggleCommandPalette: () => void
  setConns: (conns: Connection[]) => void
  setCommandHistory: (history: CommandHistoryEntry[]) => void
  setCommandSnippets: (snippets: CommandSnippet[]) => void
  addCommandHistory: (command: string, connectionName?: string, id?: string, lastUsedAt?: number) => void
  removeCommandHistory: (id: string) => void
  clearCommandHistory: () => void
  upsertCommandSnippet: (snippet: CommandSnippet) => void
  removeCommandSnippet: (id: string) => void
  openConnectDialog: (draft?: ConnectDraft | null) => void
  setConnectDraft: (draft: ConnectDraft | null) => void
  toggleLocal: () => void
  setLocalOpen: (v: boolean) => void
  setLocalHeight: (h: number) => void
  setBottomPanelMode: (mode: BottomPanelMode) => void
  setLanguage: (language: Language) => void
  setThemeMode: (themeMode: ThemeMode) => void
  saveCustomTheme: (theme: Partial<CustomTheme> & { name: string; colors: CustomThemeColors }) => CustomTheme
  deleteCustomTheme: (id: string) => void
  setUiFontSize: (uiFontSize: UiFontSize) => void
  patchTerminalSettings: (patch: Partial<TerminalSettings>) => void
  resetTerminalSettings: () => void
  patchConnectionSettings: (patch: Partial<ConnectionSettings>) => void
  resetConnectionSettings: () => void
  setDefaultDownloadDir: (path: string) => void
  setAutoCheckUpdates: (enabled: boolean) => void
  setShowSettings: (v: boolean) => void
  setSidebarWidth: (w: number) => void
  setRightDockWidth: (w: number) => void
  setFilePreviewWidth: (w: number) => void
  addConn: (c: Omit<Connection, 'id' | 'status'> & { id?: string; status?: Connection['status'] }) => string
  patchConn: (id: string, p: Partial<Connection>) => void
  removeConn: (id: string) => void
  reorderConn: (dragId: string, targetId: string) => void
  setActive: (id: string | null) => void
  toggleSidebar: () => void
  toggleRight: () => void
  setRightTab: (tab: RightDockTab) => void
  setRightOpen: (v: boolean) => void
  setShowConnect: (v: boolean) => void
}

let uid = 1
let historyUid = 1

function readNumberPref(key: string, fallback: number) {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  const value = raw ? Number(raw) : NaN
  return Number.isFinite(value) ? value : fallback
}

function writeNumberPref(key: string, value: number) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(value))
}

function readBooleanPref(key: string, fallback: boolean) {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

function writeBooleanPref(key: string, value: boolean) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, value ? 'true' : 'false')
}

function readStringPref<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  return raw && allowed.includes(raw as T) ? raw as T : fallback
}

function writeStringPref(key: string, value: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
}

function readThemeModePref(): ThemeMode {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('shelly:themeMode')
  if (!raw) return 'dark'
  if (builtInThemeModes.includes(raw as BuiltInThemeMode) || raw.startsWith('custom:')) return raw as ThemeMode
  return 'dark'
}

function normalizeHexColor(value: unknown, fallback: string) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

function normalizeCustomThemeColors(value: unknown): CustomThemeColors {
  const raw = value && typeof value === 'object' ? value as Partial<CustomThemeColors> : {}
  return {
    background: normalizeHexColor(raw.background, defaultCustomThemeColors.background),
    surface: normalizeHexColor(raw.surface, defaultCustomThemeColors.surface),
    surface2: normalizeHexColor(raw.surface2, defaultCustomThemeColors.surface2),
    surface3: normalizeHexColor(raw.surface3, defaultCustomThemeColors.surface3),
    text: normalizeHexColor(raw.text, defaultCustomThemeColors.text),
    textMuted: normalizeHexColor(raw.textMuted, defaultCustomThemeColors.textMuted),
    textSubtle: normalizeHexColor(raw.textSubtle, defaultCustomThemeColors.textSubtle),
    accent: normalizeHexColor(raw.accent, defaultCustomThemeColors.accent),
    red: normalizeHexColor(raw.red, defaultCustomThemeColors.red),
    green: normalizeHexColor(raw.green, defaultCustomThemeColors.green),
    terminalBackground: normalizeHexColor(raw.terminalBackground, defaultCustomThemeColors.terminalBackground),
    terminalForeground: normalizeHexColor(raw.terminalForeground, defaultCustomThemeColors.terminalForeground),
    terminalCursor: normalizeHexColor(raw.terminalCursor, defaultCustomThemeColors.terminalCursor),
  }
}

function normalizeCustomTheme(value: unknown): CustomTheme | null {
  const raw = value && typeof value === 'object' ? value as Partial<CustomTheme> : null
  if (!raw) return null
  const id = typeof raw.id === 'string' && raw.id.startsWith('custom:') ? raw.id : ''
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : ''
  if (!id || !name) return null
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt as number : Date.now()
  return {
    id,
    name,
    colors: normalizeCustomThemeColors(raw.colors),
    backgroundImagePath: typeof raw.backgroundImagePath === 'string' && raw.backgroundImagePath.trim() ? raw.backgroundImagePath : undefined,
    terminalBackgroundOpacity: clampNumber(raw.terminalBackgroundOpacity, 0.48, 0.15, 1),
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt as number : createdAt,
  }
}

function readCustomThemes() {
  if (typeof localStorage === 'undefined') return []
  const raw = localStorage.getItem('shelly:customThemes')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const themes = parsed.map(normalizeCustomTheme).filter((theme): theme is CustomTheme => Boolean(theme))
    return themes.filter((theme, index) => themes.findIndex(item => item.id === theme.id) === index)
  } catch {
    return []
  }
}

function writeCustomThemes(themes: CustomTheme[]) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('shelly:customThemes', JSON.stringify(themes))
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function normalizeTerminalSettings(value: unknown): TerminalSettings {
  const raw = value && typeof value === 'object' ? value as Partial<TerminalSettings> : {}
  const cursorStyle = raw.cursorStyle && ['block', 'underline', 'bar'].includes(raw.cursorStyle)
    ? raw.cursorStyle
    : defaultTerminalSettings.cursorStyle
  return {
    fontFamily: typeof raw.fontFamily === 'string' && raw.fontFamily.trim()
      ? raw.fontFamily
      : defaultTerminalSettings.fontFamily,
    fontSize: clampNumber(raw.fontSize, defaultTerminalSettings.fontSize, 9, 28),
    lineHeight: clampNumber(raw.lineHeight, defaultTerminalSettings.lineHeight, 1, 2.2),
    cursorStyle,
    cursorBlink: typeof raw.cursorBlink === 'boolean' ? raw.cursorBlink : defaultTerminalSettings.cursorBlink,
    scrollback: Math.round(clampNumber(raw.scrollback, defaultTerminalSettings.scrollback, 100, 100000)),
    paddingX: Math.round(clampNumber(raw.paddingX, defaultTerminalSettings.paddingX, 0, 40)),
    paddingY: Math.round(clampNumber(raw.paddingY, defaultTerminalSettings.paddingY, 0, 40)),
    bell: typeof raw.bell === 'boolean' ? raw.bell : defaultTerminalSettings.bell,
    copyOnSelect: typeof raw.copyOnSelect === 'boolean' ? raw.copyOnSelect : defaultTerminalSettings.copyOnSelect,
    rightClickPaste: typeof raw.rightClickPaste === 'boolean' ? raw.rightClickPaste : defaultTerminalSettings.rightClickPaste,
    rightClickSelectsWord: typeof raw.rightClickSelectsWord === 'boolean' ? raw.rightClickSelectsWord : defaultTerminalSettings.rightClickSelectsWord,
  }
}

function readTerminalSettings() {
  if (typeof localStorage === 'undefined') return defaultTerminalSettings
  const raw = localStorage.getItem('shelly:terminalSettings')
  if (!raw) return defaultTerminalSettings
  try {
    return normalizeTerminalSettings(JSON.parse(raw))
  } catch {
    return defaultTerminalSettings
  }
}

function writeTerminalSettings(value: TerminalSettings) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('shelly:terminalSettings', JSON.stringify(value))
  }
}

function normalizeConnectionSettings(value: unknown): ConnectionSettings {
  const raw = value && typeof value === 'object' ? value as Partial<ConnectionSettings> : {}
  const defaultAuthMethod = raw.defaultAuthMethod && ['password', 'privateKey', 'lastUsed'].includes(raw.defaultAuthMethod)
    ? raw.defaultAuthMethod
    : defaultConnectionSettings.defaultAuthMethod
  const lastAuthMethod = raw.lastAuthMethod && ['password', 'privateKey'].includes(raw.lastAuthMethod)
    ? raw.lastAuthMethod
    : defaultConnectionSettings.lastAuthMethod
  const unknownHostKeyPolicy = raw.unknownHostKeyPolicy && ['prompt', 'reject'].includes(raw.unknownHostKeyPolicy)
    ? raw.unknownHostKeyPolicy
    : defaultConnectionSettings.unknownHostKeyPolicy
  const postConnectAction = raw.postConnectAction && ['terminal', 'files', 'terminalFiles'].includes(raw.postConnectAction)
    ? raw.postConnectAction
    : defaultConnectionSettings.postConnectAction
  return {
    defaultPort: Math.round(clampNumber(raw.defaultPort, defaultConnectionSettings.defaultPort, 1, 65535)),
    connectTimeoutSecs: Math.round(clampNumber(raw.connectTimeoutSecs, defaultConnectionSettings.connectTimeoutSecs, 3, 120)),
    keepaliveEnabled: typeof raw.keepaliveEnabled === 'boolean' ? raw.keepaliveEnabled : defaultConnectionSettings.keepaliveEnabled,
    keepaliveIntervalSecs: Math.round(clampNumber(raw.keepaliveIntervalSecs, defaultConnectionSettings.keepaliveIntervalSecs, 5, 300)),
    keepaliveMaxCount: Math.round(clampNumber(raw.keepaliveMaxCount, defaultConnectionSettings.keepaliveMaxCount, 1, 20)),
    defaultAuthMethod,
    lastAuthMethod,
    defaultPrivateKeyPath: typeof raw.defaultPrivateKeyPath === 'string' ? raw.defaultPrivateKeyPath : defaultConnectionSettings.defaultPrivateKeyPath,
    unknownHostKeyPolicy,
    strictHostKeyChecking: typeof raw.strictHostKeyChecking === 'boolean' ? raw.strictHostKeyChecking : defaultConnectionSettings.strictHostKeyChecking,
    postConnectAction,
    autoReconnect: typeof raw.autoReconnect === 'boolean' ? raw.autoReconnect : defaultConnectionSettings.autoReconnect,
    autoReconnectMaxAttempts: Math.round(clampNumber(raw.autoReconnectMaxAttempts, defaultConnectionSettings.autoReconnectMaxAttempts, 1, 20)),
    autoReconnectIntervalSecs: Math.round(clampNumber(raw.autoReconnectIntervalSecs, defaultConnectionSettings.autoReconnectIntervalSecs, 1, 120)),
    restoreTerminalContent: typeof raw.restoreTerminalContent === 'boolean' ? raw.restoreTerminalContent : defaultConnectionSettings.restoreTerminalContent,
  }
}

function readConnectionSettings() {
  if (typeof localStorage === 'undefined') return defaultConnectionSettings
  const raw = localStorage.getItem('shelly:connectionSettings')
  if (!raw) return defaultConnectionSettings
  try {
    return normalizeConnectionSettings(JSON.parse(raw))
  } catch {
    return defaultConnectionSettings
  }
}

function writeConnectionSettings(value: ConnectionSettings) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('shelly:connectionSettings', JSON.stringify(value))
  }
}

export const useStore = create<S>(set => ({
  conns: [], activeId: null, sidebarOpen: true, sidebarWidth: readNumberPref('shelly:sidebarWidth', 200), rightOpen: false, rightTab: 'files',
  rightDockWidth: readNumberPref('shelly:rightDockWidth', 280),
  filePreviewWidth: readNumberPref('shelly:filePreviewWidth', 420),
  showConnect: false, connectDraft: null,
  commandPaletteOpen: false,
  commandHistory: [],
  commandSnippets: [],
  localOpen: false, localHeight: 220,
  bottomPanelMode: readStringPref<BottomPanelMode>('shelly:bottomPanelMode', 'powershell', ['powershell', 'agent']),
  language: readStringPref<Language>('shelly:language', 'en', ['en', 'zh-CN']),
  themeMode: readThemeModePref(),
  customThemes: readCustomThemes(),
  uiFontSize: readStringPref<UiFontSize>('shelly:uiFontSize', 'small', ['small', 'medium', 'large']),
  terminalSettings: readTerminalSettings(),
  connectionSettings: readConnectionSettings(),
  defaultDownloadDir: typeof localStorage === 'undefined' ? '' : localStorage.getItem('shelly:defaultDownloadDir') ?? '',
  autoCheckUpdates: readBooleanPref('shelly:autoCheckUpdates', false),
  showSettings: false,
  setCommandPaletteOpen: v => set({ commandPaletteOpen: v }),
  toggleCommandPalette: () => set(s => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  setConns: conns => set(s => ({ conns, activeId: s.activeId && conns.some(c => c.id === s.activeId) ? s.activeId : null })),
  setCommandHistory: commandHistory => set({ commandHistory }),
  setCommandSnippets: commandSnippets => set({ commandSnippets }),
  addCommandHistory: (command, connectionName, id, lastUsedAt) => set(s => ({
    commandHistory: [
      { id: id ?? `h${++historyUid}`, command, connectionName, lastUsedAt: lastUsedAt ?? Date.now() },
      ...s.commandHistory.filter(h => h.command !== command),
    ].slice(0, 100),
  })),
  removeCommandHistory: id => set(s => ({ commandHistory: s.commandHistory.filter(item => item.id !== id) })),
  clearCommandHistory: () => set({ commandHistory: [] }),
  upsertCommandSnippet: snippet => set(s => ({
    commandSnippets: [
      snippet,
      ...s.commandSnippets.filter(item => item.id !== snippet.id && item.name !== snippet.name),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  })),
  removeCommandSnippet: id => set(s => ({ commandSnippets: s.commandSnippets.filter(item => item.id !== id) })),
  openConnectDialog: draft => set({ connectDraft: draft ?? null, showConnect: true }),
  setConnectDraft: connectDraft => set({ connectDraft }),
  toggleLocal: () => set(s => ({ localOpen: !s.localOpen })),
  setLocalOpen: localOpen => set({ localOpen }),
  setLocalHeight: h => set({ localHeight: h }),
  setBottomPanelMode: mode => set(() => {
    writeStringPref('shelly:bottomPanelMode', mode)
    return { bottomPanelMode: mode }
  }),
  setLanguage: language => set(() => {
    writeStringPref('shelly:language', language)
    return { language }
  }),
  setThemeMode: themeMode => set(() => {
    writeStringPref('shelly:themeMode', themeMode)
    return { themeMode }
  }),
  saveCustomTheme: theme => {
    const now = Date.now()
    const saved: CustomTheme = normalizeCustomTheme({
      ...theme,
      id: theme.id?.startsWith('custom:') ? theme.id : `custom:${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: theme.name.trim() || 'Custom Theme',
      colors: theme.colors,
      createdAt: theme.createdAt ?? now,
      updatedAt: now,
    })!
    set(s => {
      const customThemes = [
        saved,
        ...s.customThemes.filter(item => item.id !== saved.id),
      ].sort((a, b) => b.updatedAt - a.updatedAt)
      writeCustomThemes(customThemes)
      writeStringPref('shelly:themeMode', saved.id)
      return { customThemes, themeMode: saved.id as ThemeMode }
    })
    return saved
  },
  deleteCustomTheme: id => set(s => {
    const customThemes = s.customThemes.filter(theme => theme.id !== id)
    writeCustomThemes(customThemes)
    const themeMode = s.themeMode === id ? 'dark' : s.themeMode
    if (themeMode !== s.themeMode) writeStringPref('shelly:themeMode', themeMode)
    return { customThemes, themeMode }
  }),
  setUiFontSize: uiFontSize => set(() => {
    writeStringPref('shelly:uiFontSize', uiFontSize)
    return { uiFontSize }
  }),
  patchTerminalSettings: patch => set(s => {
    const terminalSettings = normalizeTerminalSettings({ ...s.terminalSettings, ...patch })
    writeTerminalSettings(terminalSettings)
    return { terminalSettings }
  }),
  resetTerminalSettings: () => set(() => {
    writeTerminalSettings(defaultTerminalSettings)
    return { terminalSettings: defaultTerminalSettings }
  }),
  patchConnectionSettings: patch => set(s => {
    const connectionSettings = normalizeConnectionSettings({ ...s.connectionSettings, ...patch })
    writeConnectionSettings(connectionSettings)
    return { connectionSettings }
  }),
  resetConnectionSettings: () => set(() => {
    writeConnectionSettings(defaultConnectionSettings)
    return { connectionSettings: defaultConnectionSettings }
  }),
  setDefaultDownloadDir: defaultDownloadDir => set(() => {
    writeStringPref('shelly:defaultDownloadDir', defaultDownloadDir)
    return { defaultDownloadDir }
  }),
  setAutoCheckUpdates: autoCheckUpdates => set(() => {
    writeBooleanPref('shelly:autoCheckUpdates', autoCheckUpdates)
    return { autoCheckUpdates }
  }),
  setShowSettings: showSettings => set({ showSettings }),
  setSidebarWidth: w => set(() => {
    const sidebarWidth = Math.max(150, Math.min(360, w))
    writeNumberPref('shelly:sidebarWidth', sidebarWidth)
    return { sidebarWidth }
  }),
  setRightDockWidth: w => set(() => {
    const rightDockWidth = Math.max(220, Math.min(520, w))
    writeNumberPref('shelly:rightDockWidth', rightDockWidth)
    return { rightDockWidth }
  }),
  setFilePreviewWidth: w => set(() => {
    const filePreviewWidth = Math.max(280, Math.min(760, w))
    writeNumberPref('shelly:filePreviewWidth', filePreviewWidth)
    return { filePreviewWidth }
  }),
  addConn: c => {
    const id = c.id ?? String(uid++)
    set(s => {
      const next = { ...c, id, status: c.status ?? 'disconnected' }
      return {
        conns: s.conns.some(conn => conn.id === id)
          ? s.conns.map(conn => conn.id === id ? next : conn)
          : [...s.conns, next],
      }
    })
    return id
  },
  patchConn: (id, p) => set(s => ({ conns: s.conns.map(c => c.id === id ? { ...c, ...p } : c) })),
  removeConn: id => set(s => ({ conns: s.conns.filter(c => c.id !== id), activeId: s.activeId === id ? null : s.activeId })),
  reorderConn: (dragId, targetId) => set(s => {
    if (dragId === targetId) return s
    const from = s.conns.findIndex(c => c.id === dragId)
    const to = s.conns.findIndex(c => c.id === targetId)
    if (from < 0 || to < 0) return s
    const conns = [...s.conns]
    const [moved] = conns.splice(from, 1)
    conns.splice(to, 0, moved)
    return { conns }
  }),
  setActive: id => set({ activeId: id }),
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),
  toggleRight: () => set(s => ({ rightOpen: !s.rightOpen })),
  setRightTab: rightTab => set({ rightTab }),
  setRightOpen: rightOpen => set({ rightOpen }),
  setShowConnect: v => set(s => ({ showConnect: v, connectDraft: v ? s.connectDraft : null })),
}))
