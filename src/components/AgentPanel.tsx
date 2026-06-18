import { useEffect, useMemo, useRef, useState } from 'react'
import type { Connection } from '../store'
import { useI18n, tr, type I18nKey } from '../i18n'
import {
  approveAiTool,
  bindAiConversationSession,
  completeInteractiveAiTool,
  createAiConversation,
  denyAiTool,
  executeApprovedAiTool,
  listAiConversations,
  listAiMessages,
  listAiProviders,
  onAiError,
  onAiStatus,
  onAiStreamChunk,
  onAiStreamReset,
  onAiToolApproval,
  onAiToolResult,
  onAiToolStarted,
  readTerminal,
  saveAiProvider,
  sendAiMessage,
  type AiConversation,
  type AiMessage,
  type AiProvider,
  type AiProviderKind,
  type SaveAiSessionSnapshotInput,
} from '../lib/ai'
import { sshInput } from '../lib/ssh'

type Line = { id: string; role: string; text: string; pending?: boolean; busy?: boolean; expanded?: boolean }
type Approval = {
  id: string
  toolRunId?: string
  conversationId?: string
  cmd: string
  purpose: string
  status: 'pending' | 'approved' | 'denied' | 'blocked'
  riskLevel?: string
  riskReasons?: string[]
  interactionTip?: string
}

type InteractivePrompt = { approval: Approval; dontShowAgain: boolean }
type InteractiveHandoff = { approval: Approval; sessionId: string; baselineText: string }

export function AgentPanel({ active, width }: { active: Connection | undefined; width: number }) {
  const { language, t } = useI18n()
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [conversation, setConversation] = useState<AiConversation | null>(null)
  const [conversations, setConversations] = useState<AiConversation[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('idle')
  const [statusTick, setStatusTick] = useState(0)
  const [notice, setNotice] = useState('')
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [interactivePrompt, setInteractivePrompt] = useState<InteractivePrompt | null>(null)
  const [interactiveHandoff, setInteractiveHandoff] = useState<InteractiveHandoff | null>(null)
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
  const streamLineIdRef = useRef<string | null>(null)
  const streamTextRef = useRef('')
  const streamQueueRef = useRef('')
  const streamTimerRef = useRef<number | null>(null)
  const streamFinishPendingRef = useRef(false)
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
    let unReset: (() => void) | undefined
    let unError: (() => void) | undefined
    let unApproval: (() => void) | undefined
    let unToolStarted: (() => void) | undefined
    let unToolResult: (() => void) | undefined
    let disposed = false
    onAiStatus(e => {
      if (conversation && e.conversationId !== conversation.id) return
      setStatus(e.status)
      if (e.status === 'streaming') {
        beginStreamLine()
      }
      if (e.status === 'done') {
        finishStreamLine()
      }
      if (e.status === 'waiting_approval') {
        finishStreamLine()
      }
      if (e.message) setNotice(e.message)
    }).then(fn => { if (disposed) fn(); else unStatus = fn })
    onAiStreamChunk(e => {
      if (conversation && e.conversationId !== conversation.id) return
      enqueueStreamDelta(e.delta)
    }).then(fn => { if (disposed) fn(); else unChunk = fn })
    onAiStreamReset(e => {
      if (conversation && e.conversationId !== conversation.id) return
      resetStreamLine(e.message)
    }).then(fn => { if (disposed) fn(); else unReset = fn })
    onAiError(e => {
      if (conversation && e.conversationId !== conversation.id) return
      setNotice(e.message)
      setStatus('error')
      finishStreamLine()
    }).then(fn => { if (disposed) fn(); else unError = fn })
    onAiToolApproval(e => {
      if (conversation && e.conversationId !== conversation.id) return
      const cmd = e.command ?? e.argsJson
      const approval: Approval = {
        id: e.toolRunId,
        toolRunId: e.toolRunId,
        conversationId: e.conversationId,
        cmd,
        purpose: e.purpose ?? 'Model requested exec_command.',
        status: e.riskLevel === 'blocked' ? 'blocked' : 'pending',
        riskLevel: e.riskLevel,
        riskReasons: e.riskReasons,
        interactionTip: e.interactionTip ?? undefined,
      }
      setApprovals(prev => prev.some(item => item.id === approval.id) ? prev : [approval, ...prev])
      setLines(prev => [
        ...prev.filter(line => !(line.pending && !line.text)),
        { id: `approval-line-${approval.id}`, role: 'tool', text: `${t('shell.approvalRequested')} (${approval.riskLevel ?? 'unknown'})\n$ ${cmd}` },
      ])
    }).then(fn => { if (disposed) fn(); else unApproval = fn })
    onAiToolStarted(e => {
      if (conversation && e.conversationId !== conversation.id) return
      setStatus('executing_tool')
      setLines(prev => {
        const id = `${e.toolRunId}-started`
        if (prev.some(line => line.id === id)) return prev
        return [...prev, { id, role: 'tool', text: `${t('shell.commandRunning')}\n$ ${e.command}` }]
      })
    }).then(fn => { if (disposed) fn(); else unToolStarted = fn })
    onAiToolResult(e => {
      if (conversation && e.conversationId !== conversation.id) return
      setInteractiveHandoff(prev => prev?.approval.toolRunId === e.toolRunId ? null : prev)
      if (e.runStatus === 'timeout') setStatus('timeout')
      setLines(prev => {
        const id = `${e.toolRunId}-result`
        if (prev.some(line => line.id === id)) return prev
        return [...prev, {
          id,
          role: 'tool',
          text: `${toolResultLabel(e.runStatus, e.timedOut, language)} (${e.runStatus})\n${e.output}`,
        }]
      })
    }).then(fn => { if (disposed) fn(); else unToolResult = fn })
    return () => {
      disposed = true
      unStatus?.()
      unChunk?.()
      unReset?.()
      unError?.()
      unApproval?.()
      unToolStarted?.()
      unToolResult?.()
    }
  }, [conversation?.id, language])

  useEffect(() => {
    return () => {
      if (streamTimerRef.current !== null) {
        window.clearInterval(streamTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isWorkingStatus(status)) return
    const timer = window.setInterval(() => {
      setStatusTick(tick => (tick + 1) % 4)
    }, 420)
    return () => window.clearInterval(timer)
  }, [status])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [lines])

  const beginStreamLine = () => {
    setLines(prev => {
      const current = prev[prev.length - 1]
      if (current?.pending) {
        streamLineIdRef.current = current.id
        return prev
      }
      streamTextRef.current = ''
      streamQueueRef.current = ''
      streamFinishPendingRef.current = false
      const id = `stream-${Date.now()}`
      streamLineIdRef.current = id
      return [...prev, { id, role: 'assistant', text: '', pending: true, busy: true }]
    })
  }

  const enqueueStreamDelta = (delta: string) => {
    const append = normalizeStreamDelta(streamTextRef.current, delta)
    if (!append) return
    if (!streamLineIdRef.current) beginStreamLine()
    streamTextRef.current += append
    streamQueueRef.current += append
    startStreamTimer()
  }

  const startStreamTimer = () => {
    if (streamTimerRef.current !== null) return
    streamTimerRef.current = window.setInterval(() => {
      const queue = streamQueueRef.current
      if (!queue) {
        if (streamFinishPendingRef.current) {
          markStreamLineDone()
        }
        if (streamTimerRef.current !== null) {
          window.clearInterval(streamTimerRef.current)
          streamTimerRef.current = null
        }
        return
      }
      const take = Math.min(queue.length, 8)
      const piece = queue.slice(0, take)
      streamQueueRef.current = queue.slice(take)
      const id = streamLineIdRef.current
      if (!id) return
      setLines(prev => prev.map(line => (
        line.id === id ? { ...line, text: line.text + piece, busy: false } : line
      )))
    }, 18)
  }

  const finishStreamLine = () => {
    streamFinishPendingRef.current = true
    if (streamQueueRef.current) {
      startStreamTimer()
      return
    }
    markStreamLineDone()
  }

  const markStreamLineDone = () => {
    const id = streamLineIdRef.current
    setLines(prev => prev
      .filter(line => !(line.id === id && line.pending && !line.text))
      .map(line => line.id === id || line.pending ? { ...line, pending: false, busy: false } : line))
    streamLineIdRef.current = null
    streamQueueRef.current = ''
    streamFinishPendingRef.current = false
  }

  const resetStreamLine = (message: string) => {
    if (streamTimerRef.current !== null) {
      window.clearInterval(streamTimerRef.current)
      streamTimerRef.current = null
    }
    const id = streamLineIdRef.current
    streamLineIdRef.current = null
    streamTextRef.current = ''
    streamQueueRef.current = ''
    streamFinishPendingRef.current = false
    setLines(prev => [
      ...prev.filter(line => !(line.id === id && line.pending)),
      { id: `guard-${Date.now()}`, role: 'guard', text: message },
    ])
    setNotice(message)
  }

  const header = useMemo(() => {
    if (!active) return t('shell.noSshSession')
    return `${active.name}  ${activeServerKey}`
  }, [active, activeServerKey, t])

  const loadMessages = async (conversationId: string) => {
    const messages = await listAiMessages(conversationId)
    setLines(messages.map(toLine))
  }

  const ensureConversation = async () => {
    if (!active || !activeServerKey) throw new Error(t('shell.noActiveConnection'))
    if (conversation) return conversation
    const created = await createAiConversation({
      serverKey: activeServerKey,
      deviceId: active.id,
      activeSessionId: active.sessionId ?? null,
      providerId: defaultProvider?.id ?? null,
      title: `Session ${new Date().toLocaleString()}`,
      snapshot: buildSessionSnapshot(active, activeServerKey),
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
      snapshot: buildSessionSnapshot(active, activeServerKey),
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
        purpose: t('shell.manualExecPurpose'),
        status: 'pending' as const,
      }
      setApprovals(prev => [approval, ...prev])
      setLines(prev => [...prev, { id: approval.id, role: 'tool', text: `${t('shell.approvalRequested')}\n$ ${cmd}` }])
      return
    }
    const conv = await ensureConversation()
    setLines(prev => [...prev.filter(l => !l.pending), { id: `user-${Date.now()}`, role: 'user', text }])
    try {
      let terminalContext: string | null = null
      if (active?.sessionId) {
        try {
          terminalContext = (await readTerminal(active.sessionId, 120)).text
          await refreshConversationSnapshot(conv.id, terminalContext)
        } catch (err) {
          setNotice(t('shell.terminalContextUnavailable').replace('{error}', String(err)))
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

  const refreshConversationSnapshot = async (conversationId: string, terminalContext: string | null) => {
    if (!active || !activeServerKey) return
    await bindAiConversationSession(
      conversationId,
      active.sessionId ?? null,
      buildSessionSnapshot(active, activeServerKey, terminalContext),
    )
  }

  const approveExec = async (approval: Approval) => {
    if (!active?.sessionId) {
      setNotice(t('shell.noActiveSession'))
      return
    }
    if (approval.riskLevel === 'interactive') {
      if (!interactiveWarningDismissed()) {
        setInteractivePrompt({ approval, dontShowAgain: false })
        return
      }
      await startInteractiveHandoff(approval)
      return
    }
    if (approval.toolRunId) {
      await approveAiTool(approval.toolRunId)
      setApprovals(prev => prev.map(item => item.id === approval.id ? { ...item, status: 'approved' } : item))
      setLines(prev => [...prev, { id: `${approval.id}-approved`, role: 'tool', text: `${t('shell.toolApproved')}\n$ ${approval.cmd}` }])
      setStatus('executing_tool')
      try {
        await executeApprovedAiTool(approval.toolRunId, active.sessionId)
      } catch (err) {
        setNotice(String(err))
        setStatus('error')
      }
      return
    }
    await sshInput(active.sessionId, Array.from(new TextEncoder().encode(`${approval.cmd}\n`)))
    setApprovals(prev => prev.map(item => item.id === approval.id ? { ...item, status: 'approved' } : item))
    setLines(prev => [...prev, { id: `${approval.id}-approved`, role: 'tool', text: `${t('shell.toolApproved')}\n$ ${approval.cmd}` }])
    setStatus('done')
  }

  const startInteractiveHandoff = async (approval: Approval) => {
    if (!active?.sessionId) {
      setNotice(t('shell.noActiveSession'))
      return
    }
    if (approval.toolRunId) {
      await approveAiTool(approval.toolRunId)
    }
    const before = await readTerminal(active.sessionId, 500).catch(() => null)
    await sshInput(active.sessionId, Array.from(new TextEncoder().encode(`${approval.cmd}\n`)))
    setApprovals(prev => prev.map(item => item.id === approval.id ? { ...item, status: 'approved' } : item))
    setInteractiveHandoff({
      approval,
      sessionId: active.sessionId,
      baselineText: before?.text ?? '',
    })
    setLines(prev => [...prev, {
      id: `${approval.id}-interactive`,
      role: 'tool',
      text: `${t('shell.handoffStarted')}\n$ ${approval.cmd}\n${t('shell.handoffWaitingHint')}`,
    }])
    setStatus('interactive_handoff')
  }

  const confirmInteractivePrompt = async () => {
    if (!interactivePrompt) return
    if (interactivePrompt.dontShowAgain) {
      localStorage.setItem('shelly:interactiveCommandWarningDismissed', '1')
    }
    const approval = interactivePrompt.approval
    setInteractivePrompt(null)
    await startInteractiveHandoff(approval)
  }

  const denyExec = async (approval: Approval) => {
    if (approval.toolRunId) {
      setApprovals(prev => prev.map(item => item.id === approval.id ? { ...item, status: 'denied' } : item))
      await denyAiTool(approval.toolRunId)
      return
    }
    setApprovals(prev => prev.map(item => item.id === approval.id ? { ...item, status: 'denied' } : item))
    setLines(prev => [...prev, { id: `${approval.id}-denied`, role: 'tool', text: `${t('shell.denied')}\n$ ${approval.cmd}` }])
    setStatus('done')
  }

  const continueInteractiveHandoff = async () => {
    if (!interactiveHandoff?.approval.toolRunId) return
    setStatus('executing_tool')
    setNotice('')
    try {
      const snapshot = await readTerminal(interactiveHandoff.sessionId, 500)
      const output = terminalDelta(interactiveHandoff.baselineText, snapshot.text)
      setLines(prev => [...prev, {
        id: `${interactiveHandoff.approval.id}-interactive-complete`,
        role: 'tool',
        text: `${t('shell.handoffComplete')}\n${t('shell.handoffCaptured').replace('{count}', String(output.length))}`,
      }])
      await completeInteractiveAiTool(interactiveHandoff.approval.toolRunId, interactiveHandoff.sessionId, output)
      setInteractiveHandoff(null)
    } catch (err) {
      setNotice(String(err))
      setStatus('error')
    }
  }

  const dismissInteractiveHandoff = () => {
    if (!interactiveHandoff) return
    setLines(prev => [...prev, {
      id: `${interactiveHandoff.approval.id}-interactive-dismissed`,
      role: 'tool',
      text: t('shell.handoffDismissed'),
    }])
    setInteractiveHandoff(null)
    setStatus('done')
  }

  const toggleLineExpanded = (id: string) => {
    setLines(prev => prev.map(line => line.id === id ? { ...line, expanded: !line.expanded } : line))
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
    return <div style={s.empty}>{t('shell.noSshSession')}</div>
  }

  return (
    <div style={s.root}>
      <div style={s.status}>
        <span style={{ ...s.dot, ...statusDotStyle(status, statusTick) }} />
        <span style={s.statusText}>{header}</span>
        <span style={s.runState}>{statusLabel(status, statusTick, language)}</span>
        <span style={s.badge}>{defaultProvider?.model ?? t('shell.noProvider')}</span>
      </div>

      {providers.length === 0 && (
        <div style={s.providerBox}>
          <div style={s.sectionTitle}>{t('shell.provider')}</div>
          <input style={s.input} value={providerForm.name} onChange={e => setProviderForm(v => ({ ...v, name: e.target.value }))} placeholder={t('model.providerName')} />
          <select style={s.input} value={providerForm.apiKind} onChange={e => setProviderForm(v => ({ ...v, apiKind: e.target.value as AiProviderKind }))}>
            <option value="openai_responses">OpenAI Responses</option>
            <option value="claude_messages">Claude Messages</option>
          </select>
          <input style={s.input} value={providerForm.baseUrl} onChange={e => setProviderForm(v => ({ ...v, baseUrl: e.target.value }))} placeholder={t('model.baseUrl')} />
          <input style={s.input} value={providerForm.model} onChange={e => setProviderForm(v => ({ ...v, model: e.target.value }))} placeholder={t('model.model')} />
          <input style={s.input} type="password" value={providerForm.apiKey} onChange={e => setProviderForm(v => ({ ...v, apiKey: e.target.value }))} placeholder={t('model.apiKey')} />
          <button style={s.primaryBtn} onClick={saveProviderForm}>{t('model.saveProvider')}</button>
        </div>
      )}

      <div ref={transcriptRef} style={s.transcript}>
        {lines.length === 0 ? (
          <div style={s.hint}>
            <div>{t('shell.agentReady')}</div>
            <div>{t('shell.agentReadyHint')}</div>
          </div>
        ) : lines.map(line => (
          <div key={line.id} style={s.line}>
            <span style={roleStyle(line.role)}>{line.role}</span>
            <div style={s.lineBody}>
              <pre style={s.text}>{line.busy && !line.text ? thinkingLabel(statusTick, language) : displayLineText(line, language)}</pre>
              {isLongLine(line) && (
                <button style={s.inlineBtn} onClick={() => toggleLineExpanded(line.id)}>
                  {line.expanded ? t('shell.collapse') : t('shell.showFull')}
                </button>
              )}
            </div>
          </div>
        ))}
        {showSessions && (
          <div style={s.sessions}>
            <div style={s.sectionTitle}>{t('shell.sessions')}</div>
            {conversations.length === 0 ? <div style={s.hint}>{t('shell.noSavedSessions')}</div> : conversations.map((item, index) => (
              <button
                key={item.id}
                style={{ ...s.sessionItem, ...(index === selectedSession ? s.sessionItemOn : {}) }}
                onMouseEnter={() => setSelectedSession(index)}
                onClick={() => selectConversation(item)}
              >
                <span>{item.title ?? t('shell.untitledSession')}</span>
                <small>{new Date(item.updatedAt).toLocaleString()} · ~{item.estimatedTokens} {t('shell.tokens')}</small>
              </button>
            ))}
          </div>
        )}
        {approvals.filter(item => item.status === 'pending' || item.status === 'blocked').map(approval => {
          const isInteractive = approval.riskLevel === 'interactive'
          return (
          <div key={approval.id} style={{ ...s.approval, ...(isInteractive ? s.approvalInteractive : {}) }}>
            <div style={s.approvalHeader}>
              <div style={s.sectionTitle}>{isInteractive ? t('shell.interactiveHandoff') : t('shell.approval')}</div>
              {isInteractive && <span style={s.interactivePill}>{t('shell.userInputRequired')}</span>}
            </div>
            <pre style={s.approvalCmd}>$ {approval.cmd}</pre>
            <div style={s.approvalPurpose}>{approval.purpose}</div>
            {isInteractive && (
              <div style={s.interactionTip}>
                <strong>{t('shell.tip')}</strong>
                <span>{approval.interactionTip || approval.riskReasons?.join(' · ') || t('shell.interactiveTipFallback')}</span>
              </div>
            )}
            {approval.riskLevel && (
              <div style={s.risk}>
                <span>{approval.riskLevel}</span>
                <small>{approval.riskReasons?.join(' · ')}</small>
              </div>
            )}
            <div style={s.approvalActions}>
              <button style={s.denyBtn} onClick={() => denyExec(approval)}>{approval.status === 'blocked' ? t('general.dismiss') : t('shell.deny')}</button>
              {approval.status !== 'blocked' && <button style={isInteractive ? s.interactiveApproveBtn : s.approveBtn} onClick={() => approveExec(approval)}>{isInteractive ? t('shell.handoff') : t('shell.approve')}</button>}
            </div>
          </div>
          )
        })}
        {interactiveHandoff && (
          <div style={s.handoffPanel}>
            <div style={s.approvalHeader}>
              <div style={s.sectionTitle}>{t('shell.handoffWaiting')}</div>
              <span style={s.interactivePill}>{t('shell.manualTerminal')}</span>
            </div>
            <pre style={s.approvalCmd}>$ {interactiveHandoff.approval.cmd}</pre>
            <div style={s.approvalPurpose}>
              {t('shell.handoffWaitingHint')}
            </div>
            <div style={s.approvalActions}>
              <button style={s.denyBtn} onClick={dismissInteractiveHandoff}>{t('general.dismiss')}</button>
              <button style={s.interactiveApproveBtn} onClick={continueInteractiveHandoff}>{t('shell.continue')}</button>
            </div>
          </div>
        )}
      </div>

      {interactivePrompt && (
        <div style={s.modalBackdrop}>
          <div style={s.modal}>
            <div style={s.modalTitle}>{t('shell.interactiveCommand')}</div>
            <div style={s.modalWarning}>{t('shell.interactiveModalWarning')}</div>
            <div style={s.modalText}>
              {t('shell.interactiveModalText')}
            </div>
            <label style={s.modalCheck}>
              <input
                type="checkbox"
                checked={interactivePrompt.dontShowAgain}
                onChange={e => setInteractivePrompt(prev => prev ? { ...prev, dontShowAgain: e.target.checked } : prev)}
              />
              <span>{t('shell.savedDontRemind')}</span>
            </label>
            <div style={s.modalActions}>
              <button style={s.gotItBtn} onClick={confirmInteractivePrompt}>{t('shell.gotIt')}</button>
            </div>
          </div>
        </div>
      )}

      {notice && <div style={s.notice}>{notice}</div>}
      <div style={s.composer}>
        <span style={s.prompt}>?</span>
        <input
          style={s.composerInput}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onComposerKey}
          placeholder={width < 300 ? '/sessions' : t('shell.askPlaceholder')}
          spellCheck={false}
        />
        <button style={s.sendBtn} onClick={submit} disabled={status === 'streaming'}>{status === 'streaming' ? '...' : t('general.send')}</button>
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

function statusLabel(status: string, tick = 0, language: 'en' | 'zh-CN' = 'en') {
  const labels: Record<string, I18nKey> = {
    idle: 'status.idle',
    saving: 'status.saving',
    streaming: 'status.thinking',
    waiting_approval: 'status.approval',
    executing_tool: 'status.executing',
    interactive_handoff: 'status.handoff',
    done: 'status.done',
    error: 'status.error',
    timeout: 'status.timeout',
    context_warning: 'status.context',
  }
  const label = labels[status] ? tr(language, labels[status]) : status
  return isWorkingStatus(status) ? `${label}${'.'.repeat(tick)}` : label
}

function toolResultLabel(runStatus: string, timedOut: boolean, language: 'en' | 'zh-CN' = 'en') {
  if (timedOut || runStatus === 'timeout') return tr(language, 'shell.captureTimedOut')
  if (runStatus === 'denied') return tr(language, 'shell.denied')
  if (runStatus === 'blocked') return tr(language, 'shell.blocked')
  return tr(language, 'shell.capturedOutput')
}

function isWorkingStatus(status: string) {
  return ['saving', 'streaming', 'waiting_approval', 'executing_tool', 'interactive_handoff'].includes(status)
}

function thinkingLabel(tick: number, language: 'en' | 'zh-CN' = 'en') {
  return `${tr(language, 'shell.thinking')}${'.'.repeat(tick)}`
}

function statusDotStyle(status: string, tick: number): React.CSSProperties {
  if (!isWorkingStatus(status)) return {}
  const lift = tick % 2 === 0 ? 0 : -2
  const opacity = tick === 0 ? 0.56 : 1
  return {
    opacity,
    transform: `translateY(${lift}px) scale(${tick === 0 ? 0.82 : 1})`,
    transition: 'transform 160ms ease, opacity 160ms ease',
  }
}

function roleStyle(role: string) {
  if (role === 'user') return s.userRole
  if (role === 'tool') return s.toolRole
  if (role === 'guard') return s.guardRole
  return s.agentRole
}

function isLongLine(line: Line) {
  return line.text.length > 5000
}

function displayLineText(line: Line, language: 'en' | 'zh-CN' = 'en') {
  if (line.expanded || !isLongLine(line)) return line.text
  const preview = line.text.slice(0, 5000).trimEnd()
  return `${preview}\n\n[${tr(language, 'shell.collapsedChars').replace('{count}', String(line.text.length - preview.length))}]`
}

function buildSessionSnapshot(
  active: Connection,
  activeServerKey: string,
  terminalContext?: string | null,
): SaveAiSessionSnapshotInput {
  const facts = inferTerminalFacts(terminalContext ?? '', active.username)
  return {
    serverKey: activeServerKey,
    sessionId: active.sessionId ?? null,
    deviceId: active.id,
    hostname: facts.hostname ?? active.name,
    username: facts.username ?? active.username,
    host: active.host,
    port: active.port,
    os: facts.os ?? null,
    shell: facts.shell ?? null,
    cwd: facts.cwd ?? null,
    terminalTitle: facts.terminalTitle ?? active.name,
  }
}

function inferTerminalFacts(text: string, fallbackUser: string) {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map(cleanTerminalLine)
    .filter(Boolean)
  const prompt = [...lines].reverse().find(line => /[\w.-]+@[\w.-]+:.+[#$]\s*$/.test(line))
  const promptMatch = prompt?.match(/(?:^|\s)([\w.-]+)@([\w.-]+):(.+?)([#$])\s*$/)
  const username = promptMatch?.[1]
  const hostname = promptMatch?.[2]
  const cwd = normalizePromptCwd(promptMatch?.[3], username ?? fallbackUser)
  return {
    username,
    hostname,
    cwd,
    shell: inferShell(lines),
    os: inferOs(lines),
    terminalTitle: prompt ? prompt.replace(/\s+$/, '') : undefined,
  }
}

function cleanTerminalLine(line: string) {
  return line
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\]0;[^\x07]*\x07/g, '')
    .trim()
}

function normalizePromptCwd(cwd: string | undefined, username: string) {
  if (!cwd) return undefined
  const trimmed = cwd.trim()
  if (trimmed === '~') return username === 'root' ? '/root' : `/home/${username}`
  if (trimmed.startsWith('~/')) {
    const home = username === 'root' ? '/root' : `/home/${username}`
    return `${home}/${trimmed.slice(2)}`
  }
  return trimmed
}

function inferShell(lines: string[]) {
  const shellLine = [...lines].reverse().find(line => /(?:^|[/ ])(?:bash|zsh|fish|sh|dash|ksh)\b/.test(line) && (line.includes('/bin/') || line.startsWith('SHELL=')))
  const match = shellLine?.match(/(?:SHELL=)?(\/[\w/.-]*(?:bash|zsh|fish|dash|ksh|sh))\b/)
  return match?.[1]
}

function inferOs(lines: string[]) {
  const pretty = [...lines].reverse().find(line => line.includes('PRETTY_NAME='))
  const prettyMatch = pretty?.match(/PRETTY_NAME="?([^"\n]+)"?/)
  if (prettyMatch?.[1]) return prettyMatch[1]
  const osLine = [...lines].reverse().find(line => /(ubuntu|debian|centos|rocky|almalinux|fedora|arch linux|opensuse)/i.test(line))
  return osLine
}

function normalizeStreamDelta(existing: string, incoming: string) {
  if (!incoming) return ''
  if (!existing) return incoming
  if (incoming.startsWith(existing)) return incoming.slice(existing.length)
  if (existing.endsWith(incoming)) return ''
  const overlap = maxSuffixPrefixOverlap(existing, incoming)
  return incoming.slice(overlap)
}

function maxSuffixPrefixOverlap(existing: string, incoming: string) {
  const max = Math.min(existing.length, incoming.length)
  for (let len = max; len > 0; len -= 1) {
    if (existing.slice(existing.length - len) === incoming.slice(0, len)) {
      return len
    }
  }
  return 0
}

function terminalDelta(before: string, after: string) {
  if (!before) return after.trim()
  if (after.startsWith(before)) return after.slice(before.length).trim()
  const overlap = maxSuffixPrefixOverlap(before, after)
  if (overlap > 0) return after.slice(overlap).trim()
  return after.trim()
}

function interactiveWarningDismissed() {
  return typeof localStorage !== 'undefined' &&
    localStorage.getItem('shelly:interactiveCommandWarningDismissed') === '1'
}

const s: Record<string, React.CSSProperties> = {
  root: { position:'relative', height:'100%', display:'flex', flexDirection:'column', minHeight:0, background:'var(--c0)', fontFamily:'var(--fm)' },
  empty: { padding:16, color:'var(--t2)', fontSize:'var(--ui-font)', lineHeight:1.6 },
  status: { height:32, display:'flex', alignItems:'center', gap:8, padding:'0 10px', borderBottom:'1px solid var(--b0)', flexShrink:0 },
  dot: { width:7, height:7, borderRadius:10, background:'var(--grn)', flexShrink:0 },
  statusText: { flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--t1)', fontSize:'var(--ui-font-sm)' },
  runState: { color:'var(--grn)', fontSize:'var(--ui-font-sm)', textTransform:'uppercase', letterSpacing:'0.04em' },
  badge: { maxWidth:120, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--acc)', fontSize:'var(--ui-font-sm)' },
  providerBox: { padding:10, display:'flex', flexDirection:'column', gap:6, borderBottom:'1px solid var(--b0)', flexShrink:0 },
  sectionTitle: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', textTransform:'uppercase', letterSpacing:'0.08em' },
  input: { height:26, background:'var(--c1)', color:'var(--t0)', border:'1px solid var(--b1)', borderRadius:3, padding:'0 7px', fontFamily:'var(--fm)', fontSize:'var(--ui-font)' },
  primaryBtn: { height:26, border:'none', borderRadius:3, background:'var(--acc)', color:'#0b1b24', fontSize:'var(--ui-font)', cursor:'pointer' },
  transcript: { flex:1, minHeight:0, overflowY:'auto', padding:10 },
  hint: { color:'var(--t2)', fontSize:'var(--ui-font)', lineHeight:1.7 },
  line: { display:'grid', gridTemplateColumns:'68px minmax(0,1fr)', gap:8, alignItems:'start', marginBottom:10 },
  userRole: { color:'var(--grn)', fontSize:'var(--ui-font-sm)', textTransform:'uppercase' },
  agentRole: { color:'var(--acc)', fontSize:'var(--ui-font-sm)', textTransform:'uppercase' },
  toolRole: { color:'#ffab40', fontSize:'var(--ui-font-sm)', textTransform:'uppercase' },
  guardRole: { color:'#f48771', fontSize:'var(--ui-font-sm)', textTransform:'uppercase' },
  lineBody: { minWidth:0, display:'flex', flexDirection:'column', alignItems:'flex-start', gap:5 },
  text: { margin:0, whiteSpace:'pre-wrap', wordBreak:'break-word', color:'var(--t0)', fontSize:'var(--ui-font)', lineHeight:1.55, fontFamily:'var(--fm)' },
  inlineBtn: { border:'1px solid var(--b1)', borderRadius:3, background:'var(--c1)', color:'var(--t1)', fontSize:'var(--ui-font-sm)', padding:'3px 7px', cursor:'pointer' },
  sessions: { border:'1px solid var(--b1)', background:'var(--c1)', borderRadius:4, padding:6, display:'flex', flexDirection:'column', gap:4 },
  sessionItem: { display:'flex', flexDirection:'column', alignItems:'stretch', gap:2, textAlign:'left', border:'none', background:'transparent', color:'var(--t0)', padding:'6px 7px', borderRadius:3, cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font)' },
  sessionItemOn: { background:'rgba(86,156,214,0.18)' },
  notice: { flexShrink:0, color:'#f0c674', background:'rgba(240,198,116,0.08)', borderTop:'1px solid rgba(240,198,116,0.14)', padding:'6px 10px', fontSize:'var(--ui-font-sm)', lineHeight:1.5 },
  approval: { border:'1px solid rgba(244,191,117,0.24)', background:'rgba(244,191,117,0.08)', borderRadius:4, padding:8, marginTop:8, display:'flex', flexDirection:'column', gap:7 },
  handoffPanel: { border:'1px solid rgba(255,171,64,0.34)', background:'rgba(255,171,64,0.09)', borderRadius:4, padding:8, marginTop:8, display:'flex', flexDirection:'column', gap:7 },
  approvalInteractive: { border:'1px solid rgba(255,171,64,0.42)', background:'rgba(255,171,64,0.11)' },
  approvalHeader: { display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 },
  interactivePill: { flexShrink:0, border:'1px solid rgba(255,171,64,0.28)', borderRadius:999, color:'#ffab40', padding:'2px 6px', fontSize:9, textTransform:'uppercase', letterSpacing:'0.04em' },
  approvalCmd: { margin:0, color:'var(--t0)', fontSize:'var(--ui-font)', whiteSpace:'pre-wrap', wordBreak:'break-word', fontFamily:'var(--fm)' },
  approvalPurpose: { color:'var(--t1)', fontSize:'var(--ui-font-sm)', lineHeight:1.5 },
  risk: { display:'flex', alignItems:'center', gap:7, color:'#f0c674', fontSize:'var(--ui-font-sm)', lineHeight:1.5 },
  interactionTip: { border:'1px solid rgba(255,171,64,0.18)', background:'rgba(0,0,0,0.16)', borderRadius:4, padding:'6px 7px', display:'grid', gap:3, color:'var(--t0)', fontSize:'var(--ui-font-sm)', lineHeight:1.5 },
  approvalActions: { display:'flex', justifyContent:'flex-end', gap:6 },
  denyBtn: { border:'1px solid var(--b1)', borderRadius:3, background:'transparent', color:'var(--t1)', fontSize:'var(--ui-font-sm)', padding:'4px 8px', cursor:'pointer' },
  approveBtn: { border:'none', borderRadius:3, background:'var(--acc)', color:'#0b1b24', fontSize:'var(--ui-font-sm)', padding:'4px 8px', cursor:'pointer' },
  interactiveApproveBtn: { border:'none', borderRadius:3, background:'#ffab40', color:'var(--c0)', fontSize:'var(--ui-font-sm)', padding:'4px 8px', cursor:'pointer' },
  modalBackdrop: { position:'absolute', inset:0, zIndex:20, display:'flex', alignItems:'center', justifyContent:'center', padding:12, background:'rgba(0,0,0,0.52)' },
  modal: { width:'min(420px, 100%)', border:'1px solid rgba(255,171,64,0.38)', background:'var(--c1)', borderRadius:6, boxShadow:'0 18px 48px rgba(0,0,0,0.35)', padding:14, display:'flex', flexDirection:'column', gap:10 },
  modalTitle: { color:'#ffab40', fontSize:'var(--ui-font-md)', textTransform:'uppercase', letterSpacing:'0.06em' },
  modalWarning: { color:'var(--t0)', fontSize:'var(--ui-font-md)', lineHeight:1.6 },
  modalText: { color:'var(--t1)', fontSize:'var(--ui-font)', lineHeight:1.6 },
  modalCheck: { display:'flex', alignItems:'center', gap:7, color:'var(--t1)', fontSize:'var(--ui-font)' },
  modalActions: { display:'flex', justifyContent:'flex-end' },
  gotItBtn: { border:'none', borderRadius:3, background:'#ffab40', color:'var(--c0)', fontSize:'var(--ui-font)', padding:'5px 10px', cursor:'pointer' },
  composer: { height:36, borderTop:'1px solid var(--b0)', display:'flex', alignItems:'center', gap:7, padding:'0 8px', flexShrink:0 },
  prompt: { color:'var(--acc)', fontSize:'var(--ui-font-lg)' },
  composerInput: { flex:1, minWidth:0, border:'none', outline:'none', background:'transparent', color:'var(--t0)', fontFamily:'var(--fm)', fontSize:'var(--ui-font)' },
  sendBtn: { border:'none', borderRadius:3, background:'var(--c2)', color:'var(--t1)', padding:'4px 7px', fontSize:'var(--ui-font-sm)', cursor:'pointer' },
}
