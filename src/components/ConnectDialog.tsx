import { useState } from 'react'
import { useStore } from '../store'
import { sshConnect } from '../lib/ssh'

export function ConnectDialog() {
  const [form, setForm] = useState({ name: '', host: '', port: '22', username: '', password: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const { addConn, patchConn, setActive, setShowConnect } = useStore(s => s)

  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(v => ({ ...v, [k]: e.target.value }))

  const connect = async () => {
    if (!form.host || !form.username) { setErr('Host and username are required'); return }
    setBusy(true); setErr('')
    const id = addConn({ name: form.name || form.host, host: form.host, port: +form.port || 22, username: form.username })
    patchConn(id, { status: 'connecting' })
    try {
      const sessionId = await sshConnect({ host: form.host, port: +form.port || 22, username: form.username, password: form.password })
      patchConn(id, { status: 'connected', sessionId })
      setActive(id)
      setShowConnect(false)
    } catch (e: any) {
      patchConn(id, { status: 'error' })
      setErr(e?.toString() ?? 'Connection failed')
    } finally { setBusy(false) }
  }

  const S = styles
  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && setShowConnect(false)}>
      <div style={S.box}>
        <div style={S.hd}><span style={S.hdTitle}>New Connection</span>
          <button style={S.closeBtn} onClick={() => setShowConnect(false)}>✕</button></div>
        <div style={S.body}>
          {(['name','host','username'] as const).map(k => (
            <label key={k} style={S.row}>
              <span style={S.lbl}>{k}</span>
              <input style={S.inp} value={form[k]} onChange={f(k)}
                placeholder={k === 'name' ? 'optional' : k} autoFocus={k === 'host'} />
            </label>
          ))}
          <label style={S.row}>
            <span style={S.lbl}>port</span>
            <input style={{ ...S.inp, width: 80 }} value={form.port} onChange={f('port')} />
          </label>
          <label style={S.row}>
            <span style={S.lbl}>password</span>
            <input style={S.inp} type="password" value={form.password} onChange={f('password')} onKeyDown={e => e.key==='Enter' && connect()} />
          </label>
          {err && <div style={S.err}>{err}</div>}
          <button style={{ ...S.btn, opacity: busy ? 0.6 : 1 }} onClick={connect} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:999 },
  box: { background:'#252526', border:'1px solid rgba(255,255,255,0.12)', borderRadius:6, width:340, fontFamily:'var(--fm)' },
  hd: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px', borderBottom:'1px solid rgba(0,0,0,0.4)' },
  hdTitle: { fontSize:12, color:'#d4d4d4', fontWeight:600, letterSpacing:'0.05em' },
  closeBtn: { background:'none', border:'none', color:'#686868', cursor:'pointer', fontSize:14, padding:2 },
  body: { padding:'12px 14px', display:'flex', flexDirection:'column', gap:8 },
  row: { display:'flex', alignItems:'center', gap:8 },
  lbl: { fontSize:11, color:'#686868', width:72, flexShrink:0, textAlign:'right' },
  inp: { flex:1, background:'#2d2d2d', border:'1px solid rgba(255,255,255,0.1)', borderRadius:3,
    padding:'4px 8px', fontSize:12, color:'#d4d4d4', fontFamily:'var(--fm)', outline:'none' },
  err: { fontSize:11, color:'#f44747', marginTop:2 },
  btn: { marginTop:4, background:'#569cd6', border:'none', borderRadius:3, padding:'6px 0',
    color:'#fff', fontSize:12, cursor:'pointer', fontFamily:'var(--fm)' },
}
