import { getCurrentWindow } from '@tauri-apps/api/window'
import { useRef, useCallback, useEffect } from 'react'
import { useStore, type Connection } from './store'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'
import { LocalTerminal } from './components/LocalTerminal'
import { ConnectDialog } from './components/ConnectDialog'
import { CommandPalette } from './components/CommandPalette'
import { ContextDock } from './components/ContextDock'
import { AgentPanel } from './components/AgentPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { listCommandHistory, listDevices, listSnippets, updateDeviceSession } from './lib/db'
import { sshDisconnect } from './lib/ssh'

const win = getCurrentWindow()

export default function App() {
  const { conns, activeId, rightOpen, showConnect, toggleRight, sidebarOpen, toggleSidebar,
          localOpen, localHeight, bottomPanelMode, toggleLocal, setLocalHeight, setCommandPaletteOpen,
          setConns, setCommandHistory, setCommandSnippets } = useStore(s => s)
  const active = conns.find(c => c.id === activeId)

  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        win.show().catch(err => console.warn('[window] show failed', err))
      })
    })
  }, [])

  useEffect(() => {
    Promise.all([listDevices(), listCommandHistory(undefined, 100), listSnippets()])
      .then(([devices, history, snippets]) => {
        setConns(devices.map(device => ({
          id: device.id,
          name: device.name,
          host: device.host,
          port: device.port,
          username: device.username,
          status: 'disconnected',
          rememberPassword: device.rememberPassword,
        })))
        setCommandHistory(history.map(entry => ({
          id: entry.id,
          command: entry.command,
          connectionName: devices.find(device => device.id === entry.deviceId)?.name,
          lastUsedAt: entry.createdAt,
        })))
        setCommandSnippets(snippets.map(snippet => ({
          id: snippet.id,
          name: snippet.name,
          command: snippet.command,
          createdAt: snippet.createdAt,
          updatedAt: snippet.updatedAt,
        })))
      })
      .catch(err => console.warn('[db] hydrate failed', err))
  }, [setCommandHistory, setCommandSnippets, setConns])

  // Vertical drag-resize for local panel
  const dragState = useRef<{ startY: number; startH: number } | null>(null)
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

  return (
    <div style={s.app}>
      {/* Titlebar */}
      <div style={s.titlebar} data-tauri-drag-region>
        <button style={s.tbBtn} onClick={toggleSidebar} title="toggle sidebar">
          <i className={`ti ti-layout-sidebar-left-${sidebarOpen ? 'collapse' : 'expand'}`} style={{fontSize:13}} />
        </button>
        <i className="ti ti-terminal-2" style={{ fontSize:15, color:'#569cd6', pointerEvents:'none' }} />
        <span style={s.tbTitle}>{active ? `Shelly - ${active.name}` : 'Shelly'}</span>
        <div style={s.wmBtns}>
          <div style={s.wmBtn} onClick={() => win.minimize()}>&#x2012;</div>
          <div style={s.wmBtn} onClick={() => win.toggleMaximize()}>&#x25A1;</div>
          <div style={{ ...s.wmBtn, ...s.wmClose }} onClick={() => win.close()}>&#x2715;</div>
        </div>
      </div>

      {/* Body */}
      <div style={s.body}>
        <Sidebar />

        {/* Drag handle */}
        <div style={s.dh} />

        {/* Main */}
        <div style={s.main}>
          {/* Tabbar */}
          <div style={s.tabbar}>
            {conns.filter(c => c.status === 'connected').map(c => (
              <Tab key={c.id} conn={c} active={c.id === activeId} />
            ))}
            <div style={{ flex:1 }} data-tauri-drag-region />
            <TbaBtn icon="ti-terminal" onClick={toggleLocal} title="local terminal" />
            <TbaBtn icon="ti-layout-sidebar-right" onClick={toggleRight} title="side panel" />
          </div>

          {/* Terminal area */}
          <div style={s.panerow}>
            <div style={s.terminalStack}>
              {conns.filter(c => c.status === 'connected' && c.sessionId).map(c => (
                <TerminalView key={c.sessionId} sessionId={c.sessionId ?? null} visible={c.id === activeId} />
              ))}
              {active?.status !== 'connected' && <Welcome />}
            </div>

            {rightOpen && <ContextDock active={active} onClose={toggleRight} />}
          </div>

          {/* Bottom panel */}
          {localOpen && (
            <div style={{ flexShrink:0, display:'flex', flexDirection:'column', borderTop:'1px solid rgba(0,0,0,0.5)' }}>
              <div className="resize-handle resize-handle-top" style={s.vdh} onMouseDown={onVdhDown} />
              <div style={{ height: localHeight, background:'#141414', display:'flex', flexDirection:'column' }}>
                <div style={s.lpHd}>
                  <i className={`ti ${bottomPanelMode === 'agent' ? 'ti-sparkles' : 'ti-terminal'}`} style={{ fontSize:12, color:'#686868' }} />
                  <span style={s.lpTitle}>{bottomPanelMode === 'agent' ? 'SSH AGENT' : 'TERMINAL'}</span>
                  <div style={{ flex:1 }} />
                  <button style={s.lpBtn} onClick={toggleLocal}><i className="ti ti-x" style={{ fontSize:11 }} /></button>
                </div>
                <div style={{ flex:1, minHeight:0 }}>
                  {bottomPanelMode === 'agent'
                    ? <AgentPanel active={active} width={900} />
                    : <LocalTerminal height={localHeight} />}
                </div>
              </div>
            </div>
          )}

          {/* Status bar */}
          <div style={s.sbar}>
            <span style={s.si2}>
              <i className="ti ti-plug" />
              {active?.status === 'connected' ? ` ${active.name}` : ' Not connected'}
            </span>
            <button style={s.cmdBtn} onClick={() => setCommandPaletteOpen(true)} title="open command palette">
              <span style={s.kbd}>/</span>
              <span>commands</span>
            </button>
          </div>
        </div>
      </div>

      {showConnect && <ConnectDialog />}
      <SettingsDialog />
      <CommandPalette />
    </div>
  )
}

function Welcome() {
  const setShowConnect = useStore(s => s.setShowConnect)
  return (
    <div style={s.welcome}>
      <i className="ti ti-terminal-2" style={{ fontSize:36, color:'#454545', marginBottom:6 }} />
      <strong style={{ color:'#9d9d9d', fontSize:13, letterSpacing:'0.04em' }}>SHELLY</strong>
      <span style={{ fontSize:11, color:'#686868' }}>
        Select a connection, or{' '}
        <span style={{ color:'#569cd6', cursor:'pointer' }} onClick={() => setShowConnect(true)}>create a new one</span>.
      </span>
    </div>
  )
}

function Tab({ conn, active }: { conn: Connection; active: boolean }) {
  const { conns, setActive, patchConn, reorderConn } = useStore(s => s)

  const close = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (conn.sessionId) await sshDisconnect(conn.sessionId).catch(() => undefined)
    await updateDeviceSession(conn.id, null).catch(() => undefined)
    patchConn(conn.id, { status: 'disconnected', sessionId: undefined })
    if (active) {
      const next = conns.find(c => c.id !== conn.id && c.status === 'connected')
      setActive(next?.id ?? null)
    }
  }

  return (
    <div
      style={{ ...s.tab, ...(active ? s.tabOn : {}) }}
      onClick={() => setActive(conn.id)}
      draggable
      onDragStart={e => e.dataTransfer.setData('text/plain', conn.id)}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault()
        const dragId = e.dataTransfer.getData('text/plain')
        reorderConn(dragId, conn.id)
      }}
    >
      <i className="ti ti-terminal" style={{ fontSize:11 }} />
      <span style={s.tabTitle}>{conn.name}</span>
      <button style={s.tabClose} onClick={close} title="close tab">
        <i className="ti ti-x" />
      </button>
    </div>
  )
}

function TbaBtn({ icon, onClick, title }: { icon: string; onClick: () => void; title: string }) {
  return (
    <div style={s.tba} onClick={onClick} title={title}>
      <i className={`ti ${icon}`} style={{ fontSize:12 }} />
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  app: { width:'100%', height:'100%', display:'flex', flexDirection:'column', overflow:'hidden', background:'#1e1e1e' },
  tbBtn: { background:'none', border:'none', color:'#686868', cursor:'pointer', fontSize:15, width:32, height:34, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:3, flexShrink:0 },
  titlebar: { height:34, background:'#1e1e1e', borderBottom:'1px solid rgba(0,0,0,0.5)', display:'flex', alignItems:'center', padding:'0 0 0 10px', gap:8, flexShrink:0, userSelect:'none' },
  tbTitle: { fontSize:13, color:'#686868', letterSpacing:'0.03em', flex:1, pointerEvents:'none' as const },
  wmBtns: { display:'flex', height:34, marginLeft:'auto' },
  wmBtn: { width:46, height:34, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, color:'#9d9d9d', cursor:'pointer', transition:'background 0.1s', fontFamily:'var(--fs)' } as React.CSSProperties,
  wmClose: { } as React.CSSProperties,
  body: { display:'flex', flex:1, minHeight:0 },
  dh: { width:1, background:'transparent', flexShrink:0, cursor:'col-resize' },
  main: { flex:1, display:'flex', flexDirection:'column', minWidth:0, minHeight:0, overflow:'hidden', background:'#252526' },
  tabbar: { display:'flex', alignItems:'center', background:'#1e1e1e', borderBottom:'1px solid rgba(0,0,0,0.4)', height:34, padding:'0 6px', flexShrink:0 },
  tab: { display:'flex', alignItems:'center', gap:5, height:34, padding:'0 8px 0 12px', fontSize:12, color:'#686868', cursor:'pointer', whiteSpace:'nowrap' as const, maxWidth:180 },
  tabOn: { color:'#d4d4d4', background:'#252526', boxShadow:'inset 0 1px 0 #569cd6' },
  tabTitle: { minWidth:0, overflow:'hidden', textOverflow:'ellipsis' },
  tabClose: { width:18, height:18, display:'flex', alignItems:'center', justifyContent:'center', border:'none', borderRadius:3, background:'transparent', color:'#686868', cursor:'pointer', fontSize:10, padding:0, flexShrink:0 },
  tba: { display:'flex', alignItems:'center', justifyContent:'center', width:32, height:34, cursor:'pointer', color:'#686868' },
  panerow: { flex:'1 1 0px', display:'flex', minHeight:0, overflow:'hidden' },
  terminalStack: { flex:1, minWidth:0, minHeight:0, position:'relative', background:'#1e1e1e' },
  welcome: { width:'100%', height:'100%', minWidth:0, background:'#1e1e1e', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:6, color:'#686868' },
  rsb: { width:200, flexShrink:0, background:'#1e1e1e', borderLeft:'1px solid rgba(0,0,0,0.4)', display:'flex', flexDirection:'column', overflow:'hidden' },
  rsbTabs: { display:'flex', borderBottom:'1px solid rgba(0,0,0,0.4)', height:30, flexShrink:0, paddingLeft:4, alignItems:'center' },
  rstOn: { flex:1, display:'flex', alignItems:'center', justifyContent:'center', fontSize:10.5, color:'#d4d4d4', cursor:'pointer', boxShadow:'inset 0 1px 0 #569cd6', height:'100%' },
  rst: { flex:1, display:'flex', alignItems:'center', justifyContent:'center', fontSize:10.5, color:'#686868', cursor:'pointer', height:'100%' },
  rsbClose: { background:'none', border:'none', color:'#454545', cursor:'pointer', padding:'0 6px', fontSize:11 },
  rsbBody: { flex:1, overflowY:'auto', padding:8 },
  hint2: { fontSize:11, color:'#454545', padding:'14px 8px', textAlign:'center', lineHeight:1.7 },
  sbar: { display:'flex', alignItems:'center', gap:8, padding:'3px 12px', background:'#569cd6', fontSize:10, color:'rgba(0,0,0,0.75)', flexShrink:0, fontFamily:'var(--fm)' },
  si2: { display:'flex', alignItems:'center', gap:3, fontSize:10 },
  cmdBtn: { marginLeft:'auto', display:'flex', gap:8, alignItems:'center', border:'none', background:'transparent', color:'rgba(0,0,0,0.75)', fontFamily:'var(--fm)', fontSize:10, cursor:'pointer', padding:0 },
  kbd: { fontSize:10, background:'rgba(0,0,0,0.15)', borderRadius:2, padding:'0 5px', lineHeight:'16px', display:'inline-block' },
  vdh: { height:4, cursor:'row-resize', background:'transparent', flexShrink:0, transition:'background 0.1s' },
  lpHd: { height:28, display:'flex', alignItems:'center', padding:'0 10px', gap:6, borderBottom:'1px solid rgba(0,0,0,0.4)', flexShrink:0 },
  lpTitle: { fontSize:10, color:'#686868', letterSpacing:'0.1em', textTransform:'uppercase' as const },
  lpBtn: { background:'none', border:'none', color:'#686868', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, padding:0 },
}
