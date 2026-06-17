import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'

type CommandKind = 'slash' | 'history' | 'snippet'

interface CommandItem {
  id: string
  kind: CommandKind
  title: string
  detail: string
  hint: string
  action?: () => void
}

const kindLabel: Record<CommandKind, string> = {
  slash: 'command',
  history: 'history',
  snippet: 'snippet',
}

export function CommandPalette() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('/')
  const [selected, setSelected] = useState(0)
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    commandHistory,
    commandSnippets,
    openConnectDialog,
    toggleLocal,
    setRightOpen,
    setRightTab,
  } = useStore(s => s)

  const items = useMemo<CommandItem[]>(() => {
    const slashItems: CommandItem[] = [
      {
        id: 'slash-connect',
        kind: 'slash',
        title: '/connect',
        detail: 'Create a new SSH connection',
        hint: 'open dialog',
        action: () => openConnectDialog(),
      },
      {
        id: 'slash-local',
        kind: 'slash',
        title: '/local',
        detail: 'Toggle the local terminal panel',
        hint: 'toggle panel',
        action: toggleLocal,
      },
      {
        id: 'slash-files',
        kind: 'slash',
        title: '/files',
        detail: 'Open remote file jobs in the right dock',
        hint: 'open dock',
        action: () => { setRightTab('files'); setRightOpen(true) },
      },
      {
        id: 'slash-history',
        kind: 'slash',
        title: '/history',
        detail: 'Show recent commands in the right dock',
        hint: 'open dock',
        action: () => { setRightTab('history'); setRightOpen(true) },
      },
      {
        id: 'slash-snippets',
        kind: 'slash',
        title: '/snippets',
        detail: 'Browse saved command snippets',
        hint: 'open dock',
        action: () => { setRightTab('snippets'); setRightOpen(true) },
      },
      {
        id: 'slash-agent',
        kind: 'slash',
        title: '/agent',
        detail: 'Open the agent terminal workflow',
        hint: 'open dock',
        action: () => { setRightTab('agent'); setRightOpen(true) },
      },
      {
        id: 'slash-sessions',
        kind: 'slash',
        title: '/sessions',
        detail: 'Open saved agent sessions for the current server',
        hint: 'agent',
        action: () => { setRightTab('agent'); setRightOpen(true) },
      },
    ]

    const historyItems = commandHistory.map(h => ({
      id: h.id,
      kind: 'history' as const,
      title: h.command,
      detail: h.connectionName ? `Last used on ${h.connectionName}` : 'Recent command',
      hint: 'insert later',
    }))

    const snippetItems = commandSnippets.map(snippet => ({
      id: snippet.id,
      kind: 'snippet' as const,
      title: `/snp-${snippet.name}`,
      detail: snippet.command,
      hint: `/snippets-${snippet.name}`,
    }))

    const needle = query.trim().replace(/^\//, '').toLowerCase()
    const all = [...slashItems, ...historyItems, ...snippetItems]
    if (!needle) return all
    return all.filter(item =>
      item.title.toLowerCase().includes(needle) ||
      item.detail.toLowerCase().includes(needle) ||
      item.hint.toLowerCase().includes(needle)
    )
  }, [commandHistory, commandSnippets, query, openConnectDialog, setRightOpen, setRightTab, toggleLocal])

  useEffect(() => {
    if (!commandPaletteOpen) return
    setQuery('/')
    setSelected(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [commandPaletteOpen])

  useEffect(() => {
    setSelected(0)
  }, [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && e.ctrlKey) {
        e.preventDefault()
        setCommandPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCommandPaletteOpen])

  if (!commandPaletteOpen) return null

  const run = (item?: CommandItem) => {
    item?.action?.()
    setCommandPaletteOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setCommandPaletteOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(v => Math.min(items.length - 1, v + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(v => Math.max(0, v - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      run(items[selected])
    }
  }

  return (
    <div style={s.backdrop} onMouseDown={() => setCommandPaletteOpen(false)}>
      <div style={s.panel} onMouseDown={e => e.stopPropagation()}>
        <div style={s.inputRow}>
          <span style={s.prompt}>/</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            style={s.input}
            spellCheck={false}
            placeholder="/ command, history, snippet"
          />
          <span style={s.keyHint}>Esc</span>
        </div>

        <div style={s.list}>
          {items.length === 0 ? (
            <div style={s.empty}>No command matches.</div>
          ) : items.slice(0, 8).map((item, index) => (
            <button
              key={item.id}
              type="button"
              style={{ ...s.item, ...(index === selected ? s.itemOn : {}) }}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(item)}
            >
              <span style={s.kind}>{kindLabel[item.kind]}</span>
              <span style={s.itemMain}>
                <span style={s.title}>{item.title}</span>
                <span style={s.detail}>{item.detail}</span>
              </span>
              <span style={s.hint}>{item.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  backdrop: {
    position:'fixed',
    inset:0,
    zIndex:20,
    display:'flex',
    alignItems:'flex-end',
    justifyContent:'center',
    padding:'0 18px 34px',
    background:'rgba(0,0,0,0.18)',
  },
  panel: {
    width:'min(680px, calc(100vw - 36px))',
    background:'#1e1e1e',
    border:'1px solid rgba(255,255,255,0.09)',
    boxShadow:'0 18px 44px rgba(0,0,0,0.42)',
    borderRadius:6,
    overflow:'hidden',
    fontFamily:'var(--fm)',
  },
  inputRow: {
    height:42,
    display:'flex',
    alignItems:'center',
    gap:8,
    padding:'0 10px',
    borderBottom:'1px solid rgba(255,255,255,0.06)',
    background:'#252526',
  },
  prompt: { color:'#569cd6', fontSize:13, width:14, textAlign:'center' },
  input: {
    flex:1,
    minWidth:0,
    height:28,
    border:'none',
    outline:'none',
    background:'transparent',
    color:'#d4d4d4',
    fontFamily:'var(--fm)',
    fontSize:12,
  },
  keyHint: {
    fontSize:10,
    color:'#686868',
    border:'1px solid rgba(255,255,255,0.08)',
    borderRadius:3,
    padding:'2px 5px',
  },
  list: { maxHeight:316, overflowY:'auto', padding:6 },
  item: {
    width:'100%',
    height:36,
    display:'flex',
    alignItems:'center',
    gap:10,
    border:'none',
    borderRadius:4,
    background:'transparent',
    color:'#d4d4d4',
    cursor:'pointer',
    padding:'0 8px',
    textAlign:'left',
    fontFamily:'var(--fm)',
  },
  itemOn: { background:'#2d2d2d' },
  kind: {
    width:54,
    flexShrink:0,
    color:'#686868',
    fontSize:10,
    textTransform:'uppercase',
  },
  itemMain: {
    flex:1,
    minWidth:0,
    display:'flex',
    flexDirection:'column',
    gap:2,
  },
  title: {
    color:'#d4d4d4',
    fontSize:12,
    overflow:'hidden',
    textOverflow:'ellipsis',
    whiteSpace:'nowrap',
  },
  detail: {
    color:'#686868',
    fontSize:10,
    overflow:'hidden',
    textOverflow:'ellipsis',
    whiteSpace:'nowrap',
  },
  hint: {
    maxWidth:120,
    color:'#454545',
    fontSize:10,
    overflow:'hidden',
    textOverflow:'ellipsis',
    whiteSpace:'nowrap',
  },
  empty: {
    padding:'18px 10px',
    color:'#686868',
    fontSize:11,
    textAlign:'center',
  },
}
