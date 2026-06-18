import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useI18n, type I18nKey } from '../i18n'
import { sendCommandToActiveTerminal } from '../lib/commands'

type CommandKind = 'slash' | 'history' | 'snippet'

interface CommandItem {
  id: string
  kind: CommandKind
  title: string
  detail: string
  hint: string
  command?: string
  action?: () => void | Promise<void>
}

export function CommandPalette() {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [editorDraft, setEditorDraft] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    commandHistory,
    commandSnippets,
    openConnectDialog,
    toggleLocal,
    setLocalOpen,
    setBottomPanelMode,
    setRightOpen,
    setRightTab,
  } = useStore(s => s)

  const items = useMemo<CommandItem[]>(() => {
    const slashItems: CommandItem[] = [
      {
        id: 'slash-edit',
        kind: 'slash',
        title: '/edit',
        detail: t('command.editDetail'),
        hint: t('command.longCommand'),
        action: () => setEditorDraft(queryToCommand(query)),
      },
      {
        id: 'slash-connect',
        kind: 'slash',
        title: '/connect',
        detail: t('command.connectDetail'),
        hint: t('command.openDialog'),
        action: () => openConnectDialog(),
      },
      {
        id: 'slash-local',
        kind: 'slash',
        title: '/local',
        detail: t('command.localDetail'),
        hint: t('command.togglePanel'),
        action: toggleLocal,
      },
      {
        id: 'slash-files',
        kind: 'slash',
        title: '/files',
        detail: t('command.filesDetail'),
        hint: t('command.openDock'),
        action: () => { setRightTab('files'); setRightOpen(true) },
      },
      {
        id: 'slash-history',
        kind: 'slash',
        title: '/history',
        detail: t('command.historyDetail'),
        hint: t('command.openDock'),
        action: () => { setRightTab('history'); setRightOpen(true) },
      },
      {
        id: 'slash-snippets',
        kind: 'slash',
        title: '/snippets',
        detail: t('command.snippetsDetail'),
        hint: t('command.openDock'),
        action: () => { setRightTab('snippets'); setRightOpen(true) },
      },
      {
        id: 'slash-agent',
        kind: 'slash',
        title: '/agent',
        detail: t('command.agentDetail'),
        hint: t('command.agentHint'),
        action: () => { setBottomPanelMode('agent'); setLocalOpen(true) },
      },
      {
        id: 'slash-sessions',
        kind: 'slash',
        title: '/sessions',
        detail: t('command.sessionsDetail'),
        hint: t('command.agentHint'),
        action: () => { setBottomPanelMode('agent'); setLocalOpen(true) },
      },
    ]

    const historyItems = commandHistory.map(h => ({
      id: h.id,
      kind: 'history' as const,
      title: h.command,
      detail: h.connectionName ? t('command.historyItemDetail').replace('{name}', h.connectionName) : t('command.historyRecent'),
      hint: t('command.run'),
      command: h.command,
    }))

    const snippetItems = commandSnippets.map(snippet => ({
      id: snippet.id,
      kind: 'snippet' as const,
      title: `/snp-${snippet.name}`,
      detail: snippet.command,
      hint: `/snippets-${snippet.name}`,
      command: snippet.command,
    }))

    const needle = query.trim().replace(/^\//, '').toLowerCase()
    const all = [...slashItems, ...historyItems, ...snippetItems]
    if (!needle) return all
    return all.filter(item =>
      item.title.toLowerCase().includes(needle) ||
      item.detail.toLowerCase().includes(needle) ||
      item.hint.toLowerCase().includes(needle)
    )
  }, [commandHistory, commandSnippets, query, openConnectDialog, setBottomPanelMode, setLocalOpen, setRightOpen, setRightTab, t, toggleLocal])

  useEffect(() => {
    if (!commandPaletteOpen) return
    setQuery('')
    setSelected(0)
    setEditorDraft(null)
    setErr('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [commandPaletteOpen])

  useEffect(() => {
    setSelected(0)
  }, [query])

  if (!commandPaletteOpen) return null

  const run = async (item?: CommandItem, mode: 'insert' | 'run' = 'insert') => {
    setErr('')
    if (item) {
      try {
        if (item.command != null) {
          await sendCommandToActiveTerminal(item.command, mode)
        } else {
          await item.action?.()
        }
        if (item.id !== 'slash-edit') setCommandPaletteOpen(false)
      } catch (err) {
        setErr(String(err))
      }
      return
    }
    setEditorDraft(queryToCommand(query))
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
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      setEditorDraft(queryToCommand(query))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      run(items[selected], 'run').catch(err => setErr(String(err)))
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
            placeholder={t('command.placeholder')}
          />
          <span style={s.keyHint}>Esc</span>
        </div>
        {err && <div style={s.error}>{err}</div>}

        <div style={s.list}>
          {items.length === 0 ? (
            <div style={s.empty}>{t('command.empty')}</div>
          ) : items.slice(0, 8).map((item, index) => (
            <button
              key={item.id}
              type="button"
              style={{ ...s.item, ...(index === selected ? s.itemOn : {}) }}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(item, 'insert').catch(err => setErr(String(err)))}
            >
              <span style={s.kind}>{commandKindLabel(item.kind, t)}</span>
              <span style={s.itemMain}>
                <span style={s.title}>{item.title}</span>
                <span style={s.detail}>{item.detail}</span>
              </span>
              <span style={s.hint}>{item.hint}</span>
            </button>
          ))}
        </div>
        <div style={s.footer}>
          <span>{t('command.enterHint')}</span>
          <button style={s.footerBtn} onClick={() => setEditorDraft(queryToCommand(query))}>{t('command.longCommand')}</button>
        </div>
      </div>
      {editorDraft != null && (
        <LongCommandEditor
          value={editorDraft}
          onChange={setEditorDraft}
          onClose={() => setEditorDraft(null)}
          onInsert={async value => {
            await sendCommandToActiveTerminal(value, 'insert')
            setCommandPaletteOpen(false)
          }}
          onRun={async value => {
            await sendCommandToActiveTerminal(value, 'run')
            setCommandPaletteOpen(false)
          }}
        />
      )}
    </div>
  )
}

function LongCommandEditor({
  value,
  onChange,
  onClose,
  onInsert,
  onRun,
}: {
  value: string
  onChange: (value: string) => void
  onClose: () => void
  onInsert: (value: string) => Promise<void>
  onRun: (value: string) => Promise<void>
}) {
  const { t } = useI18n()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    requestAnimationFrame(() => textRef.current?.focus())
  }, [])

  const submit = async (mode: 'insert' | 'run') => {
    setErr('')
    try {
      if (mode === 'insert') await onInsert(value)
      else await onRun(value)
    } catch (err) {
      setErr(String(err))
    }
  }

  return (
    <div style={s.editorOverlay} onMouseDown={onClose}>
      <div style={s.editor} onMouseDown={e => e.stopPropagation()}>
        <div style={s.editorTitle}>{t('command.longCommand')}</div>
        <textarea
          ref={textRef}
          style={s.editorText}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault()
              submit('run')
            }
          }}
          spellCheck={false}
          placeholder={t('command.longPlaceholder')}
        />
        {err && <div style={s.error}>{err}</div>}
        <div style={s.editorActions}>
          <button style={s.footerBtn} onClick={onClose}>{t('general.cancel')}</button>
          <button style={s.footerBtn} onClick={() => submit('insert')}>{t('command.insert')}</button>
          <button style={s.primaryBtn} onClick={() => submit('run')}>{t('command.run')}</button>
        </div>
      </div>
    </div>
  )
}

function queryToCommand(query: string) {
  const trimmed = query.trim()
  return trimmed === '/edit' ? '' : trimmed
}

function commandKindLabel(kind: CommandKind, t: (key: I18nKey) => string) {
  if (kind === 'history') return t('command.history')
  if (kind === 'snippet') return t('command.snippet')
  return t('command.command')
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
    background:'var(--c0)',
    border:'1px solid var(--b1)',
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
    borderBottom:'1px solid var(--b0)',
    background:'var(--c1)',
  },
  prompt: { color:'var(--acc)', fontSize:'var(--ui-font-lg)', width:14, textAlign:'center' },
  input: {
    flex:1,
    minWidth:0,
    height:28,
    border:'none',
    outline:'none',
    background:'transparent',
    color:'var(--t0)',
    fontFamily:'var(--fm)',
    fontSize:'var(--ui-font-md)',
  },
  keyHint: {
    fontSize:'var(--ui-font-sm)',
    color:'var(--t2)',
    border:'1px solid var(--b1)',
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
    color:'var(--t0)',
    cursor:'pointer',
    padding:'0 8px',
    textAlign:'left',
    fontFamily:'var(--fm)',
  },
  itemOn: { background:'var(--c2)' },
  kind: {
    width:54,
    flexShrink:0,
    color:'var(--t2)',
    fontSize:'var(--ui-font-sm)',
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
    color:'var(--t0)',
    fontSize:'var(--ui-font-md)',
    overflow:'hidden',
    textOverflow:'ellipsis',
    whiteSpace:'nowrap',
  },
  detail: {
    color:'var(--t2)',
    fontSize:'var(--ui-font-sm)',
    overflow:'hidden',
    textOverflow:'ellipsis',
    whiteSpace:'nowrap',
  },
  hint: {
    maxWidth:120,
    color:'var(--t3)',
    fontSize:'var(--ui-font-sm)',
    overflow:'hidden',
    textOverflow:'ellipsis',
    whiteSpace:'nowrap',
  },
  empty: {
    padding:'18px 10px',
    color:'var(--t2)',
    fontSize:'var(--ui-font)',
    textAlign:'center',
  },
  footer: { minHeight:30, display:'flex', alignItems:'center', justifyContent:'space-between', borderTop:'1px solid var(--b0)', padding:'0 10px', color:'var(--t2)', fontSize:'var(--ui-font-sm)' },
  footerBtn: { height:24, border:'1px solid var(--b1)', borderRadius:3, background:'var(--c1)', color:'var(--t0)', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)', padding:'0 8px' },
  primaryBtn: { height:24, border:'none', borderRadius:3, background:'var(--acc)', color:'#0b1b24', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)', padding:'0 10px' },
  error: { color:'var(--red)', fontSize:'var(--ui-font-sm)', padding:'6px 10px' },
  editorOverlay: { position:'fixed', inset:0, zIndex:21, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.28)', padding:18 },
  editor: { width:'min(760px, calc(100vw - 36px))', border:'1px solid var(--b2)', borderRadius:6, background:'var(--c0)', boxShadow:'0 18px 44px rgba(0,0,0,0.42)', padding:12, display:'flex', flexDirection:'column', gap:10, fontFamily:'var(--fm)' },
  editorTitle: { color:'var(--t0)', fontSize:'var(--ui-font-md)', fontWeight:700 },
  editorText: { minHeight:180, resize:'vertical', border:'1px solid var(--b1)', borderRadius:4, background:'var(--c1)', color:'var(--t0)', outline:'none', padding:10, fontFamily:'var(--fm)', fontSize:'var(--ui-font-md)', lineHeight:1.55 },
  editorActions: { display:'flex', justifyContent:'flex-end', gap:8 },
}
