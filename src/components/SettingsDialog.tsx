import { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useStore, type BottomPanelMode, type Language, type ThemeMode, type UiFontSize } from '../store'
import { useI18n } from '../i18n'
import {
  deleteAiProvider,
  listAiProviders,
  saveAiProvider,
  setDefaultAiProvider,
  type AiProvider,
  type AiProviderKind,
} from '../lib/ai'

export function SettingsDialog() {
  const {
    showSettings,
    setShowSettings,
    bottomPanelMode,
    setBottomPanelMode,
    language,
    setLanguage,
    themeMode,
    setThemeMode,
    uiFontSize,
    setUiFontSize,
    defaultDownloadDir,
    setDefaultDownloadDir,
  } = useStore(s => s)
  const { t } = useI18n()
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
      setNotice(item.hasApiKey || form.apiKey.trim() ? t('model.saved') : t('model.savedMissingKey'))
      await refresh()
      setSelectedId(item.id)
      setForm(prev => ({ ...prev, id: item.id, apiKey: '' }))
    } catch (err) {
      setNotice(String(err))
    }
  }

  const remove = async () => {
    if (!form.id) return
    if (!window.confirm(t('model.deleteConfirm'))) return
    await deleteAiProvider(form.id)
    newProvider()
    await refresh()
  }

  const chooseDownloadDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('connection.downloadPath'),
      defaultPath: defaultDownloadDir || undefined,
    })
    if (typeof selected === 'string') setDefaultDownloadDir(selected)
  }

  if (!showSettings) return null

  return (
    <div style={s.backdrop} onMouseDown={() => setShowSettings(false)}>
      <div style={s.dialog} onMouseDown={e => e.stopPropagation()}>
        <div style={s.head}>
          <span>{t('settings.title')}</span>
          <button style={s.iconBtn} onClick={() => setShowSettings(false)} title={t('general.close')}><i className="ti ti-x" /></button>
        </div>
        <div style={s.tabs}>
          {[
            ['common', t('common.title')],
            ['connection', t('connection.title')],
            ['model', t('model.title')],
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
              <div style={s.title}>{t('common.title')}</div>
              <div style={s.placeholder}>{t('common.appearanceNote')}</div>
              <label style={s.fieldRow}>
                <span>{t('common.theme')}</span>
                <select style={s.compactSelect} value={themeMode} onChange={e => setThemeMode(e.target.value as ThemeMode)}>
                  <option value="dark">{t('common.dark')}</option>
                  <option value="light">{t('common.light')}</option>
                </select>
              </label>
              <label style={s.fieldRow}>
                <span>{t('common.language')}</span>
                <select style={s.compactSelect} value={language} onChange={e => setLanguage(e.target.value as Language)}>
                  <option value="en">{t('language.en')}</option>
                  <option value="zh-CN">{t('language.zhCN')}</option>
                </select>
              </label>
              <label style={s.fieldRow}>
                <span>{t('common.fontSize')}</span>
                <select style={s.compactSelect} value={uiFontSize} onChange={e => setUiFontSize(e.target.value as UiFontSize)}>
                  <option value="small">{t('common.sizeSmall')}</option>
                  <option value="medium">{t('common.sizeMedium')}</option>
                  <option value="large">{t('common.sizeLarge')}</option>
                </select>
              </label>
            </section>
          )}

          {tab === 'connection' && (
            <section style={s.section}>
              <div style={s.title}>{t('connection.title')}</div>
              <div style={s.placeholder}>{t('connection.note')}</div>
              <label style={s.fakeRow}><span>{t('connection.defaultPort')}</span><span>22</span></label>
              <label style={s.fieldColumn}>
                <span>{t('connection.downloadPath')}</span>
                <div style={s.pathPicker}>
                  <input
                    style={s.pathInput}
                    value={defaultDownloadDir}
                    onChange={e => setDefaultDownloadDir(e.target.value)}
                    placeholder={t('connection.downloadPathDefault')}
                  />
                  <button style={s.smallBtn} type="button" onClick={() => chooseDownloadDir().catch(err => setNotice(String(err)))}>
                    {t('general.browse')}
                  </button>
                </div>
              </label>
            </section>
          )}

          {tab === 'model' && <section style={s.section}>
            <div style={s.title}>{t('model.bottomPanel')}</div>
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
              <div style={s.title}>{t('model.provider')}</div>
              <button style={s.smallBtn} onClick={newProvider}>{t('general.new')}</button>
            </div>
            {providers.length > 0 && (
              <select style={s.input} value={selected?.id ?? ''} onChange={e => setSelectedId(e.target.value)}>
                {providers.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}{p.hasApiKey ? '' : ` · ${t('model.missingKey')}`}
                  </option>
                ))}
              </select>
            )}
            <input style={s.input} value={form.name} onChange={e => setForm(v => ({ ...v, name: e.target.value }))} placeholder={t('model.providerName')} />
            <select style={s.input} value={form.apiKind} onChange={e => setForm(v => ({ ...v, apiKind: e.target.value as AiProviderKind }))}>
              <option value="openai_responses">OpenAI Responses</option>
              <option value="claude_messages">Claude Messages</option>
            </select>
            <input style={s.input} value={form.baseUrl} onChange={e => setForm(v => ({ ...v, baseUrl: e.target.value }))} placeholder={t('model.baseUrl')} />
            <input style={s.input} value={form.model} onChange={e => setForm(v => ({ ...v, model: e.target.value }))} placeholder={t('model.model')} />
            <input style={s.input} type="number" value={form.contextWindowTokens} onChange={e => setForm(v => ({ ...v, contextWindowTokens: Number(e.target.value) || 258000 }))} placeholder={t('model.contextWindow')} />
            <input style={s.input} type="password" value={form.apiKey} onChange={e => setForm(v => ({ ...v, apiKey: e.target.value }))} placeholder={selected?.hasApiKey ? t('model.apiKeyReplace') : t('model.apiKey')} />
            <div style={s.actions}>
              {form.id && <button style={s.dangerBtn} onClick={remove}>{t('general.delete')}</button>}
              <button style={s.primaryBtn} onClick={save}>{t('model.saveProvider')}</button>
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
  dialog: { width:'min(520px, calc(100vw - 40px))', maxHeight:'calc(100vh - 40px)', background:'var(--c0)', border:'1px solid var(--b1)', boxShadow:'0 22px 60px rgba(0,0,0,0.5)', borderRadius:6, display:'flex', flexDirection:'column', overflow:'hidden' },
  head: { height:38, display:'flex', alignItems:'center', padding:'0 12px', borderBottom:'1px solid var(--b0)', color:'var(--t0)', fontSize:'var(--ui-font-md)' },
  tabs: { display:'flex', height:34, borderBottom:'1px solid var(--b0)', padding:'0 8px', gap:4 },
  tabBtn: { border:'none', background:'transparent', color:'var(--t2)', padding:'0 12px', fontSize:'var(--ui-font)', cursor:'pointer', boxShadow:'none' },
  tabBtnOn: { color:'var(--t0)', boxShadow:'inset 0 -1px 0 var(--acc)' },
  iconBtn: { marginLeft:'auto', width:24, height:24, border:'none', borderRadius:3, background:'transparent', color:'var(--t2)', cursor:'pointer' },
  body: { padding:12, overflowY:'auto', display:'flex', flexDirection:'column', gap:14 },
  section: { display:'flex', flexDirection:'column', gap:8 },
  title: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', textTransform:'uppercase', letterSpacing:'0.08em' },
  titleRow: { display:'flex', alignItems:'center', justifyContent:'space-between' },
  segment: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, background:'var(--c1)', padding:4, borderRadius:4 },
  segmentBtn: { border:'none', borderRadius:3, background:'transparent', color:'var(--t1)', height:28, cursor:'pointer', fontSize:'var(--ui-font)' },
  segmentBtnOn: { background:'var(--c3)', color:'var(--t0)' },
  input: { height:30, background:'var(--c1)', color:'var(--t0)', border:'1px solid var(--b1)', borderRadius:3, padding:'0 8px', fontFamily:'var(--fm)', fontSize:'var(--ui-font)' },
  actions: { display:'flex', justifyContent:'flex-end', gap:8 },
  smallBtn: { border:'1px solid var(--b1)', borderRadius:3, background:'transparent', color:'var(--t1)', height:24, padding:'0 8px', cursor:'pointer', fontSize:'var(--ui-font-sm)' },
  dangerBtn: { border:'1px solid rgba(244,71,71,0.35)', borderRadius:3, background:'transparent', color:'var(--red)', height:28, padding:'0 10px', cursor:'pointer', fontSize:'var(--ui-font)' },
  primaryBtn: { border:'none', borderRadius:3, background:'var(--acc)', color:'#0b1b24', height:28, padding:'0 12px', cursor:'pointer', fontSize:'var(--ui-font)' },
  notice: { color:'#f0c674', fontSize:'var(--ui-font-sm)', lineHeight:1.5 },
  placeholder: { color:'var(--t2)', fontSize:'var(--ui-font)', lineHeight:1.6, padding:'4px 0' },
  fakeRow: { display:'flex', justifyContent:'space-between', color:'var(--t1)', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:3, padding:'8px 10px', fontSize:'var(--ui-font)' },
  fieldRow: { display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, color:'var(--t1)', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:3, padding:'8px 10px', fontSize:'var(--ui-font)' },
  fieldColumn: { display:'flex', flexDirection:'column', gap:7, color:'var(--t1)', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:3, padding:'8px 10px', fontSize:'var(--ui-font)' },
  pathPicker: { display:'grid', gridTemplateColumns:'1fr auto', gap:6, alignItems:'center' },
  pathInput: { height:26, minWidth:0, background:'var(--c0)', color:'var(--t0)', border:'1px solid var(--b1)', borderRadius:3, padding:'0 7px', fontFamily:'var(--fm)', fontSize:'var(--ui-font)' },
  compactSelect: { height:24, minWidth:130, background:'var(--c0)', color:'var(--t0)', border:'1px solid var(--b1)', borderRadius:3, padding:'0 7px', fontFamily:'var(--fm)', fontSize:'var(--ui-font)' },
}
