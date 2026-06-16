import { create } from 'zustand'

export interface Connection {
  id: string
  name: string
  host: string
  port: number
  username: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  sessionId?: string
}

interface S {
  conns: Connection[]
  activeId: string | null
  sidebarOpen: boolean
  rightOpen: boolean
  showConnect: boolean
  localOpen: boolean
  localHeight: number
  toggleLocal: () => void
  setLocalHeight: (h: number) => void
  addConn: (c: Omit<Connection, 'id' | 'status'>) => string
  patchConn: (id: string, p: Partial<Connection>) => void
  removeConn: (id: string) => void
  setActive: (id: string | null) => void
  toggleSidebar: () => void
  toggleRight: () => void
  setShowConnect: (v: boolean) => void
}

let uid = 1
export const useStore = create<S>(set => ({
  conns: [], activeId: null, sidebarOpen: true, rightOpen: true, showConnect: false,
  localOpen: false, localHeight: 220,
  toggleLocal: () => set(s => ({ localOpen: !s.localOpen })),
  setLocalHeight: h => set({ localHeight: h }),
  addConn: c => { const id = String(uid++); set(s => ({ conns: [...s.conns, { ...c, id, status: 'disconnected' }] })); return id },
  patchConn: (id, p) => set(s => ({ conns: s.conns.map(c => c.id === id ? { ...c, ...p } : c) })),
  removeConn: id => set(s => ({ conns: s.conns.filter(c => c.id !== id), activeId: s.activeId === id ? null : s.activeId })),
  setActive: id => set({ activeId: id }),
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),
  toggleRight: () => set(s => ({ rightOpen: !s.rightOpen })),
  setShowConnect: v => set({ showConnect: v }),
}))
