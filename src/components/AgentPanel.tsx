import { useEffect, useMemo, useRef, useState } from 'react'
import type { Connection } from '../store'
import {
  createAiConversation,
  listAiConversations,
  listAiMessages,
  listAiProviders,
  onAiError,
  onAiStatus,
  onAiStreamChunk,
  readTerminal,
  saveAiProvider,
  sendAiMessage,
  type AiConversation,
  type AiMessage,
  type AiProvider,
  type AiProviderKind,
} from '../lib/ai'
import { sshInput } from '../lib/ssh'

type Line = { id: string; role: string; text: string; pending?: boolean; busy?: boolean }
type Approval = { id: string; cmd: string; purpose: string; status: 'pending' | 'approved' | 'denied' }

export function AgentPanel({ active, width }: { active: Connection | undefined; width: number }) {
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [conversation, setConversation] = useState<AiConversation | null>(null)
  const [conversations, setConversations] = useState<AiConversation[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('idle')
  const [notice, setNotice] = useState('')
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [showSessions, setShowSessions] = useState(false)
  const [selectedSession, setSelectedSession] = useState(0)
  const [providerForm, setProviderForm] = useState({
    name: 'OpenAI',
    apiKind: 'openai_responses' as AiProviderKind,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    apiKey: '',
    contextWindowTokens: 258000,
  })
  const transcriptRef = useRef<HTMLDivElement>(null)
  const activeServerKey = active ? `${active.username}@${active.host}:${active.port}` : ''
  const defaultProvider = providers.find(p => p.isDefault) ?? providers[0]

  useEffect(() => {
    listAiProviders().then(setProviders).catch(err => setNotice(String(err)))
  }, [])

  useEffect(() => {
    if (!activeServerKey) {
      setConversation(null)
      setLines([])
      setConversations([])
      return
    }
    listAiConversations(activeServerKey, active?.id)
      .then(items => {
        setConversations(items)
        setConversation(items[0] ?? null)
        if (items[0]) loadMessages(items[0].id)
        else setLines([])
      })
      .catch(err => setNotice(String(err)))
  }, [activeServerKey, active?.id])

  useEffect(() => {
    let unStatus: (() => void) | undefined
    let unChunk: (() => void) | undefined
    let unError: (() => void) | undefined
    onAiStatus(e => {
      if (conversation && e.conversationId !== conversation.id) return
      setStatus(e.status)
      if (e.status === 'streaming') {
        setLines(prev => {
          const current = prev[prev.length - 1]
          if (current?.pending) return prev
          return [...prev, { id: `stream-${Date.now()}`, role: 'assistant', text: '', pending: true, busy: true }]
        })
      }
      if (e.status === 'done') {
        setLines(prev => prev.map(line => line.pending ? { ...line, pending: false, busy: false } : line))
      }
      if (e.message) setNotice(e.message)
    }).then(fn => { unStatus = fn })
    onAiStreamChunk(e => {
      if (conversation && e.conversationId !== conversation.id) return
      setLines(prev => {
        const current = prev[prev.length - 1]
        if (current?.pending) {
          return [...prev.slice(0, -1), { ...current, text: current.text + e.delta, busy: false }]
        }
        return [...prev, { id: `stream-${Date.now()}`, role: 'assistant', text: e.delta, pending: true }]
      })
    }).then(fn => { unChunk = fn })
    onAiError(e => {
      if (conversation && e.conversationId !== conversation.id) return
      setNotice(e.message)
      setStatus('error')
    }).then(fn => { unError = fn })
    return () => { unStatus?.(); unChunk?.(); unError?.() }
  }, [conversation?.id])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [lines])

  const header = useMemo(() => {
    if (!active) return 'No SSH session'
    return `${active.name}  ${activeServerKey}`
  }, [active, activeServerKey])

  const loadMessages = async (conversationId: string) => {
    const messages = await listAiMessages(conversationId)
    setLines(messages.map(toLine))
  }

  const ensureConversation = async () => {
    if (!active || !activeServerKey) throw new Error('No active SSH connection')
    if (conversation) return conversation
    const created = await createAiConversation({
      serverKey: activeServerKey,
      deviceId: active.id,
      activeSessionId: active.sessionId ?? null,
      providerId: defaultProvider?.id ?? null,
      title: `Session ${new Date().toLocaleString()}`,
      snapshot: {
        serverKey: activeServerKey,
        sessionId: active.sessionId ?? null,
        deviceId: active.id,
        hostname: active.name,
        username: active.username,
        host: active.host,
        port: active.port,
        terminalTitle: active.name,
      },
    })
    setConversation(created)
    setConversations(prev => [created, ...prev])
    return created
  }

  const createNewSession = async () => {
    if (!active || !activeServerKey) return
    const created = await createAiConversation({
      serverKey: activeServerKey,
      deviceId: active.id,
      activeSessionId: active.sessionId ?? null,
      providerId: defaultProvider?.id ?? null,
      title: `Session ${new Date().toLocaleString()}`,
      snapshot: {
        serverKey: activeServerKey,
        sessionId: active.sessionId ?? null,
        deviceId: active.id,
        hostname: active.name,
        username: active.username,
        host: active.host,
        port: active.port,
        terminalTitle: active.name,
      },
    })
    setConversation(created)
    setConversations(prev => [created, ...prev])
    setLines([])
    setShowSessions(false)
  }

  const selectConversation = async (item: AiConversation) => {
    setConversation(item)
    setShowSessions(false)
    await loadMessages(item.id)
  }

  const submit = async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    setNotice('')
    if (text === '/sessions' || text === '/seesions') {
      const items = await listAiConversations(activeServerKey, active?.id)
      setConversations(items)
      setShowSessions(true)
      setSelectedSession(0)
      return
    }
    if (text === '/new-session') {
      await createNewSession()
      return
    }
    if (text.startsWith('/exec ')) {
      const cmd = text.slice(6).trim()
      if (!cmd) return
      const approval = {
        id: `approval-${Date.now()}`,
        cmd,
        purpose: 'Manual exec_command request from Agent panel.',
        status: 'pending' as const,
      }
      setApprovals(prev => [approval, ...prev])
      setLines(prev => [...prev, { id: approval.id, role: 'tool', text: `approval requested\n$ ${cmd}` }])
      return
    }
    const conv = await ensureConversation()
    setLines(prev => [...prev.filter(l => !l.pending), { id: `user-${Date.now()}`, role: 'user', text }])
    try {
      let terminalContext: string | null = null
      if (active?.sessionId) {
        try {
          terminalContext = (await readTerminal(active.sessionId, 120)).text
        } catch (err) {
          setNotice(`Terminal context unavailable: ${String(err)}`)
        }
      }
      await sendAiMessage(conv.id, active?.sessionId ?? null, text, terminalContext)
    } catch (err) {
      setLines(prev => prev.map(line => line.pending ? { ...line, pending: false, busy: false } : line))
      setNotice(String(err))
    }
  }

  const saveProviderForm = async () => {
    const provider = await saveAiProvider({
      ...providerForm,
      isDefault: true,
      maxTokens: 4096,
      temperature: 0.7,
      timeoutSecs: 120,
    })
    setProviders([provider])
    setProviderForm(prev => ({ ...prev, apiKey: '' }))
  }

  const approveExec = async (approval: Approval) => {
    if (!active?.sessionId) {
      setNotice('No active SSH session to execute command.')
      return
    }
    await sshInput(active.sessionId, Array.from(new TextEncoder().encode(`${approval.cmd}\n`)))
    setApprovals(prev => prev.map(item => item.id === approval.id ? { ...item, status: 'approved' } : item))
    setLines(prev => [...prev, { id: `${approval.id}-approved`, role: 'tool', text: `approved and written to main SSH terminal\n$ ${approval.cmd}` }])
  }

  const denyExec = (approval: Approval) => {
    setApprovals(prev => prev.map(item => item.id === approval.id ? { ...item, status: 'denied' } : item))
    setLines(prev => [...prev, { id: `${approval.id}-denied`, role: 'tool', text: `denied\n$ ${approval.cmd}` }])
  }

  const onComposerKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSessions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedSession(v => Math.min(conversations.length - 1, v + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedSession(v => Math.max(0, v - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = conversations[selectedSession]
        if (item) selectConversation(item)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowSessions(false)
        return
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  if (!active) {
    return <div style={s.empty}>Connect to an SSH session to start Shelly Agent.</div>
  }

  return (
    <div style={s.root}>
      <div style={s.status}>
        <span style={s.dot} />
        <span style={s.statusText}>{header}</span>
        <span style={s.runState}>{statusLabel(status)}</span>
        <span style={s.badge}>{defaultProvider?.model ?? 'no provider'}</span>
      </div>

      {providers.length === 0 && (
        <div style={s.providerBox}>
          <div style={s.sectionTitle}>provider</div>
          <input style={s.input} value={providerForm.name} onChange={e => setProviderForm(v => ({ ...v, name: e.target.value }))} placeholder="Provider name" />
          <select style={s.input} value={providerForm.apiKind} onChange={e => setProviderForm(v => ({ ...v, apiKind: e.target.value as AiProviderKind }))}>
            <option value="openai_responses">OpenAI Responses</option>
            <option value="claude_messages">Claude Messages</option>
          </select>
          <input style={s.input} value={providerForm.baseUrl} onChange={e => setProviderForm(v => ({ ...v, baseUrl: e.target.value }))} placeholder="Base URL" />
          <input style={s.input} value={providerForm.model} onChange={e => setProviderForm(v => ({ ...v, model: e.target.value }))} placeholder="Model" />
          <input style={s.input} type="password" value={providerForm.apiKey} onChange={e => setProviderForm(v => ({ ...v, apiKey: e.target.value }))} placeholder="API key" />
          <button style={s.primaryBtn} onClick={saveProviderForm}>save provider</button>
        </div>
      )}

      <div ref={transcriptRef} style={s.transcript}>
        {lines.length === 0 ? (
          <div style={s.hint}>
            <div>agent ready</div>
            <div>Try asking about this SSH session, or type /sessions.</div>
          </div>
        ) : lines.map(line => (
          <div key={line.id} style={s.line}>
            <span style={line.role === 'user' ? s.userRole : s.agentRole}>{line.role}</span>
            <pre style={s.text}>{line.busy && !line.text ? 'thinking...' : line.text}</pre>
          </div>
        ))}
        {showSessions && (
          <div style={s.sessions}>
            <div style={s.sectionTitle}>sessions</div>
            {conversations.length === 0 ? <div style={s.hint}>No saved sessions for this server.</div> : conversations.map((item, index) => (
              <button
                key={item.id}
                style={{ ...s.sessionItem, ...(index === selectedSession ? s.sessionItemOn : {}) }}
                onMouseEnter={() => setSelectedSession(index)}
                onClick={() => selectConversation(item)}
              >
                <span>{item.title ?? 'Untitled session'}</span>
                <small>{new Date(item.updatedAt).toLocaleString()} · ~{item.estimatedTokens} tokens</small>
              </button>
            ))}
          </div>
        )}
        {approvals.filter(item => item.status === 'pending').map(approval => (
          <div key={approval.id} style={s.approval}>
            <div style={s.sectionTitle}>exec_command approval</div>
            <pre style={s.approvalCmd}>$ {approval.cmd}</pre>
            <div style={s.approvalPurpose}>{approval.purpose}</div>
            <div style={s.approvalActions}>
              <button style={s.denyBtn} onClick={() => denyExec(approval)}>deny</button>
              <button style={s.approveBtn} onClick={() => approveExec(approval)}>approve</button>
            </div>
          </div>
        ))}
      </div>

      {notice && <div style={s.notice}>{notice}</div>}
      <div style={s.composer}>
        <span style={s.prompt}>›</span>
        <input
          style={s.composerInput}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onComposerKey}
          placeholder={width < 300 ? '/sessions' : 'Ask Shelly Agent, /sessions, /new-session, /exec <cmd>'}
          spellCheck={false}
        />
        <button style={s.sendBtn} onClick={submit} disabled={status === 'streaming'}>{status === 'streaming' ? '...' : 'send'}</button>
      </div>
    </div>
  )
}

function toLine(msg: AiMessage): Line {
  return {
    id: msg.id,
    role: msg.role,
    text: msg.content ?? '',
  }
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    idle: 'idle',
    saving: 'saving',
    streaming: 'thinking',
    done: 'done',
    error: 'error',
    context_warning: 'context',
  }
  return labels[status] ?? status
}

const s: Record<string, React.CSSProperties> = {
  root: { height:'100%', display:'flex', flexDirection:'column', minHeight:0, background:'#1e1e1e', fontFamily:'var(--fm)' },
  empty: { padding:16, color:'#686868', fontSize:11, lineHeight:1.6 },
  status: { height:32, display:'flex', alignItems:'center', gap:8, padding:'0 10px', borderBottom:'1px solid rgba(255,255,255,0.06)', flexShrink:0 },
  dot: { width:7, height:7, borderRadius:10, background:'#4ec9b0', flexShrink:0 },
  statusText: { flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'#9d9d9d', fontSize:10 },
  runState: { color:'#4ec9b0', fontSize:10, textTransform:'uppercase', letterSpacing:'0.04em' },
  badge: { maxWidth:120, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'#569cd6', fontSize:10 },
  providerBox: { padding:10, display:'flex', flexDirection:'column', gap:6, borderBottom:'1px solid rgba(255,255,255,0.06)', flexShrink:0 },
  sectionTitle: { color:'#686868', fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em' },
  input: { height:26, background:'#252526', color:'#d4d4d4', border:'1px solid rgba(255,255,255,0.08)', borderRadius:3, padding:'0 7px', fontFamily:'var(--fm)', fontSize:11 },
  primaryBtn: { height:26, border:'none', borderRadius:3, background:'#569cd6', color:'#0b1b24', fontSize:11, cursor:'pointer' },
  transcript: { flex:1, minHeight:0, overflowY:'auto', padding:10 },
  hint: { color:'#686868', fontSize:11, lineHeight:1.7 },
  line: { display:'grid', gridTemplateColumns:'68px minmax(0,1fr)', gap:8, alignItems:'start', marginBottom:10 },
  userRole: { color:'#4ec9b0', fontSize:10, textTransform:'uppercase' },
  agentRole: { color:'#569cd6', fontSize:10, textTransform:'uppercase' },
  text: { margin:0, whiteSpace:'pre-wrap', wordBreak:'break-word', color:'#d4d4d4', fontSize:11, lineHeight:1.55, fontFamily:'var(--fm)' },
  sessions: { border:'1px solid rgba(255,255,255,0.08)', background:'#252526', borderRadius:4, padding:6, display:'flex', flexDirection:'column', gap:4 },
  sessionItem: { display:'flex', flexDirection:'column', alignItems:'stretch', gap:2, textAlign:'left', border:'none', background:'transparent', color:'#d4d4d4', padding:'6px 7px', borderRadius:3, cursor:'pointer', fontFamily:'var(--fm)', fontSize:11 },
  sessionItemOn: { background:'rgba(86,156,214,0.18)' },
  notice: { flexShrink:0, color:'#f0c674', background:'rgba(240,198,116,0.08)', borderTop:'1px solid rgba(240,198,116,0.14)', padding:'6px 10px', fontSize:10, lineHeight:1.5 },
  approval: { border:'1px solid rgba(244,191,117,0.24)', background:'rgba(244,191,117,0.08)', borderRadius:4, padding:8, marginTop:8, display:'flex', flexDirection:'column', gap:7 },
  approvalCmd: { margin:0, color:'#d4d4d4', fontSize:11, whiteSpace:'pre-wrap', wordBreak:'break-word', fontFamily:'var(--fm)' },
  approvalPurpose: { color:'#9d9d9d', fontSize:10, lineHeight:1.5 },
  approvalActions: { display:'flex', justifyContent:'flex-end', gap:6 },
  denyBtn: { border:'1px solid rgba(255,255,255,0.09)', borderRadius:3, background:'transparent', color:'#9d9d9d', fontSize:10, padding:'4px 8px', cursor:'pointer' },
  approveBtn: { border:'none', borderRadius:3, background:'#569cd6', color:'#0b1b24', fontSize:10, padding:'4px 8px', cursor:'pointer' },
  composer: { height:36, borderTop:'1px solid rgba(255,255,255,0.06)', display:'flex', alignItems:'center', gap:7, padding:'0 8px', flexShrink:0 },
  prompt: { color:'#569cd6', fontSize:13 },
  composerInput: { flex:1, minWidth:0, border:'none', outline:'none', background:'transparent', color:'#d4d4d4', fontFamily:'var(--fm)', fontSize:11 },
  sendBtn: { border:'none', borderRadius:3, background:'#2d2d2d', color:'#9d9d9d', padding:'4px 7px', fontSize:10, cursor:'pointer' },
}
