import { useMemo, useState } from 'react'
import { useStore, type Connection } from '../store'
import { sshDisconnect } from '../lib/ssh'
import { deleteDevice, updateDeviceSession } from '../lib/db'

const dot = (s: Connection['status']) => ({
  connected: '#4ec9b0', connecting: '#e5c07b', disconnected: '#454545', error: '#f44747',
}[s])

export function Sidebar() {
  const [query, setQuery] = useState('')
  const { conns, activeId, sidebarOpen, setActive, openConnectDialog, removeConn, patchConn, setShowSettings } = useStore(s => s)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conns
    return conns.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.host.toLowerCase().includes(q) ||
      c.username.toLowerCase().includes(q)
    )
  }, [conns, query])

  const openDevice = (c: Connection) => {
    if (c.status === 'connected') {
      setActive(c.id)
      return
    }
    openConnectDialog({
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      rememberPassword: c.rememberPassword,
    })
  }

  const disconnect = async (c: Connection, e: React.MouseEvent) => {
    e.stopPropagation()
    if (c.sessionId) await sshDisconnect(c.sessionId)
    await updateDeviceSession(c.id, null).catch(() => undefined)
    patchConn(c.id, { status: 'disconnected', sessionId: undefined })
  }

  const removeDevice = async (c: Connection, e: React.MouseEvent) => {
    e.stopPropagation()
    if (c.sessionId) await sshDisconnect(c.sessionId).catch(() => undefined)
    await deleteDevice(c.id)
    removeConn(c.id)
  }

  return (
    <div style={{ ...sOpen.root, width: sidebarOpen ? 200 : 0 }}>
      {sidebarOpen && <>
        <div style={s.search}>
          <i className="ti ti-search" style={{ color:'#454545', fontSize:11 }} />
          <input style={s.searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder="filter devices" />
        </div>
        <div style={s.sec}>devices</div>
        <div style={s.list}>
          {filtered.length === 0
            ? <div style={s.hint}>{conns.length === 0 ? 'No devices yet.' : 'No matching devices.'}<br />Click + to add one.</div>
            : filtered.map(c => (
              <div key={c.id} style={{ ...s.item, ...(c.id === activeId ? s.itemOn : {}) }}
                   onClick={() => setActive(c.id)}
                   onDoubleClick={() => openDevice(c)}
                   title={c.status === 'connected' ? 'Double-click to focus' : 'Double-click to connect'}>
                <span style={{ ...s.cdot, background: dot(c.status) }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={s.cname}>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis' }}>{c.name}</span>
                    {c.rememberPassword && <i className="ti ti-key" style={s.keyIcon} />}
                  </div>
                  <div style={s.chost}>{c.username}@{c.host}</div>
                </div>
                {c.status === 'connected' ? (
                  <button style={s.itemBtn} onClick={e => disconnect(c, e)} title="disconnect">
                    <i className="ti ti-player-stop" />
                  </button>
                ) : (
                  <button style={s.itemBtn} onClick={e => { e.stopPropagation(); openDevice(c) }} title="connect">
                    <i className="ti ti-plug-connected" />
                  </button>
                )}
                <button style={s.itemBtn} onClick={e => removeDevice(c, e)} title="remove device">
                  <i className="ti ti-x" />
                </button>
              </div>
            ))
          }
        </div>
        <div style={s.foot}>
          <button style={s.iconBtn} onClick={() => openConnectDialog()} title="new connection"><i className="ti ti-plus" /></button>
          <button style={s.iconBtn} onClick={() => setShowSettings(true)} title="settings"><i className="ti ti-settings" /></button>
        </div>
      </>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  iconBtn: { width:20, height:20, background:'none', border:'none', color:'#686868', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:3, fontSize:12, padding:0 },
  search: { margin:'7px 8px', display:'flex', alignItems:'center', background:'#2d2d2d', border:'1px solid rgba(255,255,255,0.09)', borderRadius:3, padding:'4px 8px' },
  searchInput: { minWidth:0, flex:1, background:'transparent', border:'none', outline:'none', color:'#9d9d9d', fontSize:11, fontFamily:'var(--fm)', marginLeft:5 },
  sec: { fontSize:10, color:'#454545', letterSpacing:'0.08em', textTransform:'uppercase', padding:'7px 10px 3px' },
  list: { flex:1, overflowY:'auto', padding:'0 4px' },
  hint: { fontSize:11, color:'#454545', padding:'20px 10px', textAlign:'center', lineHeight:1.7 },
  item: { display:'flex', alignItems:'center', gap:7, padding:'5px 7px', borderRadius:3, cursor:'pointer' },
  itemOn: { background:'#3c3c3c' },
  cdot: { width:6, height:6, borderRadius:'50%', flexShrink:0 },
  cname: { fontSize:11, color:'#d4d4d4', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'flex', alignItems:'center', gap:5 },
  keyIcon: { color:'#686868', fontSize:10, flexShrink:0 },
  chost: { fontSize:10, color:'#686868', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontFamily:'var(--fm)' },
  itemBtn: { background:'none', border:'none', color:'#454545', cursor:'pointer', fontSize:10, padding:2, borderRadius:2, display:'flex', alignItems:'center' },
  foot: { padding:'5px 4px', borderTop:'1px solid rgba(255,255,255,0.05)', display:'flex', gap:1 },
}
const sOpen = {
  root: { flexShrink:0, background:'#1e1e1e', borderRight:'1px solid rgba(0,0,0,0.4)', display:'flex', flexDirection:'column' as const, overflow:'hidden', transition:'width 0.15s' },
}
