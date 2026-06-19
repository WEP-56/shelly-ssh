import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { localStart, localInput, localResize, onLocalData, onLocalClosed } from '../lib/local'
import { useStore, type CustomTheme, type TerminalSettings, type ThemeMode } from '../store'
import { terminalPalette } from '../lib/theme'

function terminalOptions(settings: TerminalSettings, themeMode: ThemeMode, customTheme?: CustomTheme | null) {
  const palette = terminalPalette(themeMode, customTheme)
  return {
    theme: {
      background: palette.localBackground,
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

export function LocalTerminal({ height }: { height: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef      = useRef<Terminal | null>(null)
  const fitRef       = useRef<FitAddon | null>(null)
  const copiedSelectionRef = useRef('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const terminalSettings = useStore(s => s.terminalSettings)
  const themeMode = useStore(s => s.themeMode)
  const customTheme = useStore(s => s.customThemes.find(theme => theme.id === s.themeMode) ?? null)
  const palette = terminalPalette(themeMode, customTheme)

  // mount terminal
  useEffect(() => {
    if (!containerRef.current) return
    const state = useStore.getState()
    const customTheme = state.customThemes.find(theme => theme.id === state.themeMode) ?? null
    const term = new Terminal(terminalOptions(state.terminalSettings, state.themeMode, customTheme))
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

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options = terminalOptions(terminalSettings, themeMode, customTheme)
    requestAnimationFrame(() => fitRef.current?.fit())
  }, [terminalSettings, themeMode, customTheme])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const disposable = term.onSelectionChange(() => {
      if (!terminalSettings.copyOnSelect || !term.hasSelection()) return
      const text = term.getSelection()
      if (!text || text === copiedSelectionRef.current) return
      copiedSelectionRef.current = text
      navigator.clipboard?.writeText(text).catch(err => console.warn('[local-terminal] copy selection failed', err))
    })
    return () => disposable.dispose()
  }, [terminalSettings.copyOnSelect])

  useEffect(() => {
    const el = containerRef.current
    const term = termRef.current
    if (!el || !term) return
    const onContextMenu = (event: MouseEvent) => {
      if (!terminalSettings.rightClickPaste) return
      event.preventDefault()
      navigator.clipboard?.readText()
        .then(text => {
          if (text) term.paste(text)
        })
        .catch(err => console.warn('[local-terminal] paste failed', err))
    }
    el.addEventListener('contextmenu', onContextMenu)
    return () => el.removeEventListener('contextmenu', onContextMenu)
  }, [terminalSettings.rightClickPaste])

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
    <div style={{ width:'100%', height:'100%', padding:`${terminalSettings.paddingY}px ${terminalSettings.paddingX}px`, background:palette.localBackground, boxSizing:'border-box' }}>
      <div ref={containerRef} style={{ width:'100%', height:'100%' }} />
    </div>
  )
}
