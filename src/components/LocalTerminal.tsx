import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { localStart, localInput, localResize, onLocalData, onLocalClosed } from '../lib/local'

export function LocalTerminal({ height }: { height: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef      = useRef<Terminal | null>(null)
  const fitRef       = useRef<FitAddon | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  // mount terminal
  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      theme: { background:'#141414', foreground:'#d4d4d4', cursor:'#569cd6',
               selectionBackground:'rgba(86,156,214,0.25)' },
      fontFamily: '"JetBrains Mono","Cascadia Code",monospace',
      fontSize: 13, lineHeight: 1.5, cursorBlink: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current  = fit

    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)

    // start local shell
    const cols = term.cols, rows = term.rows
    localStart(cols, rows).then(id => setSessionId(id))

    return () => { ro.disconnect(); term.dispose() }
  }, [])

  // re-fit when height changes
  useEffect(() => { fitRef.current?.fit() }, [height])

  // wire session
  useEffect(() => {
    if (!sessionId || !termRef.current) return
    const term = termRef.current

    let unData: (() => void) | null = null
    let unClosed: (() => void) | null = null

    onLocalData(e => { if (e.id === sessionId) term.write(new Uint8Array(e.data)) })
      .then(fn => { unData = fn })

    onLocalClosed(id => { if (id === sessionId) { setSessionId(null); term.writeln('\r\n\x1b[33m[terminal closed]\x1b[0m') } })
      .then(fn => { unClosed = fn })

    const d1 = term.onData(data => localInput(sessionId, Array.from(new TextEncoder().encode(data))))
    const d2 = term.onResize(({ cols, rows }) => localResize(sessionId, cols, rows))

    return () => { unData?.(); unClosed?.(); d1.dispose(); d2.dispose() }
  }, [sessionId])

  return (
    <div style={{ width:'100%', height:'100%', padding:'6px 10px', background:'#141414', boxSizing:'border-box' }}>
      <div ref={containerRef} style={{ width:'100%', height:'100%' }} />
    </div>
  )
}
