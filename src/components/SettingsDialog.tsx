import { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  defaultCustomThemeColors,
  useStore,
  type BottomPanelMode,
  type CustomTheme,
  type CustomThemeColors,
  type DefaultAuthMethod,
  type Language,
  type PostConnectAction,
  type TerminalCursorStyle,
  type ThemeMode,
  type UnknownHostKeyPolicy,
  type UiFontSize,
} from '../store'
import { useI18n } from '../i18n'
import {
  deleteAiConversation,
  deleteAiProvider,
  listAiConversations,
  listAiProviders,
  saveAiProvider,
  setDefaultAiProvider,
  type AiConversation,
  type AiProvider,
  type AiProviderKind,
} from '../lib/ai'
import { checkForUpdates, getCurrentVersion, openGithubRepository, type UpdateInfo } from '../lib/update'
import { UpdateDialog } from './UpdateDialog'

type CustomThemeDraft = {
  id?: string
  name: string
  colors: CustomThemeColors
  backgroundImagePath: string
  terminalBackgroundOpacity: number
}

function draftFromTheme(theme?: CustomTheme | null): CustomThemeDraft {
  return {
    id: theme?.id,
    name: theme?.name ?? 'Custom Theme',
    colors: theme?.colors ?? defaultCustomThemeColors,
    backgroundImagePath: theme?.backgroundImagePath ?? '',
    terminalBackgroundOpacity: theme?.terminalBackgroundOpacity ?? 0.48,
  }
}

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
    customThemes,
    saveCustomTheme,
    deleteCustomTheme,
    uiFontSize,
    setUiFontSize,
    terminalSettings,
    patchTerminalSettings,
    resetTerminalSettings,
    connectionSettings,
    patchConnectionSettings,
    resetConnectionSettings,
    defaultDownloadDir,
    setDefaultDownloadDir,
    autoCheckUpdates,
    setAutoCheckUpdates,
  } = useStore(s => s)
  const { t } = useI18n()
  const [tab, setTab] = useState<'common' | 'terminal' | 'connection' | 'model' | 'about'>('model')
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [themeDraft, setThemeDraft] = useState<CustomThemeDraft | null>(null)
  const [currentVersion, setCurrentVersion] = useState('0.2.0')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateNotice, setUpdateNotice] = useState('')
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null)
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false)
  const [agentSessions, setAgentSessions] = useState<AiConversation[]>([])
  const [sessionBusyId, setSessionBusyId] = useState('')
  const [sessionNotice, setSessionNotice] = useState('')
  const selected = useMemo(() => providers.find(p => p.id === selectedId) ?? providers[0], [providers, selectedId])
  const selectedCustomTheme = useMemo(() => customThemes.find(theme => theme.id === themeMode) ?? null, [customThemes, themeMode])
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
    getCurrentVersion()
      .then(setCurrentVersion)
      .catch(err => setUpdateNotice(String(err)))
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

  const chooseDefaultPrivateKey = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      title: t('connection.defaultPrivateKey'),
    })
    if (typeof selected === 'string') patchConnectionSettings({ defaultPrivateKeyPath: selected })
  }

  const chooseThemeBackground = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      title: t('theme.backgroundImage'),
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    })
    if (typeof selected === 'string') {
      setThemeDraft(draft => draft ? { ...draft, backgroundImagePath: selected } : draft)
    }
  }

  const saveThemeDraft = () => {
    if (!themeDraft) return
    saveCustomTheme({
      id: themeDraft.id,
      name: themeDraft.name,
      colors: themeDraft.colors,
      backgroundImagePath: themeDraft.backgroundImagePath.trim() || undefined,
      terminalBackgroundOpacity: themeDraft.terminalBackgroundOpacity,
    })
    setThemeDraft(null)
  }

  const removeSelectedCustomTheme = () => {
    if (!selectedCustomTheme) return
    if (!window.confirm(t('theme.deleteConfirm'))) return
    deleteCustomTheme(selectedCustomTheme.id)
  }

  const runUpdateCheck = async () => {
    try {
      setCheckingUpdate(true)
      setUpdateNotice('')
      const update = await checkForUpdates()
      if (update) {
        setAvailableUpdate(update)
      } else {
        setUpdateNotice(t('update.noUpdate'))
      }
    } catch (err) {
      setUpdateNotice(String(err))
    } finally {
      setCheckingUpdate(false)
    }
  }

  const openSessionManager = async () => {
    setSessionManagerOpen(true)
    setSessionNotice('')
    try {
      const items = await listAiConversations()
      setAgentSessions(items)
    } catch (err) {
      setSessionNotice(String(err))
    }
  }

  const removeAgentSession = async (item: AiConversation) => {
    if (!window.confirm(t('model.deleteSessionConfirm'))) return
    try {
      setSessionBusyId(item.id)
      setSessionNotice('')
      await deleteAiConversation(item.id)
      setAgentSessions(prev => prev.filter(session => session.id !== item.id))
    } catch (err) {
      setSessionNotice(String(err))
    } finally {
      setSessionBusyId('')
    }
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
            ['terminal', t('terminal.title')],
            ['connection', t('connection.title')],
            ['model', t('model.title')],
            ['about', t('about.title')],
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
                  <option value="dark">{t('theme.shellyDark')}</option>
                  <option value="light">{t('theme.shellyLight')}</option>
                  <option value="vscode">{t('theme.vscode')}</option>
                  <option value="codex">{t('theme.codex')}</option>
                  <option value="claude">{t('theme.claude')}</option>
                  {customThemes.length > 0 && (
                    <optgroup label={t('theme.customGroup')}>
                      {customThemes.map(theme => (
                        <option key={theme.id} value={theme.id}>{theme.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              <div style={s.themeActions}>
                <button style={s.smallBtn} type="button" onClick={() => setThemeDraft(draftFromTheme())}>
                  {t('theme.newCustom')}
                </button>
                <button
                  style={s.smallBtn}
                  type="button"
                  disabled={!selectedCustomTheme}
                  onClick={() => selectedCustomTheme && setThemeDraft(draftFromTheme(selectedCustomTheme))}
                >
                  {t('theme.editCustom')}
                </button>
                <button
                  style={s.dangerSmallBtn}
                  type="button"
                  disabled={!selectedCustomTheme}
                  onClick={removeSelectedCustomTheme}
                >
                  {t('theme.deleteCustom')}
                </button>
              </div>
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

          {tab === 'terminal' && (
            <section style={s.section}>
              <div style={s.titleRow}>
                <div style={s.title}>{t('terminal.title')}</div>
                <button style={s.smallBtn} type="button" onClick={resetTerminalSettings}>{t('general.reset')}</button>
              </div>
              <div style={s.placeholder}>{t('terminal.note')}</div>
              <label style={s.fieldColumn}>
                <span>{t('terminal.fontFamily')}</span>
                <input
                  style={s.input}
                  value={terminalSettings.fontFamily}
                  onChange={e => patchTerminalSettings({ fontFamily: e.target.value })}
                />
              </label>
              <div style={s.grid2}>
                <label style={s.fieldColumn}>
                  <span>{t('terminal.fontSize')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={9}
                    max={28}
                    value={terminalSettings.fontSize}
                    onChange={e => patchTerminalSettings({ fontSize: Number(e.target.value) })}
                  />
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('terminal.lineHeight')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={1}
                    max={2.2}
                    step={0.05}
                    value={terminalSettings.lineHeight}
                    onChange={e => patchTerminalSettings({ lineHeight: Number(e.target.value) })}
                  />
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('terminal.scrollback')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={100}
                    max={100000}
                    step={100}
                    value={terminalSettings.scrollback}
                    onChange={e => patchTerminalSettings({ scrollback: Number(e.target.value) })}
                  />
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('terminal.cursorStyle')}</span>
                  <select
                    style={s.input}
                    value={terminalSettings.cursorStyle}
                    onChange={e => patchTerminalSettings({ cursorStyle: e.target.value as TerminalCursorStyle })}
                  >
                    <option value="block">{t('terminal.cursorBlock')}</option>
                    <option value="underline">{t('terminal.cursorUnderline')}</option>
                    <option value="bar">{t('terminal.cursorBar')}</option>
                  </select>
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('terminal.paddingX')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={0}
                    max={40}
                    value={terminalSettings.paddingX}
                    onChange={e => patchTerminalSettings({ paddingX: Number(e.target.value) })}
                  />
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('terminal.paddingY')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={0}
                    max={40}
                    value={terminalSettings.paddingY}
                    onChange={e => patchTerminalSettings({ paddingY: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label style={s.checkRow}>
                <span>{t('terminal.cursorBlink')}</span>
                <input type="checkbox" checked={terminalSettings.cursorBlink} onChange={e => patchTerminalSettings({ cursorBlink: e.target.checked })} />
              </label>
              <label style={s.checkRow}>
                <span>{t('terminal.bell')}</span>
                <input type="checkbox" checked={terminalSettings.bell} onChange={e => patchTerminalSettings({ bell: e.target.checked })} />
              </label>
              <label style={s.checkRow}>
                <span>{t('terminal.copyOnSelect')}</span>
                <input type="checkbox" checked={terminalSettings.copyOnSelect} onChange={e => patchTerminalSettings({ copyOnSelect: e.target.checked })} />
              </label>
              <label style={s.checkRow}>
                <span>{t('terminal.rightClickPaste')}</span>
                <input type="checkbox" checked={terminalSettings.rightClickPaste} onChange={e => patchTerminalSettings({ rightClickPaste: e.target.checked })} />
              </label>
              <label style={s.checkRow}>
                <span>{t('terminal.rightClickSelectsWord')}</span>
                <input type="checkbox" checked={terminalSettings.rightClickSelectsWord} onChange={e => patchTerminalSettings({ rightClickSelectsWord: e.target.checked })} />
              </label>
            </section>
          )}

          {tab === 'connection' && (
            <section style={s.section}>
              <div style={s.titleRow}>
                <div style={s.title}>{t('connection.title')}</div>
                <button style={s.smallBtn} type="button" onClick={resetConnectionSettings}>{t('general.reset')}</button>
              </div>
              <div style={s.placeholder}>{t('connection.note')}</div>
              <div style={s.grid2}>
                <label style={s.fieldColumn}>
                  <span>{t('connection.defaultPort')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={1}
                    max={65535}
                    value={connectionSettings.defaultPort}
                    onChange={e => patchConnectionSettings({ defaultPort: Number(e.target.value) })}
                  />
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('connection.timeout')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={3}
                    max={120}
                    value={connectionSettings.connectTimeoutSecs}
                    onChange={e => patchConnectionSettings({ connectTimeoutSecs: Number(e.target.value) })}
                  />
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('connection.keepaliveInterval')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={5}
                    max={300}
                    value={connectionSettings.keepaliveIntervalSecs}
                    onChange={e => patchConnectionSettings({ keepaliveIntervalSecs: Number(e.target.value) })}
                  />
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('connection.keepaliveMax')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={1}
                    max={20}
                    value={connectionSettings.keepaliveMaxCount}
                    onChange={e => patchConnectionSettings({ keepaliveMaxCount: Number(e.target.value) })}
                  />
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('connection.defaultAuth')}</span>
                  <select
                    style={s.input}
                    value={connectionSettings.defaultAuthMethod}
                    onChange={e => patchConnectionSettings({ defaultAuthMethod: e.target.value as DefaultAuthMethod })}
                  >
                    <option value="password">{t('connect.password')}</option>
                    <option value="privateKey">{t('connect.privateKey')}</option>
                    <option value="lastUsed">{t('connection.authLastUsed')}</option>
                  </select>
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('connection.postConnect')}</span>
                  <select
                    style={s.input}
                    value={connectionSettings.postConnectAction}
                    onChange={e => patchConnectionSettings({ postConnectAction: e.target.value as PostConnectAction })}
                  >
                    <option value="terminal">{t('connection.openTerminal')}</option>
                    <option value="files">{t('connection.openFiles')}</option>
                    <option value="terminalFiles">{t('connection.openTerminalFiles')}</option>
                  </select>
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('connection.unknownHostKey')}</span>
                  <select
                    style={s.input}
                    value={connectionSettings.unknownHostKeyPolicy}
                    onChange={e => patchConnectionSettings({ unknownHostKeyPolicy: e.target.value as UnknownHostKeyPolicy })}
                  >
                    <option value="prompt">{t('connection.hostKeyPrompt')}</option>
                    <option value="reject">{t('connection.hostKeyReject')}</option>
                  </select>
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('connection.reconnectMax')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={1}
                    max={20}
                    value={connectionSettings.autoReconnectMaxAttempts}
                    onChange={e => patchConnectionSettings({ autoReconnectMaxAttempts: Number(e.target.value) })}
                  />
                </label>
                <label style={s.fieldColumn}>
                  <span>{t('connection.reconnectInterval')}</span>
                  <input
                    style={s.input}
                    type="number"
                    min={1}
                    max={120}
                    value={connectionSettings.autoReconnectIntervalSecs}
                    onChange={e => patchConnectionSettings({ autoReconnectIntervalSecs: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label style={s.checkRow}>
                <span>{t('connection.keepalive')}</span>
                <input type="checkbox" checked={connectionSettings.keepaliveEnabled} onChange={e => patchConnectionSettings({ keepaliveEnabled: e.target.checked })} />
              </label>
              <label style={s.checkRow}>
                <span>{t('connection.strictHostKey')}</span>
                <input type="checkbox" checked={connectionSettings.strictHostKeyChecking} onChange={e => patchConnectionSettings({ strictHostKeyChecking: e.target.checked })} />
              </label>
              <label style={s.checkRow}>
                <span>{t('connection.autoReconnect')}</span>
                <input type="checkbox" checked={connectionSettings.autoReconnect} onChange={e => patchConnectionSettings({ autoReconnect: e.target.checked })} />
              </label>
              <label style={s.checkRow}>
                <span>{t('connection.restoreTerminalContent')}</span>
                <input type="checkbox" checked={connectionSettings.restoreTerminalContent} onChange={e => patchConnectionSettings({ restoreTerminalContent: e.target.checked })} />
              </label>
              <label style={s.fieldColumn}>
                <span>{t('connection.defaultPrivateKey')}</span>
                <div style={s.pathPicker}>
                  <input
                    style={s.pathInput}
                    value={connectionSettings.defaultPrivateKeyPath}
                    onChange={e => patchConnectionSettings({ defaultPrivateKeyPath: e.target.value })}
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <button
                    style={s.smallBtn}
                    type="button"
                    onClick={() => chooseDefaultPrivateKey().catch(err => setNotice(String(err)))}
                  >
                    {t('general.browse')}
                  </button>
                </div>
              </label>
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
              <div style={s.title}>{t('model.sessions')}</div>
              <button style={s.smallBtn} type="button" onClick={() => openSessionManager()}>{t('model.manageSessions')}</button>
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

          {tab === 'about' && (
            <section style={s.section}>
              <div style={s.aboutHero}>
                <img style={s.logo} src="/logo.png" alt="Shelly" />
                <div style={s.aboutBrand}>
                  <strong>Shelly</strong>
                  <span>{t('about.version')} {currentVersion}</span>
                </div>
              </div>
              <div style={s.aboutActions}>
                <button style={s.smallBtn} type="button" onClick={() => openGithubRepository().catch(err => setUpdateNotice(String(err)))}>
                  <i className="ti ti-brand-github" /> {t('about.github')}
                </button>
                <button style={s.primaryBtn} type="button" disabled={checkingUpdate} onClick={() => runUpdateCheck()}>
                  {checkingUpdate ? t('update.checking') : t('update.check')}
                </button>
              </div>
              <label style={s.checkRow}>
                <span>{t('update.autoCheck')}</span>
                <input type="checkbox" checked={autoCheckUpdates} onChange={e => setAutoCheckUpdates(e.target.checked)} />
              </label>
              {updateNotice && <div style={s.notice}>{updateNotice}</div>}
            </section>
          )}
        </div>
      </div>
      {availableUpdate && <UpdateDialog update={availableUpdate} onClose={() => setAvailableUpdate(null)} />}
      {sessionManagerOpen && (
        <div style={s.nestedBackdrop} onMouseDown={() => setSessionManagerOpen(false)}>
          <div style={s.sessionModal} onMouseDown={e => e.stopPropagation()}>
            <div style={s.titleRow}>
              <div style={s.modalTitle}>{t('model.manageSessions')}</div>
              <button style={s.iconBtn} onClick={() => setSessionManagerOpen(false)} title={t('general.close')}><i className="ti ti-x" /></button>
            </div>
            {agentSessions.length === 0 ? (
              <div style={s.placeholder}>{t('model.sessionsEmpty')}</div>
            ) : (
              <div style={s.sessionList}>
                {agentSessions.map(item => (
                  <div key={item.id} style={s.sessionRow}>
                    <div style={s.sessionMain}>
                      <div style={s.sessionTitle}>{item.title || t('shell.untitledSession')}</div>
                      <div style={s.sessionMeta}>
                        {item.serverKey} · {new Date(item.updatedAt).toLocaleString()} · ~{item.estimatedTokens} {t('shell.tokens')}
                      </div>
                    </div>
                    <button
                      style={s.dangerSmallBtn}
                      type="button"
                      disabled={sessionBusyId === item.id}
                      onClick={() => removeAgentSession(item)}
                    >
                      {t('general.delete')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {sessionNotice && <div style={s.notice}>{sessionNotice}</div>}
          </div>
        </div>
      )}
      {themeDraft && (
        <div style={s.nestedBackdrop} onMouseDown={() => setThemeDraft(null)}>
          <div style={s.themeModal} onMouseDown={e => e.stopPropagation()}>
            <div style={s.titleRow}>
              <div style={s.modalTitle}>{themeDraft.id ? t('theme.editTitle') : t('theme.newTitle')}</div>
              <button style={s.iconBtn} onClick={() => setThemeDraft(null)} title={t('general.close')}><i className="ti ti-x" /></button>
            </div>
            <label style={s.fieldColumn}>
              <span>{t('theme.name')}</span>
              <input
                style={s.input}
                value={themeDraft.name}
                onChange={e => setThemeDraft(draft => draft ? { ...draft, name: e.target.value } : draft)}
              />
            </label>
            <div style={s.colorGrid}>
              {([
                ['background', t('theme.background')],
                ['surface', t('theme.surface')],
                ['surface2', t('theme.surface2')],
                ['surface3', t('theme.surface3')],
                ['text', t('theme.text')],
                ['textMuted', t('theme.textMuted')],
                ['textSubtle', t('theme.textSubtle')],
                ['accent', t('theme.accent')],
                ['red', t('theme.red')],
                ['green', t('theme.green')],
                ['terminalBackground', t('theme.terminalBackground')],
                ['terminalForeground', t('theme.terminalForeground')],
                ['terminalCursor', t('theme.terminalCursor')],
              ] as [keyof CustomThemeColors, string][]).map(([key, label]) => (
                <label key={key} style={s.colorField}>
                  <span>{label}</span>
                  <span style={s.colorInputRow}>
                    <input
                      style={s.colorInput}
                      type="color"
                      value={themeDraft.colors[key]}
                      onChange={e => setThemeDraft(draft => draft ? { ...draft, colors: { ...draft.colors, [key]: e.target.value } } : draft)}
                    />
                    <input
                      style={s.colorText}
                      value={themeDraft.colors[key]}
                      onChange={e => setThemeDraft(draft => draft ? { ...draft, colors: { ...draft.colors, [key]: e.target.value } } : draft)}
                    />
                  </span>
                </label>
              ))}
            </div>
            <label style={s.fieldColumn}>
              <span>{t('theme.backgroundImage')}</span>
              <div style={s.pathPicker}>
                <input
                  style={s.pathInput}
                  value={themeDraft.backgroundImagePath}
                  onChange={e => setThemeDraft(draft => draft ? { ...draft, backgroundImagePath: e.target.value } : draft)}
                  placeholder={t('theme.backgroundImageEmpty')}
                />
                <button style={s.smallBtn} type="button" onClick={() => chooseThemeBackground().catch(err => setNotice(String(err)))}>
                  {t('general.browse')}
                </button>
              </div>
              {themeDraft.backgroundImagePath && (
                <button style={s.smallBtn} type="button" onClick={() => setThemeDraft(draft => draft ? { ...draft, backgroundImagePath: '' } : draft)}>
                  {t('theme.clearBackground')}
                </button>
              )}
            </label>
            <label style={s.fieldColumn}>
              <span>{t('theme.terminalOpacity')} · {Math.round(themeDraft.terminalBackgroundOpacity * 100)}%</span>
              <input
                type="range"
                min={0.15}
                max={1}
                step={0.01}
                value={themeDraft.terminalBackgroundOpacity}
                onChange={e => setThemeDraft(draft => draft ? { ...draft, terminalBackgroundOpacity: Number(e.target.value) } : draft)}
              />
            </label>
            <div style={s.actions}>
              <button style={s.smallBtn} onClick={() => setThemeDraft(null)}>{t('general.cancel')}</button>
              <button style={s.primaryBtn} onClick={saveThemeDraft}>{t('general.save')}</button>
            </div>
          </div>
        </div>
      )}
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
  dangerSmallBtn: { border:'1px solid rgba(244,71,71,0.28)', borderRadius:3, background:'transparent', color:'var(--red)', height:24, padding:'0 8px', cursor:'pointer', fontSize:'var(--ui-font-sm)' },
  dangerBtn: { border:'1px solid rgba(244,71,71,0.35)', borderRadius:3, background:'transparent', color:'var(--red)', height:28, padding:'0 10px', cursor:'pointer', fontSize:'var(--ui-font)' },
  primaryBtn: { border:'none', borderRadius:3, background:'var(--acc)', color:'#0b1b24', height:28, padding:'0 12px', cursor:'pointer', fontSize:'var(--ui-font)' },
  notice: { color:'#f0c674', fontSize:'var(--ui-font-sm)', lineHeight:1.5 },
  placeholder: { color:'var(--t2)', fontSize:'var(--ui-font)', lineHeight:1.6, padding:'4px 0' },
  fakeRow: { display:'flex', justifyContent:'space-between', color:'var(--t1)', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:3, padding:'8px 10px', fontSize:'var(--ui-font)' },
  fieldRow: { display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, color:'var(--t1)', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:3, padding:'8px 10px', fontSize:'var(--ui-font)' },
  fieldColumn: { display:'flex', flexDirection:'column', gap:7, color:'var(--t1)', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:3, padding:'8px 10px', fontSize:'var(--ui-font)' },
  checkRow: { display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, color:'var(--t1)', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:3, padding:'8px 10px', fontSize:'var(--ui-font)' },
  grid2: { display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:8 },
  themeActions: { display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' },
  nestedBackdrop: { position:'fixed', inset:0, zIndex:60, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.42)', padding:18 },
  themeModal: { width:'min(680px, calc(100vw - 36px))', maxHeight:'calc(100vh - 36px)', overflowY:'auto', border:'1px solid var(--b2)', borderRadius:6, background:'var(--c0)', boxShadow:'0 24px 70px rgba(0,0,0,0.55)', padding:12, display:'flex', flexDirection:'column', gap:10 },
  sessionModal: { width:'min(640px, calc(100vw - 36px))', maxHeight:'calc(100vh - 36px)', overflowY:'auto', border:'1px solid var(--b2)', borderRadius:6, background:'var(--c0)', boxShadow:'0 24px 70px rgba(0,0,0,0.55)', padding:12, display:'flex', flexDirection:'column', gap:10 },
  modalTitle: { color:'var(--t0)', fontSize:'var(--ui-font-md)', fontWeight:700 },
  sessionList: { display:'flex', flexDirection:'column', gap:7 },
  sessionRow: { display:'grid', gridTemplateColumns:'minmax(0,1fr) auto', alignItems:'center', gap:10, border:'1px solid var(--b0)', borderRadius:4, background:'var(--c1)', padding:8 },
  sessionMain: { minWidth:0, display:'flex', flexDirection:'column', gap:3 },
  sessionTitle: { color:'var(--t0)', fontSize:'var(--ui-font)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  sessionMeta: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  colorGrid: { display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:8 },
  colorField: { minWidth:0, display:'flex', flexDirection:'column', gap:6, color:'var(--t1)', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:3, padding:'7px 8px', fontSize:'var(--ui-font-sm)' },
  colorInputRow: { display:'grid', gridTemplateColumns:'28px 1fr', gap:6, alignItems:'center' },
  colorInput: { width:28, height:24, padding:0, border:'1px solid var(--b1)', borderRadius:3, background:'transparent' },
  colorText: { minWidth:0, height:24, background:'var(--c0)', color:'var(--t0)', border:'1px solid var(--b1)', borderRadius:3, padding:'0 6px', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)' },
  pathPicker: { display:'grid', gridTemplateColumns:'1fr auto', gap:6, alignItems:'center' },
  pathInput: { height:26, minWidth:0, background:'var(--c0)', color:'var(--t0)', border:'1px solid var(--b1)', borderRadius:3, padding:'0 7px', fontFamily:'var(--fm)', fontSize:'var(--ui-font)' },
  compactSelect: { height:24, minWidth:130, background:'var(--c0)', color:'var(--t0)', border:'1px solid var(--b1)', borderRadius:3, padding:'0 7px', fontFamily:'var(--fm)', fontSize:'var(--ui-font)' },
  aboutHero: { display:'flex', alignItems:'center', gap:12, padding:'10px 0 8px' },
  logo: { width:46, height:46, borderRadius:6, objectFit:'cover', flexShrink:0 },
  aboutBrand: { display:'flex', flexDirection:'column', gap:3, color:'var(--t1)' },
  aboutActions: { display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' },
}
