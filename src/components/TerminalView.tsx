import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { sshInput, sshResize, onSshData, onSshClosed } from '../lib/ssh'
import { useStore } from '../store'

export function TerminalView({ sessionId, visible = true }: { sessionId: string | null; visible?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
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

  // init terminal once
  useEffect(() => {
    if (!visible || termRef.current) return
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
  }, [visible])

  // wire session
  useEffect(() => {
    if (!sessionId || !ready || !termRef.current) return
    const term = termRef.current
    term.reset()
    requestAnimationFrame(fitSafely)

    let unData: (() => void) | null = null
    let unClosed: (() => void) | null = null

    onSshData(e => { if (e.id === sessionId) term.write(new Uint8Array(e.data)) })
      .then(fn => { unData = fn })

    onSshClosed(id => {
      if (id !== sessionId) return
      term.writeln('\r\n\x1b[33m[session closed]\x1b[0m')
      // find conn by sessionId and patch status
      useStore.getState().conns
        .filter(c => c.sessionId === id)
        .forEach(c => patchConn(c.id, { status: 'disconnected', sessionId: undefined }))
    }).then(fn => { unClosed = fn })

    const d1 = term.onData(data => sshInput(sessionId, Array.from(new TextEncoder().encode(data))))
    const d2 = term.onResize(({ cols, rows }) => sshResize(sessionId, cols, rows))

    return () => { unData?.(); unClosed?.(); d1.dispose(); d2.dispose() }
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
