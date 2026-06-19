import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { sshConnect, sshInput, sshResize, onSshData, onSshClosed, onSshClosedDetail } from '../lib/ssh'
import { useStore, type CustomTheme, type TerminalSettings, type ThemeMode } from '../store'
import { recordCommandHistory } from '../lib/commands'
import { terminalPalette } from '../lib/theme'
import { getDevicePassword, updateDeviceSession } from '../lib/db'
import { useI18n } from '../i18n'

const reconnectingDeviceIds = new Set<string>()
const SESSION_SNAPSHOT_MAX_CHARS = 80_000

type TerminalRestoreSnapshot = {
  deviceId: string
  name: string
  host: string
  username: string
  capturedAt: number
  text: string
}

function snapshotKey(deviceId: string) {
  return `shelly:sshSessionSnapshot:${deviceId}`
}

function readTerminalSnapshot(deviceId: string): TerminalRestoreSnapshot | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(snapshotKey(deviceId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TerminalRestoreSnapshot>
    if (parsed.deviceId !== deviceId || typeof parsed.text !== 'string' || !parsed.text.trim()) return null
    return {
      deviceId,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      host: typeof parsed.host === 'string' ? parsed.host : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      capturedAt: Number.isFinite(parsed.capturedAt) ? parsed.capturedAt as number : Date.now(),
      text: parsed.text.slice(-SESSION_SNAPSHOT_MAX_CHARS),
    }
  } catch {
    return null
  }
}

function writeTerminalSnapshot(snapshot: TerminalRestoreSnapshot) {
  if (typeof localStorage === 'undefined' || !snapshot.text.trim()) return
  localStorage.setItem(snapshotKey(snapshot.deviceId), JSON.stringify({
    ...snapshot,
    capturedAt: Date.now(),
    text: snapshot.text.slice(-SESSION_SNAPSHOT_MAX_CHARS),
  }))
}

function terminalOptions(settings: TerminalSettings, themeMode: ThemeMode, customTheme?: CustomTheme | null) {
  const palette = terminalPalette(themeMode, customTheme)
  return {
    theme: {
      background: palette.background,
      foreground: palette.foreground,
      cursor: palette.cursor,
      selectionBackground: palette.selectionBackground,
    },
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    bellStyle: settings.bell ? 'sound' as const : 'none' as const,
    rightClickSelectsWord: settings.rightClickSelectsWord,
  }
}

async function reconnectDevice(deviceId: string) {
  if (reconnectingDeviceIds.has(deviceId)) return
  reconnectingDeviceIds.add(deviceId)
  try {
    const initial = useStore.getState()
    const settings = initial.connectionSettings
    if (!settings.autoReconnect) return
    const conn = initial.conns.find(c => c.id === deviceId)
    if (!conn) return
    for (let attempt = 1; attempt <= settings.autoReconnectMaxAttempts; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, settings.autoReconnectIntervalSecs * 1000))
      const state = useStore.getState()
      const latest = state.conns.find(c => c.id === deviceId)
      if (!latest || latest.status === 'connected') return
      state.patchConn(deviceId, { status: 'connecting' })
      try {
        const password = latest.authMethod === 'password' && latest.rememberPassword
          ? await getDevicePassword(latest.id)
          : null
        if (latest.authMethod === 'password' && !password) {
          throw new Error('Saved password is required for automatic reconnect')
        }
        const sessionId = await sshConnect({
          host: latest.host,
          port: latest.port,
          username: latest.username,
          authMethod: latest.authMethod ?? 'password',
          password: latest.authMethod === 'password' ? password ?? undefined : undefined,
          privateKeyPath: latest.authMethod === 'privateKey' ? latest.privateKeyPath ?? undefined : undefined,
          connectTimeoutSecs: state.connectionSettings.connectTimeoutSecs,
          keepaliveEnabled: state.connectionSettings.keepaliveEnabled,
          keepaliveIntervalSecs: state.connectionSettings.keepaliveIntervalSecs,
          keepaliveMaxCount: state.connectionSettings.keepaliveMaxCount,
          unknownHostKeyPolicy: state.connectionSettings.unknownHostKeyPolicy,
          strictHostKeyChecking: state.connectionSettings.strictHostKeyChecking,
        })
        await updateDeviceSession(deviceId, sessionId).catch(() => undefined)
        useStore.getState().patchConn(deviceId, { status: 'connected', sessionId })
        return
      } catch (err) {
        console.warn(`[terminal] reconnect ${attempt}/${settings.autoReconnectMaxAttempts} failed`, err)
      }
    }
    useStore.getState().patchConn(deviceId, { status: 'error', sessionId: undefined, deviceStats: null })
  } finally {
    reconnectingDeviceIds.delete(deviceId)
  }
}

export function TerminalView({ sessionId, visible = true }: { sessionId: string | null; visible?: boolean }) {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputLineRef = useRef('')
  const copiedSelectionRef = useRef('')
  const sessionTextRef = useRef('')
  const sessionDeviceRef = useRef<TerminalRestoreSnapshot | null>(null)
  const sessionDecoderRef = useRef(new TextDecoder())
  const snapshotTimerRef = useRef<number | null>(null)
  const [ready, setReady] = useState(false)
  const [restorePrompt, setRestorePrompt] = useState<TerminalRestoreSnapshot | null>(null)
  const patchConn = useStore(s => s.patchConn)
  const terminalSettings = useStore(s => s.terminalSettings)
  const restoreTerminalContent = useStore(s => s.connectionSettings.restoreTerminalContent)
  const themeMode = useStore(s => s.themeMode)
  const customTheme = useStore(s => s.customThemes.find(theme => theme.id === s.themeMode) ?? null)
  const palette = terminalPalette(themeMode, customTheme)

  const flushSnapshot = () => {
    const base = sessionDeviceRef.current
    if (!base || !sessionTextRef.current.trim()) return
    writeTerminalSnapshot({ ...base, text: sessionTextRef.current })
  }

  const scheduleSnapshotFlush = () => {
    if (snapshotTimerRef.current != null) return
    snapshotTimerRef.current = window.setTimeout(() => {
      snapshotTimerRef.current = null
      flushSnapshot()
    }, 1200)
  }

  const restorePreviousContent = () => {
    const term = termRef.current
    if (!term || !restorePrompt) return
    term.write(`\r\n\x1b[2m[${t('terminal.restoreInserted')} ${new Date(restorePrompt.capturedAt).toLocaleString()}]\x1b[0m\r\n`)
    term.write(restorePrompt.text)
    setRestorePrompt(null)
  }

  const fitSafely = () => {
    const el = containerRef.current
    if (!el || !fitRef.current) return
    if (el.clientWidth <= 0 || el.clientHeight <= 0) return
    try {
      fitRef.current.fit()
    } catch (err) {
      console.warn('[terminal] fit failed', err)
    }
  }

  // Keep each connected session's xterm instance mounted. Switching tabs only
  // changes visibility; disposing here would drop the scrollback buffer.
  useEffect(() => {
    if (termRef.current) return
    if (!containerRef.current) return
    const state = useStore.getState()
    const customTheme = state.customThemes.find(theme => theme.id === state.themeMode) ?? null
    const term = new Terminal(terminalOptions(state.terminalSettings, state.themeMode, customTheme))
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit
    setReady(true)
    requestAnimationFrame(fitSafely)
    const ro = new ResizeObserver(() => fitSafely())
    ro.observe(containerRef.current)
    return () => {
      flushSnapshot()
      if (snapshotTimerRef.current != null) window.clearTimeout(snapshotTimerRef.current)
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options = terminalOptions(terminalSettings, themeMode, customTheme)
    requestAnimationFrame(fitSafely)
  }, [terminalSettings, themeMode, customTheme])

  useEffect(() => {
    const term = termRef.current
    if (!term || !ready) return
    const disposable = term.onSelectionChange(() => {
      if (!terminalSettings.copyOnSelect || !term.hasSelection()) return
      const text = term.getSelection()
      if (!text || text === copiedSelectionRef.current) return
      copiedSelectionRef.current = text
      navigator.clipboard?.writeText(text).catch(err => console.warn('[terminal] copy selection failed', err))
    })
    return () => disposable.dispose()
  }, [ready, terminalSettings.copyOnSelect])

  useEffect(() => {
    const el = containerRef.current
    const term = termRef.current
    if (!el || !term || !ready) return
    const onContextMenu = (event: MouseEvent) => {
      if (!terminalSettings.rightClickPaste) return
      event.preventDefault()
      navigator.clipboard?.readText()
        .then(text => {
          if (text) term.paste(text)
        })
        .catch(err => console.warn('[terminal] paste failed', err))
    }
    el.addEventListener('contextmenu', onContextMenu)
    return () => el.removeEventListener('contextmenu', onContextMenu)
  }, [ready, terminalSettings.rightClickPaste])

  // wire session
  useEffect(() => {
    if (!sessionId || !ready || !termRef.current) return
    const term = termRef.current
    term.reset()
    sessionTextRef.current = ''
    sessionDeviceRef.current = null
    sessionDecoderRef.current = new TextDecoder()
    setRestorePrompt(null)
    const connectedDevice = useStore.getState().conns.find(c => c.sessionId === sessionId)
    if (connectedDevice) {
      sessionDeviceRef.current = {
        deviceId: connectedDevice.id,
        name: connectedDevice.name,
        host: connectedDevice.host,
        username: connectedDevice.username,
        capturedAt: Date.now(),
        text: '',
      }
      if (useStore.getState().connectionSettings.restoreTerminalContent) {
        const snapshot = readTerminalSnapshot(connectedDevice.id)
        if (snapshot?.text.trim()) setRestorePrompt(snapshot)
      }
    }
    requestAnimationFrame(fitSafely)

    let unData: (() => void) | null = null
    let unClosed: (() => void) | null = null
    let unClosedDetail: (() => void) | null = null
    let closed = false

    const handleClosed = (reason?: string) => {
      if (closed) return
      closed = true
      const suffix = reason ? `: ${reason}` : ''
      term.writeln(`\r\n\x1b[33m[session closed${suffix}]\x1b[0m`)
      const state = useStore.getState()
      const closedConns = state.conns.filter(c => c.sessionId === sessionId)
      flushSnapshot()
      closedConns.forEach(c => patchConn(c.id, { status: 'disconnected', sessionId: undefined, deviceStats: null }))
      if (state.connectionSettings.autoReconnect) {
        closedConns
          .filter(c => c.status === 'connected')
          .forEach(c => reconnectDevice(c.id))
      }
    }

    onSshData(e => {
      if (e.id !== sessionId) return
      const bytes = new Uint8Array(e.data)
      term.write(bytes)
      const chunk = sessionDecoderRef.current.decode(bytes, { stream: true })
      if (chunk) {
        sessionTextRef.current = (sessionTextRef.current + chunk).slice(-SESSION_SNAPSHOT_MAX_CHARS)
        scheduleSnapshotFlush()
      }
    })
      .then(fn => { unData = fn })

    onSshClosedDetail(e => {
      if (e.id !== sessionId) return
      handleClosed(e.reason)
    }).then(fn => { unClosedDetail = fn })

    onSshClosed(id => {
      if (id !== sessionId) return
      handleClosed()
    }).then(fn => { unClosed = fn })

    const trackCommandInput = (data: string) => {
      if (data.startsWith('\x1b')) return
      const state = useStore.getState()
      const conn = state.conns.find(c => c.sessionId === sessionId)
      for (const char of data) {
        if (char === '\r' || char === '\n') {
          const command = inputLineRef.current.trim()
          inputLineRef.current = ''
          if (command) {
            recordCommandHistory(command, conn).catch(err => console.warn('[terminal] history failed', err))
          }
          continue
        }
        if (char === '\x03' || char === '\x15') {
          inputLineRef.current = ''
          continue
        }
        if (char === '\x7f' || char === '\b') {
          inputLineRef.current = inputLineRef.current.slice(0, -1)
          continue
        }
        if (char >= ' ' && char !== '\x7f') {
          inputLineRef.current += char
        }
      }
    }

    const onProgrammaticInsert = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string }>).detail
      if (detail?.sessionId !== sessionId) return
      trackCommandInput(detail.text)
    }
    window.addEventListener('shelly-command-inserted', onProgrammaticInsert)

    const d1 = term.onData(data => {
      trackCommandInput(data)
      sshInput(sessionId, Array.from(new TextEncoder().encode(data)))
        .catch(err => console.warn('[terminal] input failed', err))
    })
    const d2 = term.onResize(({ cols, rows }) => {
      sshResize(sessionId, cols, rows)
        .catch(err => console.warn('[terminal] resize failed', err))
    })

    return () => {
      flushSnapshot()
      window.removeEventListener('shelly-command-inserted', onProgrammaticInsert)
      unData?.(); unClosed?.(); unClosedDetail?.(); d1.dispose(); d2.dispose()
    }
  }, [sessionId, patchConn, ready])

  useEffect(() => {
    if (!restoreTerminalContent) setRestorePrompt(null)
  }, [restoreTerminalContent])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(fitSafely)
  }, [visible])

  return (
    <div style={{
      position:'absolute',
      inset:0,
      visibility: visible ? 'visible' : 'hidden',
      pointerEvents: visible ? 'auto' : 'none',
      background: palette.background,
      padding: `${terminalSettings.paddingY}px ${terminalSettings.paddingX}px`,
      overflow:'hidden',
    }}>
      {restorePrompt && restoreTerminalContent && visible && (
        <div style={s.restoreToast}>
          <div style={s.restoreTitle}>{restorePrompt.name || restorePrompt.host}</div>
          <div style={s.restoreText}>
            {t('terminal.restorePromptText').replace('{time}', new Date(restorePrompt.capturedAt).toLocaleString())}
          </div>
          <div style={s.restoreActions}>
            <button style={s.restoreGhostBtn} onClick={() => setRestorePrompt(null)}>{t('general.close')}</button>
            <button style={s.restorePrimaryBtn} onClick={restorePreviousContent}>{t('terminal.restore')}</button>
          </div>
        </div>
      )}
      <div ref={containerRef} style={{ width:'100%', height:'100%' }} />
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  restoreToast: { position:'absolute', top:10, right:12, zIndex:5, width:280, border:'1px solid var(--b2)', borderRadius:6, background:'color-mix(in srgb, var(--c1) 94%, transparent)', boxShadow:'0 12px 34px rgba(0,0,0,0.34)', padding:10, display:'flex', flexDirection:'column', gap:7, pointerEvents:'auto' },
  restoreTitle: { color:'var(--t0)', fontSize:'var(--ui-font)', fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  restoreText: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  restoreActions: { display:'flex', justifyContent:'flex-end', gap:7 },
  restoreGhostBtn: { height:24, border:'1px solid var(--b1)', borderRadius:3, background:'transparent', color:'var(--t1)', fontSize:'var(--ui-font-sm)', padding:'0 8px', cursor:'pointer' },
  restorePrimaryBtn: { height:24, border:'none', borderRadius:3, background:'var(--acc)', color:'#0b1b24', fontSize:'var(--ui-font-sm)', padding:'0 9px', cursor:'pointer' },
}
