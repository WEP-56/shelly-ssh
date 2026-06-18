import { useMemo, useState } from 'react'
import { useStore, type Connection } from '../store'
import { sshDisconnect, sshListKnownHosts, sshRemoveKnownHost, type KnownHostEntry } from '../lib/ssh'
import { deleteDevice, setDevicePinned, updateDeviceSession } from '../lib/db'
import { useI18n } from '../i18n'

const dot = (s: Connection['status']) => ({
  connected: 'var(--grn)', connecting: '#e5c07b', disconnected: 'var(--t3)', error: 'var(--red)',
}[s])

export function Sidebar() {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; device?: Connection } | null>(null)
  const [hostKeyPanel, setHostKeyPanel] = useState<{ device: Connection; entries: KnownHostEntry[]; error?: string } | null>(null)
  const [devicePanel, setDevicePanel] = useState<Connection | null>(null)
  const { conns, activeId, sidebarOpen, sidebarWidth, setActive, openConnectDialog, removeConn, patchConn, setShowSettings } = useStore(s => s)
  const selectedDevicePanel = devicePanel ? conns.find(c => c.id === devicePanel.id) ?? devicePanel : null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const source = q ? conns.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.host.toLowerCase().includes(q) ||
      c.username.toLowerCase().includes(q)
    ) : conns
    return [...source].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
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
      authMethod: c.authMethod,
      privateKeyPath: c.privateKeyPath,
      rememberPassword: c.rememberPassword,
    })
  }

  const disconnectDevice = async (c: Connection) => {
    if (c.sessionId) await sshDisconnect(c.sessionId)
    await updateDeviceSession(c.id, null).catch(() => undefined)
    patchConn(c.id, { status: 'disconnected', sessionId: undefined, deviceStats: null })
  }

  const disconnect = async (c: Connection, e: React.MouseEvent) => {
    e.stopPropagation()
    await disconnectDevice(c)
  }

  const removeDeviceRecord = async (c: Connection) => {
    if (c.sessionId) await sshDisconnect(c.sessionId).catch(() => undefined)
    await deleteDevice(c.id)
    removeConn(c.id)
  }

  const removeDevice = async (c: Connection, e: React.MouseEvent) => {
    e.stopPropagation()
    await removeDeviceRecord(c)
  }

  const editDevice = (c: Connection) => openConnectDialog({
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    authMethod: c.authMethod,
    privateKeyPath: c.privateKeyPath,
    rememberPassword: c.rememberPassword,
  })

  const openMenu = (e: React.MouseEvent, device?: Connection) => {
    e.preventDefault()
    e.stopPropagation()
    if (device) setActive(device.id)
    setMenu({ x: e.clientX, y: e.clientY, device })
  }

  const openHostKeys = async (device: Connection) => {
    const entries = await sshListKnownHosts(device.host, device.port)
    setHostKeyPanel({ device, entries })
  }

  const removeHostKey = async () => {
    if (!hostKeyPanel) return
    try {
      await sshRemoveKnownHost(hostKeyPanel.device.host, hostKeyPanel.device.port)
      const entries = await sshListKnownHosts(hostKeyPanel.device.host, hostKeyPanel.device.port)
      setHostKeyPanel({ ...hostKeyPanel, entries, error: undefined })
    } catch (err) {
      setHostKeyPanel({ ...hostKeyPanel, error: String(err) })
    }
  }

  const togglePinned = async (device: Connection) => {
    const updated = await setDevicePinned(device.id, !device.pinned)
    patchConn(device.id, { pinned: updated.pinned })
  }

  const menuItem = (icon: string, label: string, action: () => void | Promise<void>, danger = false, disabled = false) => (
    <button
      style={{ ...s.menuItem, ...(danger ? s.menuDanger : {}), ...(disabled ? s.menuDisabled : {}) }}
      disabled={disabled}
      onClick={() => {
        setMenu(null)
        Promise.resolve(action()).catch(err => console.warn('[devices] context action failed', err))
      }}
    >
      <i className={`ti ${icon}`} />
      <span>{label}</span>
    </button>
  )

  return (
    <div style={{ ...sOpen.root, width: sidebarOpen ? sidebarWidth : 0 }} onClick={() => setMenu(null)}>
      {sidebarOpen && <>
        <div style={s.search}>
          <i className="ti ti-search" style={{ color:'var(--t3)', fontSize:'var(--ui-font)' }} />
          <input style={s.searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder={t('devices.filter')} />
        </div>
        <div style={s.sec}>{t('devices.title')}</div>
        <div style={s.list} onContextMenu={e => openMenu(e)}>
          {filtered.length === 0
            ? <div style={s.hint}>{conns.length === 0 ? t('devices.empty') : t('devices.noMatch')}<br />{t('devices.addHint')}</div>
            : filtered.map(c => (
              <div key={c.id} style={{ ...s.item, ...(c.id === activeId ? s.itemOn : {}) }}
                   onClick={() => setActive(c.id)}
                   onDoubleClick={() => openDevice(c)}
                   onContextMenu={e => openMenu(e, c)}
                   title={c.status === 'connected' ? t('devices.doubleClickFocus') : t('devices.doubleClickConnect')}>
                <span style={{ ...s.cdot, background: dot(c.status) }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={s.cname}>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis' }}>{c.name}</span>
                    {c.pinned && <i className="ti ti-pin" style={s.keyIcon} />}
                    {c.rememberPassword && <i className="ti ti-key" style={s.keyIcon} />}
                  </div>
                  <div style={s.chost}>{c.username}@{c.host}</div>
                </div>
                {c.status === 'connected' ? (
                  <button style={s.itemBtn} onClick={e => disconnect(c, e)} title={t('devices.disconnect')}>
                    <i className="ti ti-player-stop" />
                  </button>
                ) : (
                  <button style={s.itemBtn} onClick={e => { e.stopPropagation(); openDevice(c) }} title={t('devices.connect')}>
                    <i className="ti ti-plug-connected" />
                  </button>
                )}
                <button style={s.itemBtn} onClick={e => removeDevice(c, e)} title={t('devices.remove')}>
                  <i className="ti ti-x" />
                </button>
              </div>
            ))
          }
        </div>
        <div style={s.foot}>
          <button style={s.iconBtn} onClick={() => openConnectDialog()} title={t('general.createNewOne')}><i className="ti ti-plus" /></button>
          <button style={s.iconBtn} onClick={() => setShowSettings(true)} title={t('settings.title')}><i className="ti ti-settings" /></button>
        </div>
        {menu && (
          <div style={{ ...s.contextMenu, left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
            {menu.device ? (
              <>
                {menu.device.status === 'connected'
                  ? menuItem('ti-player-stop', t('devices.disconnect'), () => disconnectDevice(menu.device!))
                  : menuItem('ti-plug-connected', t('devices.connect'), () => openDevice(menu.device!))}
                {menuItem('ti-info-circle', t('devices.details'), () => setDevicePanel(menu.device!))}
                {menuItem(menu.device.pinned ? 'ti-pinned-off' : 'ti-pin', menu.device.pinned ? t('devices.unpin') : t('devices.pin'), () => togglePinned(menu.device!))}
                {menuItem('ti-pencil', t('devices.edit'), () => editDevice(menu.device!))}
                {menuItem('ti-shield-lock', t('devices.hostKey'), () => openHostKeys(menu.device!))}
                <div style={s.menuSep} />
                {menuItem('ti-trash', t('devices.remove'), () => removeDeviceRecord(menu.device!), true)}
              </>
            ) : (
              <>
                {menuItem('ti-plus', t('general.createNewOne'), () => openConnectDialog())}
                {menuItem('ti-settings', t('settings.title'), () => setShowSettings(true))}
              </>
            )}
          </div>
        )}
        {hostKeyPanel && (
          <div style={s.modalOverlay} onMouseDown={() => setHostKeyPanel(null)}>
            <div style={s.modal} onMouseDown={e => e.stopPropagation()}>
              <div style={s.modalTitle}>{t('devices.hostKey')}</div>
              <div style={s.modalSub}>{hostKeyPanel.device.username}@{hostKeyPanel.device.host}:{hostKeyPanel.device.port}</div>
              {hostKeyPanel.entries.length === 0 ? (
                <div style={s.modalEmpty}>{t('devices.hostKeyEmpty')}</div>
              ) : (
                <div style={s.hostKeyList}>
                  {hostKeyPanel.entries.map(entry => (
                    <div key={entry.line} style={s.hostKeyRow}>
                      <div style={s.hostKeyTop}>{entry.algorithm} · line {entry.line}</div>
                      <div style={s.hostKeyFingerprint}>{entry.fingerprint}</div>
                      <div style={s.hostKeyPath}>{entry.knownHostsPath}</div>
                    </div>
                  ))}
                </div>
              )}
              {hostKeyPanel.error && <div style={s.err}>{hostKeyPanel.error}</div>}
              <div style={s.modalActions}>
                <button style={s.menuBtn} onClick={() => setHostKeyPanel(null)}>{t('general.close')}</button>
                <button style={s.dangerBtn} disabled={hostKeyPanel.entries.length === 0} onClick={removeHostKey}>{t('devices.hostKeyRemove')}</button>
              </div>
            </div>
          </div>
        )}
        {selectedDevicePanel && (
          <div style={s.modalOverlay} onMouseDown={() => setDevicePanel(null)}>
            <div style={s.modal} onMouseDown={e => e.stopPropagation()}>
              <div style={s.modalTitle}>{selectedDevicePanel.name}</div>
              <div style={s.detailGrid}>
                <span>{t('connect.host')}</span><strong>{selectedDevicePanel.host}</strong>
                <span>{t('connect.port')}</span><strong>{selectedDevicePanel.port}</strong>
                <span>{t('connect.username')}</span><strong>{selectedDevicePanel.username}</strong>
                <span>{t('connect.auth')}</span><strong>{selectedDevicePanel.authMethod === 'privateKey' ? t('connect.privateKey') : t('connect.password')}</strong>
                {selectedDevicePanel.privateKeyPath && <><span>{t('connect.privateKey')}</span><strong>{selectedDevicePanel.privateKeyPath}</strong></>}
                <span>{t('status.idle')}</span><strong>{selectedDevicePanel.status}</strong>
                <span>{t('devices.pin')}</span><strong>{selectedDevicePanel.pinned ? 'yes' : 'no'}</strong>
              </div>
              <DeviceStatsDetail device={selectedDevicePanel} />
              <div style={s.modalActions}>
                <button style={s.menuBtn} onClick={() => setDevicePanel(null)}>{t('general.close')}</button>
                <button style={s.menuBtn} onClick={() => { editDevice(selectedDevicePanel); setDevicePanel(null) }}>{t('devices.edit')}</button>
              </div>
            </div>
          </div>
        )}
      </>}
    </div>
  )
}

function DeviceStatsDetail({ device }: { device: Connection }) {
  const { t } = useI18n()
  const stats = device.deviceStats
  if (device.status !== 'connected') {
    return <div style={s.modalEmpty}>{t('devices.statsConnectHint')}</div>
  }
  if (!stats) {
    return <div style={s.modalEmpty}>{t('devices.statsPending')}</div>
  }
  const memUsed = usedValue(stats.memTotalKb, stats.memAvailableKb)
  const swapUsed = usedValue(stats.swapTotalKb, stats.swapFreeKb)
  const diskUsed = usedValue(stats.diskTotalKb, stats.diskAvailableKb)
  return (
    <div style={s.statsPanel}>
      <div style={s.statsHead}>
        <div>
          <div style={s.statsTitle}>{stats.hostname || device.host}</div>
          <div style={s.statsSub}>{stats.kernel || t('devices.statsUnknown')}</div>
        </div>
        <div style={s.statsUptime}>{formatUptime(stats.uptimeSeconds)}</div>
      </div>
      <div style={s.statsGrid}>
        <MetricBar label={t('devices.memory')} used={memUsed} total={stats.memTotalKb} available={stats.memAvailableKb} />
        <MetricBar label={t('devices.storage')} used={diskUsed} total={stats.diskTotalKb} available={stats.diskAvailableKb} suffix={stats.diskMount ? ` · ${stats.diskMount}` : ''} />
        {stats.swapTotalKb ? <MetricBar label="Swap" used={swapUsed} total={stats.swapTotalKb} available={stats.swapFreeKb} /> : null}
      </div>
      <div style={s.statsFacts}>
        <span>{t('devices.load')}: <strong>{stats.loadAvg || '-'}</strong></span>
        <span>{t('devices.collected')}: <strong>{formatCollected(stats.collectedAt)}</strong></span>
      </div>
    </div>
  )
}

function MetricBar({
  label,
  used,
  total,
  available,
  suffix = '',
}: {
  label: string
  used: number | null
  total?: number | null
  available?: number | null
  suffix?: string
}) {
  const percent = used == null ? null : Math.max(0, Math.min(100, Math.round(used)))
  return (
    <div style={s.metric}>
      <div style={s.metricTop}>
        <span>{label}</span>
        <strong>{percent == null ? '-' : `${percent}%`}</strong>
      </div>
      <div style={s.metricBar}>
        <span style={{ ...s.metricFill, width: `${percent ?? 0}%` }} />
      </div>
      <div style={s.metricMeta}>
        {total ? `${formatBytes((total - (available ?? 0)) * 1024)} / ${formatBytes(total * 1024)}${suffix}` : `-${suffix}`}
      </div>
    </div>
  )
}

function usedValue(total?: number | null, available?: number | null) {
  if (!total || available == null || total <= 0) return null
  return (1 - available / total) * 100
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function formatUptime(seconds?: number | null) {
  if (!seconds) return '-'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatCollected(ms?: number | null) {
  if (!ms) return '-'
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const s: Record<string, React.CSSProperties> = {
  iconBtn: { width:20, height:20, background:'none', border:'none', color:'var(--t2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:3, fontSize:'var(--ui-font-md)', padding:0 },
  search: { margin:'7px 8px', display:'flex', alignItems:'center', background:'var(--c2)', border:'1px solid var(--b1)', borderRadius:3, padding:'4px 8px' },
  searchInput: { minWidth:0, flex:1, background:'transparent', border:'none', outline:'none', color:'var(--t1)', fontSize:'var(--ui-font)', fontFamily:'var(--fm)', marginLeft:5 },
  sec: { fontSize:'var(--ui-font-sm)', color:'var(--t3)', letterSpacing:'0.08em', textTransform:'uppercase', padding:'7px 10px 3px' },
  list: { flex:1, overflowY:'auto', padding:'0 4px' },
  hint: { fontSize:'var(--ui-font)', color:'var(--t3)', padding:'20px 10px', textAlign:'center', lineHeight:1.7 },
  item: { display:'flex', alignItems:'center', gap:7, padding:'5px 7px', borderRadius:3, cursor:'pointer' },
  itemOn: { background:'var(--c3)' },
  cdot: { width:6, height:6, borderRadius:'50%', flexShrink:0 },
  cname: { fontSize:'var(--ui-font)', color:'var(--t0)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'flex', alignItems:'center', gap:5 },
  keyIcon: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', flexShrink:0 },
  chost: { fontSize:'var(--ui-font-sm)', color:'var(--t2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontFamily:'var(--fm)' },
  itemBtn: { background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:'var(--ui-font-sm)', padding:2, borderRadius:2, display:'flex', alignItems:'center' },
  foot: { padding:'5px 4px', borderTop:'1px solid rgba(255,255,255,0.05)', display:'flex', gap:1 },
  contextMenu: { position:'fixed', zIndex:2200, minWidth:154, padding:'4px 0', border:'1px solid var(--b2)', borderRadius:4, background:'var(--c1)', boxShadow:'0 8px 24px rgba(0,0,0,0.35)' },
  menuItem: { width:'100%', height:25, display:'flex', alignItems:'center', gap:8, border:'none', background:'transparent', color:'var(--t0)', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font)', padding:'0 10px', textAlign:'left' },
  menuDanger: { color:'#f48771' },
  menuDisabled: { opacity:0.45, cursor:'default' },
  menuSep: { height:1, background:'rgba(255,255,255,0.08)', margin:'4px 0' },
  modalOverlay: { position:'fixed', inset:0, zIndex:2300, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.36)', padding:16 },
  modal: { width:'min(520px, 100%)', border:'1px solid var(--b2)', borderRadius:6, background:'var(--c1)', boxShadow:'0 18px 50px rgba(0,0,0,0.45)', padding:12, display:'flex', flexDirection:'column', gap:9 },
  modalTitle: { color:'var(--t0)', fontSize:'var(--ui-font-md)', fontWeight:700 },
  modalSub: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', fontFamily:'var(--fm)' },
  modalEmpty: { color:'var(--t2)', fontSize:'var(--ui-font)', padding:'12px 0' },
  hostKeyList: { maxHeight:240, overflowY:'auto', display:'flex', flexDirection:'column', gap:6 },
  hostKeyRow: { border:'1px solid var(--b0)', borderRadius:4, background:'var(--c0)', padding:8, display:'flex', flexDirection:'column', gap:4 },
  hostKeyTop: { color:'var(--t1)', fontSize:'var(--ui-font-sm)' },
  hostKeyFingerprint: { color:'var(--t0)', fontSize:'var(--ui-font)', fontFamily:'var(--fm)', overflowWrap:'anywhere' },
  hostKeyPath: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  detailGrid: { display:'grid', gridTemplateColumns:'90px 1fr', gap:'7px 10px', color:'var(--t2)', fontSize:'var(--ui-font-sm)' },
  statsPanel: { border:'1px solid var(--b0)', borderRadius:5, background:'var(--c0)', padding:10, display:'flex', flexDirection:'column', gap:10 },
  statsHead: { display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 },
  statsTitle: { color:'var(--t0)', fontSize:'var(--ui-font-md)', fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  statsSub: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', fontFamily:'var(--fm)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:390 },
  statsUptime: { color:'var(--acc)', fontSize:'var(--ui-font-sm)', fontFamily:'var(--fm)', flexShrink:0 },
  statsGrid: { display:'grid', gridTemplateColumns:'1fr', gap:8 },
  metric: { display:'flex', flexDirection:'column', gap:4 },
  metricTop: { display:'flex', alignItems:'center', justifyContent:'space-between', color:'var(--t1)', fontSize:'var(--ui-font-sm)' },
  metricBar: { height:7, borderRadius:3, background:'var(--c2)', overflow:'hidden', border:'1px solid var(--b0)' },
  metricFill: { display:'block', height:'100%', background:'var(--acc)' },
  metricMeta: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', fontFamily:'var(--fm)' },
  statsFacts: { display:'flex', flexWrap:'wrap', gap:'6px 14px', color:'var(--t2)', fontSize:'var(--ui-font-sm)' },
  modalActions: { display:'flex', justifyContent:'flex-end', gap:7 },
  menuBtn: { height:24, border:'1px solid var(--b1)', borderRadius:3, background:'var(--c1)', color:'var(--t0)', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)', padding:'0 8px' },
  dangerBtn: { height:24, border:'1px solid rgba(244,71,71,0.22)', borderRadius:3, background:'rgba(244,71,71,0.08)', color:'#f48771', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)', padding:'0 8px' },
  err: { color:'var(--red)', fontSize:'var(--ui-font-sm)' },
}
const sOpen = {
  root: { flexShrink:0, background:'var(--c0)', borderRight:'1px solid var(--b1)', display:'flex', flexDirection:'column' as const, overflow:'hidden', transition:'width 0.15s' },
}
