import { useStore, type Connection } from '../store'
import { sshDisconnect } from '../lib/ssh'

const dot = (s: Connection['status']) => ({
  connected: '#4ec9b0', connecting: '#e5c07b', disconnected: '#454545', error: '#f44747',
}[s])

export function Sidebar() {
  const { conns, activeId, sidebarOpen, setActive, setShowConnect, removeConn, patchConn } = useStore(s => s)

  const disconnect = async (c: Connection, e: React.MouseEvent) => {
    e.stopPropagation()
    if (c.sessionId) await sshDisconnect(c.sessionId)
    patchConn(c.id, { status: 'disconnected', sessionId: undefined })
  }

  return (
    <div style={{ ...sOpen.root, width: sidebarOpen ? 200 : 0 }}>
      {sidebarOpen && <>
        <div style={s.search}><i className="ti ti-search" style={{ color:'#454545', fontSize:11 }} />
          <span style={{ fontSize:11, color:'#454545', marginLeft:5 }}>filter connections</span></div>
        <div style={s.sec}>connections</div>
        <div style={s.list}>
          {conns.length === 0
            ? <div style={s.hint}>No connections yet.<br />Click + to add one.</div>
            : conns.map(c => (
              <div key={c.id} style={{ ...s.item, ...(c.id === activeId ? s.itemOn : {}) }}
                   onClick={() => c.status === 'connected' && setActive(c.id)}>
                <span style={{ ...s.cdot, background: dot(c.status) }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={s.cname}>{c.name}</div>
                  <div style={s.chost}>{c.username}@{c.host}</div>
                </div>
                <button style={s.itemBtn} onClick={e => { removeConn(c.id); disconnect(c, e) }} title="remove">
                  <i className="ti ti-x" />
                </button>
              </div>
            ))
          }
        </div>
        <div style={s.foot}>
          <button style={s.iconBtn} onClick={() => setShowConnect(true)} title="new connection"><i className="ti ti-plus" /></button>
          <button style={s.iconBtn} title="settings"><i className="ti ti-settings" /></button>
        </div>
      </>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  iconBtn: { width:20, height:20, background:'none', border:'none', color:'#686868', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:3, fontSize:12, padding:0 },
  search: { margin:'7px 8px', display:'flex', alignItems:'center', background:'#2d2d2d', border:'1px solid rgba(255,255,255,0.09)', borderRadius:3, padding:'4px 8px' },
  sec: { fontSize:10, color:'#454545', letterSpacing:'0.08em', textTransform:'uppercase', padding:'7px 10px 3px' },
  list: { flex:1, overflowY:'auto', padding:'0 4px' },
  hint: { fontSize:11, color:'#454545', padding:'20px 10px', textAlign:'center', lineHeight:1.7 },
  item: { display:'flex', alignItems:'center', gap:7, padding:'5px 7px', borderRadius:3, cursor:'pointer' },
  itemOn: { background:'#3c3c3c' },
  cdot: { width:6, height:6, borderRadius:'50%', flexShrink:0 },
  cname: { fontSize:11, color:'#d4d4d4', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  chost: { fontSize:10, color:'#686868', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontFamily:'var(--fm)' },
  itemBtn: { background:'none', border:'none', color:'#454545', cursor:'pointer', fontSize:10, padding:2, borderRadius:2, display:'flex', alignItems:'center' },
  foot: { padding:'5px 4px', borderTop:'1px solid rgba(255,255,255,0.05)', display:'flex', gap:1 },
}
const sOpen = {
  root: { flexShrink:0, background:'#1e1e1e', borderRight:'1px solid rgba(0,0,0,0.4)', display:'flex', flexDirection:'column' as const, overflow:'hidden', transition:'width 0.15s' },
}
