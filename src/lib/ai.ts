import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type AiProviderKind = 'openai_responses' | 'claude_messages'

export interface AiProvider {
  id: string
  name: string
  apiKind: AiProviderKind
  baseUrl: string
  model: string
  contextWindowTokens: number
  temperature: number
  maxTokens: number
  topP?: number | null
  timeoutSecs: number
  systemPrompt?: string | null
  isDefault: boolean
  hasApiKey: boolean
  createdAt: number
  updatedAt: number
}

export interface SaveAiProviderInput {
  id?: string
  name: string
  apiKind: AiProviderKind
  baseUrl: string
  model: string
  contextWindowTokens?: number
  temperature?: number
  maxTokens?: number
  topP?: number | null
  timeoutSecs?: number
  systemPrompt?: string | null
  isDefault?: boolean
  apiKey?: string
}

export interface AiConversation {
  id: string
  serverKey: string
  deviceId?: string | null
  activeSessionId?: string | null
  latestSnapshotId?: string | null
  providerId?: string | null
  title?: string | null
  estimatedTokens: number
  status: string
  createdAt: number
  updatedAt: number
}

export interface SaveAiSessionSnapshotInput {
  serverKey: string
  sessionId?: string | null
  deviceId?: string | null
  hostname?: string | null
  username?: string | null
  host?: string | null
  port?: number | null
  os?: string | null
  shell?: string | null
  cwd?: string | null
  terminalTitle?: string | null
}

export interface CreateAiConversationInput {
  serverKey: string
  deviceId?: string | null
  activeSessionId?: string | null
  providerId?: string | null
  title?: string | null
  snapshot?: SaveAiSessionSnapshotInput | null
}

export interface AiMessage {
  id: string
  conversationId: string
  role: 'system' | 'user' | 'assistant' | 'tool' | string
  content?: string | null
  toolCallId?: string | null
  toolName?: string | null
  toolArgsJson?: string | null
  createdAt: number
}

export interface AiStatusEvent {
  conversationId: string
  status: string
  message?: string | null
}

export interface AiStreamChunkEvent {
  conversationId: string
  delta: string
}

export interface AiErrorEvent {
  conversationId: string
  message: string
}

export interface TerminalSnapshot {
  sessionId: string
  lines: string[]
  text: string
}

export const listAiProviders = (): Promise<AiProvider[]> =>
  invoke('db_list_ai_providers')

export const saveAiProvider = (input: SaveAiProviderInput): Promise<AiProvider> =>
  invoke('db_save_ai_provider', { input })

export const deleteAiProvider = (id: string): Promise<void> =>
  invoke('db_delete_ai_provider', { id })

export const setDefaultAiProvider = (id: string): Promise<void> =>
  invoke('db_set_default_ai_provider', { id })

export const listAiConversations = (serverKey?: string, deviceId?: string): Promise<AiConversation[]> =>
  invoke('db_list_ai_conversations', { serverKey: serverKey ?? null, deviceId: deviceId ?? null })

export const createAiConversation = (input: CreateAiConversationInput): Promise<AiConversation> =>
  invoke('db_create_ai_conversation', { input })

export const getAiConversation = (id: string): Promise<AiConversation> =>
  invoke('db_get_ai_conversation', { id })

export const listAiMessages = (conversationId: string): Promise<AiMessage[]> =>
  invoke('db_list_ai_messages', { conversationId })

export const bindAiConversationSession = (
  conversationId: string,
  activeSessionId: string | null,
  snapshot: SaveAiSessionSnapshotInput,
): Promise<void> =>
  invoke('db_bind_ai_conversation_session', { conversationId, activeSessionId, snapshot })

export const sendAiMessage = (
  conversationId: string,
  activeSessionId: string | null,
  content: string,
  terminalContext?: string | null,
): Promise<void> =>
  invoke('ai_send_message', { input: { conversationId, activeSessionId, content, terminalContext: terminalContext ?? null } })

export const readTerminal = (sessionId: string, lines = 120): Promise<TerminalSnapshot> =>
  invoke('ai_read_terminal', { sessionId, lines })

export const onAiStatus = (cb: (event: AiStatusEvent) => void): Promise<UnlistenFn> =>
  listen<AiStatusEvent>('ai-status', e => cb(e.payload))

export const onAiStreamChunk = (cb: (event: AiStreamChunkEvent) => void): Promise<UnlistenFn> =>
  listen<AiStreamChunkEvent>('ai-stream-chunk', e => cb(e.payload))

export const onAiError = (cb: (event: AiErrorEvent) => void): Promise<UnlistenFn> =>
  listen<AiErrorEvent>('ai-error', e => cb(e.payload))
