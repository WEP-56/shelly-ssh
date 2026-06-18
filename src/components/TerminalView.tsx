import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { sshInput, sshResize, onSshData, onSshClosed, onSshClosedDetail } from '../lib/ssh'
import { useStore } from '../store'
import { recordCommandHistory } from '../lib/commands'

export function TerminalView({ sessionId, visible = true }: { sessionId: string | null; visible?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputLineRef = useRef('')
  const [ready, setReady] = useState(false)
  const patchConn = useStore(s => s.patchConn)

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
    const term = new Terminal({
      theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#569cd6',
               selectionBackground: 'rgba(86,156,214,0.25)' },
      fontFamily: '"JetBrains Mono","Cascadia Code",monospace',
      fontSize: 13, lineHeight: 1.5, cursorBlink: true,
    })
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
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setReady(false)
    }
  }, [])

  // wire session
  useEffect(() => {
    if (!sessionId || !ready || !termRef.current) return
    const term = termRef.current
    term.reset()
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
      useStore.getState().conns
        .filter(c => c.sessionId === sessionId)
        .forEach(c => patchConn(c.id, { status: 'disconnected', sessionId: undefined, deviceStats: null }))
    }

    onSshData(e => { if (e.id === sessionId) term.write(new Uint8Array(e.data)) })
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
      window.removeEventListener('shelly-command-inserted', onProgrammaticInsert)
      unData?.(); unClosed?.(); unClosedDetail?.(); d1.dispose(); d2.dispose()
    }
  }, [sessionId, patchConn, ready])

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
      background:'#1e1e1e',
      padding:'10px 14px',
      overflow:'hidden',
    }}>
      <div ref={containerRef} style={{ width:'100%', height:'100%' }} />
    </div>
  )
}
