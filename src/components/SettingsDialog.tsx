import { useEffect, useMemo, useState } from 'react'
import { useStore, type BottomPanelMode } from '../store'
import {
  deleteAiProvider,
  listAiProviders,
  saveAiProvider,
  setDefaultAiProvider,
  type AiProvider,
  type AiProviderKind,
} from '../lib/ai'

export function SettingsDialog() {
  const { showSettings, setShowSettings, bottomPanelMode, setBottomPanelMode } = useStore(s => s)
  const [tab, setTab] = useState<'common' | 'connection' | 'model'>('model')
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [notice, setNotice] = useState('')
  const selected = useMemo(() => providers.find(p => p.id === selectedId) ?? providers[0], [providers, selectedId])
  const [form, setForm] = useState({
    id: '',
    name: 'OpenAI',
    apiKind: 'openai_responses' as AiProviderKind,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    contextWindowTokens: 258000,
    apiKey: '',
  })

  useEffect(() => {
    if (!showSettings) return
    refresh()
  }, [showSettings])

  useEffect(() => {
    if (!selected) return
    setForm({
      id: selected.id,
      name: selected.name,
      apiKind: selected.apiKind,
      baseUrl: selected.baseUrl,
      model: selected.model,
      contextWindowTokens: selected.contextWindowTokens,
      apiKey: '',
    })
  }, [selected?.id])

  const refresh = async () => {
    setNotice('')
    const items = await listAiProviders()
    setProviders(items)
    setSelectedId(current => current && items.some(p => p.id === current) ? current : items[0]?.id ?? '')
  }

  const newProvider = () => {
    setSelectedId('')
    setForm({
      id: '',
      name: 'OpenAI',
      apiKind: 'openai_responses',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1',
      contextWindowTokens: 258000,
      apiKey: '',
    })
  }

  const save = async () => {
    try {
      setNotice('')
      const item = await saveAiProvider({
        id: form.id || undefined,
        name: form.name,
        apiKind: form.apiKind,
        baseUrl: form.baseUrl,
        model: form.model,
        contextWindowTokens: form.contextWindowTokens,
        apiKey: form.apiKey.trim() || undefined,
        isDefault: true,
        maxTokens: 4096,
        temperature: 0.7,
        timeoutSecs: 120,
      })
      await setDefaultAiProvider(item.id)
      setNotice(item.hasApiKey || form.apiKey.trim() ? 'Provider saved.' : 'Provider saved, but API key is still missing.')
      await refresh()
      setSelectedId(item.id)
      setForm(prev => ({ ...prev, id: item.id, apiKey: '' }))
    } catch (err) {
      setNotice(String(err))
    }
  }

  const remove = async () => {
    if (!form.id) return
    if (!window.confirm('Delete this provider?')) return
    await deleteAiProvider(form.id)
    newProvider()
    await refresh()
  }

  if (!showSettings) return null

  return (
    <div style={s.backdrop} onMouseDown={() => setShowSettings(false)}>
      <div style={s.dialog} onMouseDown={e => e.stopPropagation()}>
        <div style={s.head}>
          <span>Settings</span>
          <button style={s.iconBtn} onClick={() => setShowSettings(false)}><i className="ti ti-x" /></button>
        </div>
        <div style={s.tabs}>
          {[
            ['common', '常用'],
            ['connection', '连接'],
            ['model', '模型'],
          ].map(([id, label]) => (
            <button
              key={id}
              style={{ ...s.tabBtn, ...(tab === id ? s.tabBtnOn : {}) }}
              onClick={() => setTab(id as typeof tab)}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={s.body}>
          {tab === 'common' && (
            <section style={s.section}>
              <div style={s.title}>常用</div>
              <div style={s.placeholder}>外观、字体、语言和快捷键会在收尾阶段统一整理。</div>
              <label style={s.fakeRow}><span>主题</span><span>深色</span></label>
              <label style={s.fakeRow}><span>语言</span><span>后续 i18n</span></label>
            </section>
          )}

          {tab === 'connection' && (
            <section style={s.section}>
              <div style={s.title}>连接</div>
              <div style={s.placeholder}>SSH 选项、默认路径和密钥路径后续补齐。</div>
              <label style={s.fakeRow}><span>默认端口</span><span>22</span></label>
              <label style={s.fakeRow}><span>文件下载路径</span><span>默认 downloads</span></label>
            </section>
          )}

          {tab === 'model' && <section style={s.section}>
            <div style={s.title}>bottom panel</div>
            <div style={s.segment}>
              {(['powershell', 'agent'] as BottomPanelMode[]).map(mode => (
                <button
                  key={mode}
                  style={{ ...s.segmentBtn, ...(bottomPanelMode === mode ? s.segmentBtnOn : {}) }}
                  onClick={() => setBottomPanelMode(mode)}
                >
                  {mode === 'agent' ? 'SSH Agent' : 'PowerShell'}
                </button>
              ))}
            </div>

            <div style={s.titleRow}>
              <div style={s.title}>AI provider</div>
              <button style={s.smallBtn} onClick={newProvider}>new</button>
            </div>
            {providers.length > 0 && (
              <select style={s.input} value={selected?.id ?? ''} onChange={e => setSelectedId(e.target.value)}>
                {providers.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}{p.hasApiKey ? '' : ' · missing key'}
                  </option>
                ))}
              </select>
            )}
            <input style={s.input} value={form.name} onChange={e => setForm(v => ({ ...v, name: e.target.value }))} placeholder="Provider name" />
            <select style={s.input} value={form.apiKind} onChange={e => setForm(v => ({ ...v, apiKind: e.target.value as AiProviderKind }))}>
              <option value="openai_responses">OpenAI Responses</option>
              <option value="claude_messages">Claude Messages</option>
            </select>
            <input style={s.input} value={form.baseUrl} onChange={e => setForm(v => ({ ...v, baseUrl: e.target.value }))} placeholder="Base URL" />
            <input style={s.input} value={form.model} onChange={e => setForm(v => ({ ...v, model: e.target.value }))} placeholder="Model" />
            <input style={s.input} type="number" value={form.contextWindowTokens} onChange={e => setForm(v => ({ ...v, contextWindowTokens: Number(e.target.value) || 258000 }))} placeholder="Context window tokens" />
            <input style={s.input} type="password" value={form.apiKey} onChange={e => setForm(v => ({ ...v, apiKey: e.target.value }))} placeholder={selected?.hasApiKey ? 'API key saved; enter a new key to replace' : 'API key'} />
            <div style={s.actions}>
              {form.id && <button style={s.dangerBtn} onClick={remove}>delete</button>}
              <button style={s.primaryBtn} onClick={save}>save provider</button>
            </div>
            {notice && <div style={s.notice}>{notice}</div>}
          </section>}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  backdrop: { position:'fixed', inset:0, zIndex:40, background:'rgba(0,0,0,0.35)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 },
  dialog: { width:'min(520px, calc(100vw - 40px))', maxHeight:'calc(100vh - 40px)', background:'#1e1e1e', border:'1px solid rgba(255,255,255,0.1)', boxShadow:'0 22px 60px rgba(0,0,0,0.5)', borderRadius:6, display:'flex', flexDirection:'column', overflow:'hidden' },
  head: { height:38, display:'flex', alignItems:'center', padding:'0 12px', borderBottom:'1px solid rgba(255,255,255,0.06)', color:'#d4d4d4', fontSize:12 },
  tabs: { display:'flex', height:34, borderBottom:'1px solid rgba(255,255,255,0.06)', padding:'0 8px', gap:4 },
  tabBtn: { border:'none', background:'transparent', color:'#686868', padding:'0 12px', fontSize:11, cursor:'pointer', boxShadow:'none' },
  tabBtnOn: { color:'#d4d4d4', boxShadow:'inset 0 -1px 0 #569cd6' },
  iconBtn: { marginLeft:'auto', width:24, height:24, border:'none', borderRadius:3, background:'transparent', color:'#686868', cursor:'pointer' },
  body: { padding:12, overflowY:'auto', display:'flex', flexDirection:'column', gap:14 },
  section: { display:'flex', flexDirection:'column', gap:8 },
  title: { color:'#686868', fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em' },
  titleRow: { display:'flex', alignItems:'center', justifyContent:'space-between' },
  segment: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, background:'#252526', padding:4, borderRadius:4 },
  segmentBtn: { border:'none', borderRadius:3, background:'transparent', color:'#9d9d9d', height:28, cursor:'pointer', fontSize:11 },
  segmentBtnOn: { background:'#3c3c3c', color:'#d4d4d4' },
  input: { height:30, background:'#252526', color:'#d4d4d4', border:'1px solid rgba(255,255,255,0.08)', borderRadius:3, padding:'0 8px', fontFamily:'var(--fm)', fontSize:11 },
  actions: { display:'flex', justifyContent:'flex-end', gap:8 },
  smallBtn: { border:'1px solid rgba(255,255,255,0.08)', borderRadius:3, background:'transparent', color:'#9d9d9d', height:24, padding:'0 8px', cursor:'pointer', fontSize:10 },
  dangerBtn: { border:'1px solid rgba(244,71,71,0.35)', borderRadius:3, background:'transparent', color:'#f44747', height:28, padding:'0 10px', cursor:'pointer', fontSize:11 },
  primaryBtn: { border:'none', borderRadius:3, background:'#569cd6', color:'#0b1b24', height:28, padding:'0 12px', cursor:'pointer', fontSize:11 },
  notice: { color:'#f0c674', fontSize:10, lineHeight:1.5 },
  placeholder: { color:'#686868', fontSize:11, lineHeight:1.6, padding:'4px 0' },
  fakeRow: { display:'flex', justifyContent:'space-between', color:'#9d9d9d', background:'#252526', border:'1px solid rgba(255,255,255,0.06)', borderRadius:3, padding:'8px 10px', fontSize:11 },
}
