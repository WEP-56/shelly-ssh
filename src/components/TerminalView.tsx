import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { sshInput, sshResize, onSshData, onSshClosed } from '../lib/ssh'
import { useStore } from '../store'

export function TerminalView({ sessionId }: { sessionId: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const patchConn = useStore(s => s.patchConn)

  // init terminal once
  useEffect(() => {
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
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); term.dispose() }
  }, [])

  // wire session
  useEffect(() => {
    if (!sessionId || !termRef.current) return
    const term = termRef.current
    term.reset()
    fitRef.current?.fit()

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
  }, [sessionId, patchConn])

  return (
    <div style={{ flex:1, minWidth:0, minHeight:0, background:'#1e1e1e', padding:'10px 14px', overflow:'hidden' }}>
      <div ref={containerRef} style={{ width:'100%', height:'100%' }} />
    </div>
  )
}
