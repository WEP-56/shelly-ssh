import { addCommandHistory } from './db'
import { sshInput } from './ssh'
import { useStore, type Connection } from '../store'

export type CommandSendMode = 'insert' | 'run'

export async function sendCommandToActiveTerminal(command: string, mode: CommandSendMode = 'insert') {
  const text = command.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!text.trim()) return
  const state = useStore.getState()
  const active = state.conns.find(c => c.id === state.activeId && c.status === 'connected' && c.sessionId)
  if (!active?.sessionId) {
    throw new Error('No connected SSH terminal')
  }
  await sshInput(active.sessionId, Array.from(new TextEncoder().encode(mode === 'run' ? `${text}\r` : text)))
  if (mode === 'insert' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('shelly-command-inserted', {
      detail: { sessionId: active.sessionId, text },
    }))
  }
  if (mode === 'run') {
    await recordCommandHistory(text, active)
  }
}

export async function recordCommandHistory(command: string, connection?: Connection) {
  const normalized = command.trim()
  if (!normalized) return
  const entry = await addCommandHistory(normalized, connection?.id)
  useStore.getState().addCommandHistory(normalized, connection?.name, entry.id, entry.createdAt)
}
