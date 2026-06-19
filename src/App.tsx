import { getCurrentWindow } from '@tauri-apps/api/window'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { Suspense, lazy, useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { listCommandHistory, listDevices, listSnippets } from './lib/db'
import { sshCollectDeviceStats, type DeviceStats } from './lib/ssh'
import { useI18n } from './i18n'
import { customThemeCssVars, themeColorScheme } from './lib/theme'
import { checkForUpdates, type UpdateInfo } from './lib/update'
import { UpdateDialog } from './components/UpdateDialog'

const win = getCurrentWindow()
const TerminalView = lazy(() => import('./components/TerminalView').then(module => ({ default: module.TerminalView })))
const LocalTerminal = lazy(() => import('./components/LocalTerminal').then(module => ({ default: module.LocalTerminal })))
const ConnectDialog = lazy(() => import('./components/ConnectDialog').then(module => ({ default: module.ConnectDialog })))
const CommandPalette = lazy(() => import('./components/CommandPalette').then(module => ({ default: module.CommandPalette })))
const ContextDock = lazy(() => import('./components/ContextDock').then(module => ({ default: module.ContextDock })))
const AgentPanel = lazy(() => import('./components/AgentPanel').then(module => ({ default: module.AgentPanel })))
const SettingsDialog = lazy(() => import('./components/SettingsDialog').then(module => ({ default: module.SettingsDialog })))
const startupLogs = import.meta.env.DEV || import.meta.env.VITE_STARTUP_LOGS === '1'

export default function App() {
  const { t } = useI18n()
  const { conns, activeId, rightOpen, showConnect, toggleRight, sidebarOpen, toggleSidebar,
          localOpen, localHeight, bottomPanelMode, toggleLocal, setLocalHeight, setCommandPaletteOpen,
          commandPaletteOpen, showSettings, setConns, setCommandHistory, setCommandSnippets, rightTab,
          themeMode, customThemes, uiFontSize, patchConn, sidebarWidth, setSidebarWidth, rightDockWidth,
          autoCheckUpdates } = useStore(s => s)
  const active = conns.find(c => c.id === activeId)
  const customTheme = useMemo(
    () => customThemes.find(theme => theme.id === themeMode) ?? null,
    [customThemes, themeMode],
  )
  const [backgroundImageUrl, setBackgroundImageUrl] = useState('')
  const connectedSessions = useMemo(() => conns
    .filter(c => c.status === 'connected' && c.sessionId)
    .map(c => ({ id: c.id, sessionId: c.sessionId! })), [conns])
  const connectedSessionKey = connectedSessions.map(c => `${c.id}:${c.sessionId}`).join('|')
  const secondaryDataLoadedRef = useRef(false)
  const rightDockMountedRef = useRef(rightOpen)
  const autoUpdateCheckedRef = useRef(false)
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    const hydrate = async () => {
      const started = performance.now()
      try {
        const devices = await listDevices()
        if (startupLogs) {
          console.info(`[startup] listDevices resolved in ${Math.round(performance.now() - started)}ms`)
        }
        if (cancelled) return
        setConns(devices.map(device => ({
          id: device.id,
          name: device.name,
          host: device.host,
          port: device.port,
          username: device.username,
          authMethod: device.authMethod,
          privateKeyPath: device.privateKeyPath,
          status: 'disconnected',
          rememberPassword: device.rememberPassword,
          pinned: device.pinned,
        })))
      } catch (err) {
        console.warn('[db] devices hydrate failed', err)
      }
    }
    requestAnimationFrame(() => {
      if (startupLogs) {
        console.info(`[startup] first app frame at ${Math.round(performance.now())}ms`)
      }
      win.show()
        .catch(err => console.warn('[window] show failed', err))
        .finally(() => window.setTimeout(hydrate, 0))
      window.setTimeout(() => {
        const started = performance.now()
        import('./components/ConnectDialog')
          .then(() => {
            if (startupLogs) {
              console.info(`[startup] ConnectDialog preloaded in ${Math.round(performance.now() - started)}ms`)
            }
          })
          .catch(err => console.warn('[startup] ConnectDialog preload failed', err))
      }, 250)
    })
    return () => { cancelled = true }
  }, [setConns])

  useEffect(() => {
    const shouldLoad =
      commandPaletteOpen ||
      (rightOpen && (rightTab === 'history' || rightTab === 'snippets'))
    if (!shouldLoad || secondaryDataLoadedRef.current) return
    secondaryDataLoadedRef.current = true
    let cancelled = false
    const hydrateSecondaryData = async () => {
      try {
        const [history, snippets] = await Promise.all([
          listCommandHistory(undefined, 100),
          listSnippets(),
        ])
        if (cancelled) return
        setCommandHistory(history.map(entry => ({
          id: entry.id,
          command: entry.command,
          connectionName: conns.find(device => device.id === entry.deviceId)?.name,
          lastUsedAt: entry.createdAt,
        })))
        setCommandSnippets(snippets.map(snippet => ({
          id: snippet.id,
          name: snippet.name,
          command: snippet.command,
          createdAt: snippet.createdAt,
          updatedAt: snippet.updatedAt,
        })))
      } catch (err) {
        console.warn('[db] history/snippets hydrate failed', err)
      }
    }
    hydrateSecondaryData()
    return () => { cancelled = true }
  }, [commandPaletteOpen, rightOpen, rightTab, conns, setCommandHistory, setCommandSnippets])

  if (rightOpen) rightDockMountedRef.current = true

  useEffect(() => {
    let cancelled = false
    const path = customTheme?.backgroundImagePath
    if (!path) {
      setBackgroundImageUrl('')
      return
    }
    invoke<string>('read_image_data_url', { path })
      .then(url => {
        if (!cancelled) {
          setBackgroundImageUrl(url)
          console.info('[theme] background image loaded via data url')
        }
      })
      .catch(err => {
        if (!cancelled) {
          const fallbackUrl = convertFileSrc(path)
          setBackgroundImageUrl(fallbackUrl)
          console.warn('[theme] background data url failed; using asset fallback', err)
        }
      })
    return () => { cancelled = true }
  }, [customTheme?.backgroundImagePath])

  useEffect(() => {
    const root = document.documentElement
    const style = root.style
    root.dataset.theme = customTheme ? 'custom' : themeMode
    root.dataset.colorScheme = themeColorScheme(themeMode)
    root.dataset.uiFontSize = uiFontSize
    root.dataset.hasBg = backgroundImageUrl ? 'true' : 'false'

    const customVars = ['--c0', '--c1', '--c2', '--c3', '--c4', '--b0', '--b1', '--b2', '--t0', '--t1', '--t2', '--t3', '--acc', '--red', '--grn']
    customVars.forEach(name => style.removeProperty(name))

    if (customTheme) {
      Object.entries(customThemeCssVars(customTheme)).forEach(([name, value]) => style.setProperty(name, value))
    }
  }, [backgroundImageUrl, customTheme, themeMode, uiFontSize])

  useEffect(() => {
    let disposed = false
    const collect = async () => {
      await Promise.all(connectedSessions.map(async conn => {
        try {
          const stats = await sshCollectDeviceStats(conn.sessionId)
          if (!disposed) patchConn(conn.id, { deviceStats: stats })
        } catch (err) {
          console.warn('[ssh] device stats failed', conn.id, err)
        }
      }))
    }
    if (connectedSessions.length === 0) return
    collect()
    const timer = window.setInterval(collect, 30_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [connectedSessionKey, patchConn])

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

  useEffect(() => {
    if (!autoCheckUpdates || autoUpdateCheckedRef.current) return
    autoUpdateCheckedRef.current = true
    const timer = window.setTimeout(() => {
      checkForUpdates()
        .then(update => {
          if (update) setAvailableUpdate(update)
        })
        .catch(err => console.warn('[update] auto check failed', err))
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [autoCheckUpdates])

  // Vertical drag-resize for local panel
  const dragState = useRef<{ startY: number; startH: number } | null>(null)
  const sidebarDragState = useRef<{ startX: number; startW: number } | null>(null)
  const onVdhDown = useCallback((e: React.MouseEvent) => {
    dragState.current = { startY: e.clientY, startH: localHeight }
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return
      const delta = dragState.current.startY - ev.clientY
      setLocalHeight(Math.max(80, Math.min(600, dragState.current.startH + delta)))
    }
    const onUp = () => { dragState.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    e.preventDefault()
  }, [localHeight, setLocalHeight])

  const onSidebarResizeDown = useCallback((e: React.MouseEvent) => {
    if (!sidebarOpen) return
    sidebarDragState.current = { startX: e.clientX, startW: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragState.current) return
      setSidebarWidth(sidebarDragState.current.startW + ev.clientX - sidebarDragState.current.startX)
    }
    const onUp = () => {
      sidebarDragState.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    e.preventDefault()
  }, [sidebarOpen, sidebarWidth, setSidebarWidth])

  const appStyle = useMemo(() => ({
    ...s.app,
    backgroundColor: backgroundImageUrl ? 'transparent' : 'var(--c0)',
    backgroundImage: backgroundImageUrl ? `url("${backgroundImageUrl}")` : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  }), [backgroundImageUrl])

  return (
    <div style={appStyle}>
      {/* Titlebar */}
      <div style={s.titlebar} data-tauri-drag-region>
        <button style={s.tbBtn} onClick={toggleSidebar} title="toggle sidebar">
          <i className={`ti ti-layout-sidebar-left-${sidebarOpen ? 'collapse' : 'expand'}`} style={{fontSize:'var(--ui-font-lg)'}} />
        </button>
        <button style={s.tbBtn} onClick={toggleLocal} title="local terminal">
          <i className="ti ti-terminal" style={{fontSize:'var(--ui-font-md)'}} />
        </button>
        <i className="ti ti-terminal-2" style={{ fontSize:15, color:'var(--acc)', pointerEvents:'none' }} />
        <span style={s.tbTitle}>{active ? `Shelly - ${active.name}` : 'Shelly'}</span>
        <button style={s.tbBtn} onClick={toggleRight} title="side panel">
          <i className={`ti ti-layout-sidebar-right-${rightOpen ? 'collapse' : 'expand'}`} style={{fontSize:'var(--ui-font-lg)'}} />
        </button>
        <div style={s.wmBtns}>
          <button className="window-control" style={s.wmBtn} onClick={() => win.minimize()} title="minimize">
            <i className="ti ti-minus" />
          </button>
          <button className="window-control" style={s.wmBtn} onClick={() => win.toggleMaximize()} title="maximize">
            <i className="ti ti-square" />
          </button>
          <button className="window-control window-control-close" style={s.wmBtn} onClick={() => win.close()} title="close">
            <i className="ti ti-x" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={s.body}>
        <Sidebar />

        {/* Drag handle */}
        <div className="resize-handle resize-handle-left" style={s.dh} onMouseDown={onSidebarResizeDown} />

        {/* Main */}
        <div style={s.main}>
          {/* Terminal area */}
          <div style={s.panerow}>
            <div style={s.terminalStack}>
              {conns.filter(c => c.status === 'connected' && c.sessionId).map(c => (
                <Suspense key={c.sessionId} fallback={null}>
                  <TerminalView sessionId={c.sessionId ?? null} visible={c.id === activeId} />
                </Suspense>
              ))}
              {active?.status !== 'connected' && <Welcome />}
            </div>

            <div style={{ ...s.rightDockShell, width: rightOpen ? rightDockWidth : 0 }}>
              {rightDockMountedRef.current && (
                <Suspense fallback={<DockFallback />}>
                  <ContextDock active={active} />
                </Suspense>
              )}
            </div>
          </div>

          {/* Bottom panel */}
          {localOpen && (
            <div style={{ flexShrink:0, display:'flex', flexDirection:'column', borderTop:'1px solid var(--b1)' }}>
              <div className="resize-handle resize-handle-top" style={s.vdh} onMouseDown={onVdhDown} />
              <div style={{ height: localHeight, background:'var(--c0)', display:'flex', flexDirection:'column' }}>
                <div style={s.lpHd}>
                  <i className={`ti ${bottomPanelMode === 'agent' ? 'ti-sparkles' : 'ti-terminal'}`} style={{ fontSize:'var(--ui-font-md)', color:'var(--t2)' }} />
                  <span style={s.lpTitle}>{bottomPanelMode === 'agent' ? 'SSH AGENT' : 'TERMINAL'}</span>
                  <div style={{ flex:1 }} />
                  <button style={s.lpBtn} onClick={toggleLocal}><i className="ti ti-x" style={{ fontSize:'var(--ui-font)' }} /></button>
                </div>
                <div style={{ flex:1, minHeight:0 }}>
                  <Suspense fallback={<PanelFallback />}>
                    {bottomPanelMode === 'agent'
                      ? <AgentPanel active={active} width={900} />
                      : <LocalTerminal height={localHeight} />}
                  </Suspense>
                </div>
              </div>
            </div>
          )}

          {/* Status bar */}
          <div style={s.sbar}>
            <span style={s.si2}>
              <i className="ti ti-plug" />
              {active?.status === 'connected' ? ` ${active.name}` : ` ${t('shell.noSshSession')}`}
            </span>
            {active?.status === 'connected' && active.deviceStats && <StatusStats stats={active.deviceStats} />}
            <button style={s.cmdBtn} onClick={() => setCommandPaletteOpen(true)} title="open command palette">
              <span style={s.kbd}>/</span>
              <span>{t('general.commands')}</span>
            </button>
          </div>
        </div>
      </div>

      <Suspense fallback={showConnect ? <DialogFallback /> : null}>
        {showConnect && <ConnectDialog />}
        {showSettings && <SettingsDialog />}
        {commandPaletteOpen && <CommandPalette />}
      </Suspense>
      {availableUpdate && <UpdateDialog update={availableUpdate} onClose={() => setAvailableUpdate(null)} />}
    </div>
  )
}

function DockFallback() {
  return (
    <div style={s.dockFallback}>
      <div style={s.dockFallbackTabs}>
        <span>files</span>
      </div>
    </div>
  )
}

function PanelFallback() {
  const { t } = useI18n()
  return <div style={s.panelFallback}>{t('general.loading')}</div>
}

function DialogFallback() {
  const { t } = useI18n()
  return (
    <div style={s.dialogFallbackOverlay}>
      <div style={s.dialogFallbackBox}>{t('general.loading')}</div>
    </div>
  )
}

function Welcome() {
  const setShowConnect = useStore(s => s.setShowConnect)
  const { t } = useI18n()
  return (
    <div style={s.welcome}>
      <i className="ti ti-terminal-2" style={{ fontSize:36, color:'var(--t3)', marginBottom:6 }} />
      <strong style={{ color:'var(--t1)', fontSize:'var(--ui-font-lg)', letterSpacing:'0.04em' }}>SHELLY</strong>
      <span style={{ fontSize:'var(--ui-font)', color:'var(--t2)' }}>
        {t('welcome.selectConnection')}{' '}
        <span style={{ color:'var(--acc)', cursor:'pointer' }} onClick={() => setShowConnect(true)}>{t('general.createNewOne')}</span>.
      </span>
    </div>
  )
}

function StatusStats({ stats }: { stats: DeviceStats }) {
  const memUsed = percentUsed(stats.memTotalKb, stats.memAvailableKb)
  const diskUsed = percentUsed(stats.diskTotalKb, stats.diskAvailableKb)
  const pieces = [
    memUsed != null ? `RAM ${memUsed}%` : null,
    diskUsed != null ? `DISK ${diskUsed}%` : null,
    stats.loadAvg ? `LOAD ${stats.loadAvg.split(/\s+/)[0]}` : null,
  ].filter(Boolean)
  if (pieces.length === 0) return null
  return (
    <span style={s.statusStats} title={stats.hostname || undefined}>
      {pieces.map((piece, index) => (
        <span key={piece} style={s.statusStatPiece}>
          {index > 0 && <span style={s.statusDot}>/</span>}
          {piece}
        </span>
      ))}
    </span>
  )
}

function percentUsed(total?: number | null, available?: number | null) {
  if (!total || available == null || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((1 - available / total) * 100)))
}

const s: Record<string, React.CSSProperties> = {
  app: { width:'100%', height:'100%', display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--c0)' },
  tbBtn: { background:'none', border:'none', color:'var(--t2)', cursor:'pointer', fontSize:15, width:32, height:34, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:3, flexShrink:0 },
  titlebar: { height:34, background:'var(--c0)', borderBottom:'1px solid var(--b1)', display:'flex', alignItems:'center', padding:'0 0 0 10px', gap:8, flexShrink:0, userSelect:'none' },
  tbTitle: { fontSize:'var(--ui-font-lg)', color:'var(--t2)', letterSpacing:'0.03em', flex:1, pointerEvents:'none' as const },
  wmBtns: { display:'flex', height:34, marginLeft:'auto' },
  wmBtn: { width:46, height:34, border:'none', background:'transparent', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, color:'var(--t1)', cursor:'pointer', transition:'background 0.12s ease, color 0.12s ease', fontFamily:'var(--fs)', padding:0 } as React.CSSProperties,
  body: { display:'flex', flex:1, minHeight:0 },
  dh: { width:5, marginLeft:-2, marginRight:-3, background:'transparent', flexShrink:0, cursor:'col-resize', zIndex:6 },
  main: { flex:1, display:'flex', flexDirection:'column', minWidth:0, minHeight:0, overflow:'hidden', background:'transparent' },
  panerow: { flex:'1 1 0px', display:'flex', minHeight:0, overflow:'hidden' },
  terminalStack: { flex:1, minWidth:0, minHeight:0, position:'relative', background:'transparent' },
  rightDockShell: { flexShrink:0, minWidth:0, minHeight:0, height:'100%', display:'flex', overflow:'hidden', transition:'width 0.16s ease', willChange:'width' },
  welcome: { width:'100%', height:'100%', minWidth:0, background:'var(--c0)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:6, color:'var(--t2)' },
  rsb: { width:200, flexShrink:0, background:'var(--c0)', borderLeft:'1px solid var(--b1)', display:'flex', flexDirection:'column', overflow:'hidden' },
  rsbTabs: { display:'flex', borderBottom:'1px solid var(--b1)', height:30, flexShrink:0, paddingLeft:4, alignItems:'center' },
  rstOn: { flex:1, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'var(--ui-font-sm)', color:'var(--t0)', cursor:'pointer', boxShadow:'inset 0 1px 0 var(--acc)', height:'100%' },
  rst: { flex:1, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'var(--ui-font-sm)', color:'var(--t2)', cursor:'pointer', height:'100%' },
  rsbBody: { flex:1, overflowY:'auto', padding:8 },
  hint2: { fontSize:'var(--ui-font)', color:'var(--t3)', padding:'14px 8px', textAlign:'center', lineHeight:1.7 },
  dockFallback: { width:280, flexShrink:0, background:'var(--c0)', borderLeft:'1px solid var(--b1)', display:'flex', flexDirection:'column' },
  dockFallbackTabs: { height:30, display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:'1px solid var(--b1)', color:'var(--t2)', fontSize:'var(--ui-font-sm)', padding:'0 6px 0 12px' },
  panelFallback: { height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--t3)', fontSize:'var(--ui-font)', fontFamily:'var(--fm)' },
  dialogFallbackOverlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:998 },
  dialogFallbackBox: { minWidth:180, padding:'14px 18px', border:'1px solid var(--b2)', background:'var(--c1)', color:'var(--t2)', borderRadius:6, textAlign:'center', fontSize:'var(--ui-font)' },
  sbar: { display:'flex', alignItems:'center', gap:8, padding:'3px 12px', background:'var(--acc)', fontSize:'var(--ui-font-sm)', color:'rgba(0,0,0,0.75)', flexShrink:0, fontFamily:'var(--fm)' },
  si2: { display:'flex', alignItems:'center', gap:3, fontSize:'var(--ui-font-sm)' },
  statusStats: { display:'flex', alignItems:'center', gap:5, minWidth:0, overflow:'hidden', whiteSpace:'nowrap', opacity:0.92 },
  statusStatPiece: { display:'inline-flex', alignItems:'center', gap:5 },
  statusDot: { opacity:0.45 },
  cmdBtn: { marginLeft:'auto', display:'flex', gap:8, alignItems:'center', border:'none', background:'transparent', color:'rgba(0,0,0,0.75)', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)', cursor:'pointer', padding:0 },
  kbd: { fontSize:'var(--ui-font-sm)', background:'rgba(0,0,0,0.15)', borderRadius:2, padding:'0 5px', lineHeight:'16px', display:'inline-block' },
  vdh: { height:4, cursor:'row-resize', background:'transparent', flexShrink:0, transition:'background 0.1s' },
  lpHd: { height:28, display:'flex', alignItems:'center', padding:'0 10px', gap:6, borderBottom:'1px solid var(--b1)', flexShrink:0 },
  lpTitle: { fontSize:'var(--ui-font-sm)', color:'var(--t2)', letterSpacing:'0.1em', textTransform:'uppercase' as const },
  lpBtn: { background:'none', border:'none', color:'var(--t2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, padding:0 },
}
