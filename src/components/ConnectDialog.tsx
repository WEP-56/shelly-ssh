import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { sshConnect } from '../lib/ssh'
import { deleteDevicePassword, getDevicePassword, saveDevice, saveDevicePassword, updateDeviceSession } from '../lib/db'

export function ConnectDialog() {
  const [form, setForm] = useState({ name: '', host: '', port: '22', username: '', password: '', rememberPassword: false })
  const [hasSavedPassword, setHasSavedPassword] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const { addConn, patchConn, setActive, setShowConnect, connectDraft } = useStore(s => s)

  useEffect(() => {
    if (connectDraft) {
      setForm({
        name: connectDraft.name,
        host: connectDraft.host,
        port: String(connectDraft.port || 22),
        username: connectDraft.username,
        password: '',
        rememberPassword: !!connectDraft.rememberPassword,
      })
      setHasSavedPassword(false)
      if (connectDraft.rememberPassword && connectDraft.id) {
        getDevicePassword(connectDraft.id)
          .then(password => setHasSavedPassword(!!password))
          .catch(() => setHasSavedPassword(false))
      }
      requestAnimationFrame(() => {
        if (!connectDraft.rememberPassword) passwordRef.current?.focus()
      })
    } else {
      setForm({ name: '', host: '', port: '22', username: '', password: '', rememberPassword: false })
      setHasSavedPassword(false)
    }
    setErr('')
  }, [connectDraft])

  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(v => ({ ...v, [k]: e.target.value }))

  const connect = async () => {
    if (!form.host || !form.username) { setErr('Host and username are required'); return }
    setBusy(true); setErr('')
    let id: string | null = null
    try {
      let password = form.password
      if (!password && connectDraft?.id && form.rememberPassword) {
        password = await getDevicePassword(connectDraft.id) ?? ''
      }
      if (!password) {
        throw new Error(form.rememberPassword ? 'Saved password is missing. Enter it once to refresh.' : 'Password is required')
      }

      const device = await saveDevice({
        id: connectDraft?.id,
        name: form.name || form.host,
        host: form.host,
        port: +form.port || 22,
        username: form.username,
        rememberPassword: form.rememberPassword,
      })
      id = addConn({
        id: device.id,
        name: device.name,
        host: device.host,
        port: device.port,
        username: device.username,
        rememberPassword: device.rememberPassword,
      })
      patchConn(id, { status: 'connecting' })
      const sessionId = await sshConnect({ host: form.host, port: +form.port || 22, username: form.username, password })
      if (form.rememberPassword) {
        await saveDevicePassword(id, password)
      } else {
        await deleteDevicePassword(id).catch(() => undefined)
      }
      await updateDeviceSession(id, sessionId)
      patchConn(id, { status: 'connected', sessionId })
      setActive(id)
      setShowConnect(false)
    } catch (e: any) {
      if (id) {
        await updateDeviceSession(id, null).catch(() => undefined)
        if (!form.rememberPassword) await deleteDevicePassword(id).catch(() => undefined)
        patchConn(id, { status: 'error' })
      }
      setErr(e?.toString() ?? 'Connection failed')
    } finally { setBusy(false) }
  }

  const S = styles
  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && setShowConnect(false)}>
      <div style={S.box}>
        <div style={S.hd}><span style={S.hdTitle}>{connectDraft ? 'Connect Device' : 'New Connection'}</span>
          <button style={S.closeBtn} onClick={() => setShowConnect(false)}>x</button></div>
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
            <input
              ref={passwordRef}
              style={S.inp}
              type="password"
              value={form.password}
              onChange={f('password')}
              placeholder={hasSavedPassword ? 'saved password' : ''}
              onKeyDown={e => e.key==='Enter' && connect()}
            />
          </label>
          <label style={S.checkRow}>
            <span style={S.lbl} />
            <input
              type="checkbox"
              checked={form.rememberPassword}
              onChange={e => setForm(v => ({ ...v, rememberPassword: e.target.checked }))}
            />
            <span style={S.checkText}>remember password</span>
          </label>
          {err && <div style={S.err}>{err}</div>}
          <button style={{ ...S.btn, opacity: busy ? 0.6 : 1 }} onClick={connect} disabled={busy}>
            {busy ? 'Connecting...' : 'Connect'}
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
  checkRow: { display:'flex', alignItems:'center', gap:8 },
  checkText: { fontSize:11, color:'#9d9d9d' },
  inp: { flex:1, background:'#2d2d2d', border:'1px solid rgba(255,255,255,0.1)', borderRadius:3,
    padding:'4px 8px', fontSize:12, color:'#d4d4d4', fontFamily:'var(--fm)', outline:'none' },
  err: { fontSize:11, color:'#f44747', marginTop:2 },
  btn: { marginTop:4, background:'#569cd6', border:'none', borderRadius:3, padding:'6px 0',
    color:'#fff', fontSize:12, cursor:'pointer', fontFamily:'var(--fm)' },
}
