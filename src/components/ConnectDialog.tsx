import { useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useStore } from '../store'
import { onSshHostKeyPrompt, sshConnect, sshHostKeyRespond } from '../lib/ssh'
import { deleteDevicePassword, getDevicePassword, saveDevice, saveDevicePassword, updateDeviceSession } from '../lib/db'
import { useI18n } from '../i18n'

const startupLogs = import.meta.env.DEV || import.meta.env.VITE_STARTUP_LOGS === '1'

if (startupLogs) {
  console.info(`[startup] ConnectDialog module loaded at ${Math.round(performance.now())}ms`)
}

export function ConnectDialog() {
  const { language, t } = useI18n()
  const [form, setForm] = useState({
    name: '',
    host: '',
    port: '22',
    username: '',
    authMethod: 'password' as 'password' | 'privateKey',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    rememberPassword: false,
  })
  const [hasSavedPassword, setHasSavedPassword] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const { addConn, patchConn, setActive, setShowConnect, connectDraft } = useStore(s => s)

  useEffect(() => {
    let unlisten: (() => void) | null = null
    onSshHostKeyPrompt(prompt => {
      const message = language === 'zh-CN'
        ? [
            `首次连接 ${prompt.host}:${prompt.port}。`,
            '',
            'Shelly 尚未信任此服务器 host key。',
            `算法：${prompt.algorithm}`,
            `指纹：${prompt.fingerprint}`,
            '',
            `确认后会写入：${prompt.knownHostsPath}`,
            '仅在你确认这是目标服务器时继续。',
          ].join('\n')
        : [
            `First connection to ${prompt.host}:${prompt.port}.`,
            '',
            'Shelly does not trust this server host key yet.',
            `Algorithm: ${prompt.algorithm}`,
            `Fingerprint: ${prompt.fingerprint}`,
            '',
            `Accepting writes it to: ${prompt.knownHostsPath}`,
            'Continue only if this is the server you expect.',
          ].join('\n')
      const accept = window.confirm(message)
      sshHostKeyRespond(prompt.promptId, accept).catch(err => {
        console.warn('[ssh] host key response failed', err)
      })
    }).then(fn => { unlisten = fn })
    return () => { unlisten?.() }
  }, [language])

  useEffect(() => {
    if (connectDraft) {
      setForm({
        name: connectDraft.name,
        host: connectDraft.host,
        port: String(connectDraft.port || 22),
        username: connectDraft.username,
        authMethod: connectDraft.authMethod ?? 'password',
        password: '',
        privateKeyPath: connectDraft.privateKeyPath ?? '',
        passphrase: '',
        rememberPassword: !!connectDraft.rememberPassword,
      })
      setHasSavedPassword(false)
      if (connectDraft.rememberPassword && connectDraft.id) {
        const started = performance.now()
        getDevicePassword(connectDraft.id)
          .then(password => {
            if (startupLogs) {
              console.info(`[perf] getDevicePassword(${connectDraft.id}) resolved in ${Math.round(performance.now() - started)}ms`)
            }
            setHasSavedPassword(!!password)
          })
          .catch(err => {
            console.warn('[perf] getDevicePassword failed', err)
            setHasSavedPassword(false)
          })
      }
      requestAnimationFrame(() => {
        if (!connectDraft.rememberPassword) passwordRef.current?.focus()
      })
    } else {
      setForm({ name: '', host: '', port: '22', username: '', authMethod: 'password', password: '', privateKeyPath: '', passphrase: '', rememberPassword: false })
      setHasSavedPassword(false)
    }
    setErr('')
  }, [connectDraft])

  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(v => ({ ...v, [k]: e.target.value }))

  const choosePrivateKey = async () => {
    const selected = await open({ multiple: false, title: 'Private key' })
    if (typeof selected === 'string') setForm(v => ({ ...v, privateKeyPath: selected }))
  }

  const connect = async () => {
    if (!form.host || !form.username) { setErr(t('connect.hostRequired')); return }
    setBusy(true); setErr('')
    let id: string | null = null
    try {
      let password = form.password
      if (form.authMethod === 'password' && !password && connectDraft?.id && form.rememberPassword) {
        password = await getDevicePassword(connectDraft.id) ?? ''
      }
      if (form.authMethod === 'password' && !password) {
        throw new Error(form.rememberPassword ? t('connect.savedPasswordMissing') : t('connect.passwordRequired'))
      }
      if (form.authMethod === 'privateKey' && !form.privateKeyPath.trim()) {
        throw new Error(t('connect.privateKeyRequired'))
      }

      const device = await saveDevice({
        id: connectDraft?.id,
        name: form.name || form.host,
        host: form.host,
        port: +form.port || 22,
        username: form.username,
        authMethod: form.authMethod,
        privateKeyPath: form.authMethod === 'privateKey' ? form.privateKeyPath.trim() : null,
        rememberPassword: form.rememberPassword,
      })
      id = addConn({
        id: device.id,
        name: device.name,
        host: device.host,
        port: device.port,
        username: device.username,
        authMethod: device.authMethod,
        privateKeyPath: device.privateKeyPath,
        rememberPassword: device.rememberPassword,
        pinned: device.pinned,
      })
      patchConn(id, { status: 'connecting' })
      const sessionId = await sshConnect({
        host: form.host,
        port: +form.port || 22,
        username: form.username,
        authMethod: form.authMethod,
        password: form.authMethod === 'password' ? password : undefined,
        privateKeyPath: form.authMethod === 'privateKey' ? form.privateKeyPath.trim() : undefined,
        passphrase: form.authMethod === 'privateKey' ? form.passphrase : undefined,
      })
      if (form.authMethod === 'password' && form.rememberPassword) {
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
        <div style={S.hd}><span style={S.hdTitle}>{connectDraft ? t('connect.connectDevice') : t('connect.newConnection')}</span>
          <button style={S.closeBtn} onClick={() => setShowConnect(false)}>x</button></div>
        <div style={S.body}>
          {(['name','host','username'] as const).map(k => (
            <label key={k} style={S.row}>
              <span style={S.lbl}>{k === 'name' ? t('connect.name') : k === 'username' ? t('connect.username') : t('connect.host')}</span>
              <input style={S.inp} value={form[k]} onChange={f(k)}
                placeholder={k === 'name' ? t('connect.optional') : k} autoFocus={k === 'host'} />
            </label>
          ))}
          <label style={S.row}>
            <span style={S.lbl}>{t('connect.port')}</span>
            <input style={{ ...S.inp, width: 80 }} value={form.port} onChange={f('port')} />
          </label>
          <label style={S.row}>
            <span style={S.lbl}>{t('connect.auth')}</span>
            <select style={S.inp} value={form.authMethod} onChange={e => setForm(v => ({ ...v, authMethod: e.target.value as 'password' | 'privateKey' }))}>
              <option value="password">{t('connect.password')}</option>
              <option value="privateKey">{t('connect.privateKey')}</option>
            </select>
          </label>
          {form.authMethod === 'password' ? (
            <>
              <label style={S.row}>
                <span style={S.lbl}>{t('connect.password')}</span>
                <input
                  ref={passwordRef}
                  style={S.inp}
                  type="password"
                  value={form.password}
                  onChange={f('password')}
                  placeholder={hasSavedPassword ? t('connect.savedPassword') : ''}
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
                <span style={S.checkText}>{t('connect.rememberPassword')}</span>
              </label>
            </>
          ) : (
            <>
              <label style={S.row}>
                <span style={S.lbl}>{t('connect.privateKey')}</span>
                <div style={S.pathRow}>
                  <input style={S.inp} value={form.privateKeyPath} onChange={f('privateKeyPath')} />
                  <button style={S.smallBtn} type="button" onClick={() => choosePrivateKey().catch(err => setErr(String(err)))}>{t('general.browse')}</button>
                </div>
              </label>
              <label style={S.row}>
                <span style={S.lbl}>{t('connect.passphrase')}</span>
                <input
                  style={S.inp}
                  type="password"
                  value={form.passphrase}
                  onChange={f('passphrase')}
                  placeholder={t('connect.optional')}
                  onKeyDown={e => e.key==='Enter' && connect()}
                />
              </label>
            </>
          )}
          {err && <div style={S.err}>{err}</div>}
          <button style={{ ...S.btn, opacity: busy ? 0.6 : 1 }} onClick={connect} disabled={busy}>
            {busy ? t('connect.connecting') : t('connect.connect')}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:999 },
  box: { background:'var(--c1)', border:'1px solid var(--b2)', borderRadius:6, width:390, fontFamily:'var(--fm)' },
  hd: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px', borderBottom:'1px solid var(--b1)' },
  hdTitle: { fontSize:12, color:'var(--t0)', fontWeight:600, letterSpacing:'0.05em' },
  closeBtn: { background:'none', border:'none', color:'var(--t2)', cursor:'pointer', fontSize:14, padding:2 },
  body: { padding:'12px 14px', display:'flex', flexDirection:'column', gap:8 },
  row: { display:'flex', alignItems:'center', gap:8 },
  lbl: { fontSize:11, color:'var(--t2)', width:72, flexShrink:0, textAlign:'right' },
  checkRow: { display:'flex', alignItems:'center', gap:8 },
  checkText: { fontSize:11, color:'var(--t1)' },
  inp: { flex:1, background:'var(--c2)', border:'1px solid var(--b1)', borderRadius:3,
    padding:'4px 8px', fontSize:12, color:'var(--t0)', fontFamily:'var(--fm)', outline:'none' },
  pathRow: { flex:1, display:'grid', gridTemplateColumns:'1fr auto', gap:6 },
  smallBtn: { border:'1px solid var(--b1)', borderRadius:3, background:'var(--c2)', color:'var(--t0)', cursor:'pointer', fontFamily:'var(--fm)', fontSize:11, padding:'0 8px' },
  err: { fontSize:11, color:'var(--red)', marginTop:2 },
  btn: { marginTop:4, background:'var(--acc)', border:'none', borderRadius:3, padding:'6px 0',
    color:'#fff', fontSize:12, cursor:'pointer', fontFamily:'var(--fm)' },
}
