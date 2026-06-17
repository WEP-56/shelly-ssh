import { create } from 'zustand'

export interface Connection {
  id: string
  name: string
  host: string
  port: number
  username: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  sessionId?: string
  rememberPassword?: boolean
}

export interface ConnectDraft {
  id?: string
  name: string
  host: string
  port: number
  username: string
  rememberPassword?: boolean
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

export type RightDockTab = 'files' | 'history' | 'snippets' | 'agent'
export type BottomPanelMode = 'powershell' | 'agent'

interface S {
  conns: Connection[]
  activeId: string | null
  sidebarOpen: boolean
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
  showSettings: boolean
  setCommandPaletteOpen: (v: boolean) => void
  toggleCommandPalette: () => void
  setConns: (conns: Connection[]) => void
  setCommandHistory: (history: CommandHistoryEntry[]) => void
  setCommandSnippets: (snippets: CommandSnippet[]) => void
  addCommandHistory: (command: string, connectionName?: string) => void
  upsertCommandSnippet: (snippet: CommandSnippet) => void
  removeCommandSnippet: (id: string) => void
  openConnectDialog: (draft?: ConnectDraft | null) => void
  setConnectDraft: (draft: ConnectDraft | null) => void
  toggleLocal: () => void
  setLocalHeight: (h: number) => void
  setBottomPanelMode: (mode: BottomPanelMode) => void
  setShowSettings: (v: boolean) => void
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

function readStringPref<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  return raw && allowed.includes(raw as T) ? raw as T : fallback
}

function writeStringPref(key: string, value: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
}

export const useStore = create<S>(set => ({
  conns: [], activeId: null, sidebarOpen: true, rightOpen: true, rightTab: 'files',
  rightDockWidth: readNumberPref('shelly:rightDockWidth', 280),
  filePreviewWidth: readNumberPref('shelly:filePreviewWidth', 420),
  showConnect: false, connectDraft: null,
  commandPaletteOpen: false,
  commandHistory: [],
  commandSnippets: [],
  localOpen: false, localHeight: 220,
  bottomPanelMode: readStringPref<BottomPanelMode>('shelly:bottomPanelMode', 'powershell', ['powershell', 'agent']),
  showSettings: false,
  setCommandPaletteOpen: v => set({ commandPaletteOpen: v }),
  toggleCommandPalette: () => set(s => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  setConns: conns => set(s => ({ conns, activeId: s.activeId && conns.some(c => c.id === s.activeId) ? s.activeId : null })),
  setCommandHistory: commandHistory => set({ commandHistory }),
  setCommandSnippets: commandSnippets => set({ commandSnippets }),
  addCommandHistory: (command, connectionName) => set(s => ({
    commandHistory: [
      { id: `h${++historyUid}`, command, connectionName, lastUsedAt: Date.now() },
      ...s.commandHistory.filter(h => h.command !== command),
    ].slice(0, 100),
  })),
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
  setLocalHeight: h => set({ localHeight: h }),
  setBottomPanelMode: mode => set(() => {
    writeStringPref('shelly:bottomPanelMode', mode)
    return { bottomPanelMode: mode }
  }),
  setShowSettings: showSettings => set({ showSettings }),
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
