import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useI18n } from '../i18n'
import {
  downloadUpdate,
  installUpdateAndExit,
  type DownloadedUpdate,
  type UpdateInfo,
  type UpdateProgress,
} from '../lib/update'

type UpdateStatus = 'idle' | 'downloading' | 'downloaded' | 'installing' | 'error'

export function UpdateDialog({ update, onClose }: { update: UpdateInfo; onClose: () => void }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [progress, setProgress] = useState<UpdateProgress>({ phase: 'downloading', downloaded: 0, total: update.asset.size, percent: 0 })
  const [downloaded, setDownloaded] = useState<DownloadedUpdate | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setStatus('idle')
    setProgress({ phase: 'downloading', downloaded: 0, total: update.asset.size, percent: 0 })
    setDownloaded(null)
    setError('')
  }, [update.tagName])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    listen<UpdateProgress>('shelly-update-progress', event => {
      if (!disposed) setProgress(event.payload)
    }).then(fn => {
      unlisten = fn
    }).catch(err => {
      if (!disposed) setError(String(err))
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const closeWithConfirm = () => {
    if (window.confirm(t('update.closeConfirm'))) onClose()
  }

  const startDownload = async () => {
    try {
      setError('')
      setStatus('downloading')
      const result = await downloadUpdate(update.asset)
      setDownloaded(result)
      setStatus('downloaded')
    } catch (err) {
      setStatus('error')
      setError(String(err))
    }
  }

  const startInstall = async () => {
    if (!downloaded) return
    try {
      setError('')
      setStatus('installing')
      await installUpdateAndExit(downloaded.path)
    } catch (err) {
      setStatus('error')
      setError(String(err))
    }
  }

  const percent = Math.round(progress.percent || 0)
  const downloadedText = progress.total
    ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
    : formatBytes(progress.downloaded)

  return (
    <div style={s.backdrop} role="dialog" aria-modal="true">
      <div style={s.dialog}>
        <div style={s.head}>
          <div>
            <div style={s.eyebrow}>{t('update.availableTitle')}</div>
            <div style={s.title}>Shelly {update.latestVersion}</div>
          </div>
          <button style={s.iconBtn} onClick={closeWithConfirm} title={t('general.close')}>
            <i className="ti ti-x" />
          </button>
        </div>

        <div style={s.body}>
          <div style={s.versionRow}>
            <span>{t('update.currentVersion')}</span>
            <strong>{update.currentVersion}</strong>
          </div>
          <div style={s.versionRow}>
            <span>{t('update.latestVersion')}</span>
            <strong>{update.tagName}</strong>
          </div>
          <div style={s.assetBox}>
            <span>{update.asset.name}</span>
            <small>{formatBytes(update.asset.size)}</small>
          </div>
          {update.releaseNotes.trim() && (
            <div style={s.notes}>{update.releaseNotes.trim().slice(0, 1200)}</div>
          )}

          {(status === 'downloading' || status === 'downloaded' || status === 'installing') && (
            <div style={s.progressBlock}>
              <div style={s.progressMeta}>
                <span>{status === 'downloaded' ? t('update.downloaded') : t('update.downloading')}</span>
                <span>{downloadedText}</span>
              </div>
              <div style={s.progressTrack}>
                <div style={{ ...s.progressFill, width: `${status === 'downloaded' ? 100 : percent}%` }} />
              </div>
            </div>
          )}

          {status === 'installing' && <div style={s.notice}>{t('update.installingNotice')}</div>}
          {error && <div style={s.error}>{error}</div>}
        </div>

        <div style={s.actions}>
          <button style={s.secondaryBtn} onClick={closeWithConfirm}>{t('general.close')}</button>
          {status === 'idle' || status === 'error' ? (
            <button style={s.primaryBtn} onClick={() => startDownload()}>{t('update.startUpdate')}</button>
          ) : null}
          {status === 'downloaded' ? (
            <button style={s.primaryBtn} onClick={() => startInstall()}>{t('update.startInstall')}</button>
          ) : null}
          {status === 'downloading' || status === 'installing' ? (
            <button style={s.primaryBtnDisabled} disabled>{status === 'downloading' ? t('update.downloading') : t('update.startInstall')}</button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function formatBytes(value?: number | null) {
  if (!value || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

const s: Record<string, React.CSSProperties> = {
  backdrop: { position:'fixed', inset:0, zIndex:2500, background:'rgba(0,0,0,0.56)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 },
  dialog: { width:'min(460px, calc(100vw - 40px))', maxHeight:'calc(100vh - 40px)', overflow:'hidden', border:'1px solid var(--b2)', borderRadius:6, background:'var(--c0)', boxShadow:'0 24px 70px rgba(0,0,0,0.58)', display:'flex', flexDirection:'column' },
  head: { display:'flex', alignItems:'flex-start', gap:12, padding:'14px 14px 10px', borderBottom:'1px solid var(--b0)' },
  eyebrow: { color:'var(--acc)', fontSize:'var(--ui-font-sm)', textTransform:'uppercase', letterSpacing:'0.08em' },
  title: { color:'var(--t0)', fontSize:'var(--ui-font-lg)', fontWeight:700, marginTop:4 },
  iconBtn: { marginLeft:'auto', width:24, height:24, border:'none', borderRadius:3, background:'transparent', color:'var(--t2)', cursor:'pointer' },
  body: { padding:14, display:'flex', flexDirection:'column', gap:10, overflowY:'auto' },
  versionRow: { display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, color:'var(--t1)', fontSize:'var(--ui-font)' },
  assetBox: { display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, padding:'8px 10px', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:4, color:'var(--t1)', fontSize:'var(--ui-font)' },
  notes: { maxHeight:120, overflowY:'auto', whiteSpace:'pre-wrap', color:'var(--t2)', fontSize:'var(--ui-font)', lineHeight:1.55, padding:'8px 10px', background:'var(--c1)', border:'1px solid var(--b0)', borderRadius:4 },
  progressBlock: { display:'flex', flexDirection:'column', gap:7 },
  progressMeta: { display:'flex', alignItems:'center', justifyContent:'space-between', color:'var(--t1)', fontSize:'var(--ui-font-sm)' },
  progressTrack: { height:8, borderRadius:4, background:'var(--c2)', overflow:'hidden', border:'1px solid var(--b0)' },
  progressFill: { height:'100%', background:'var(--acc)', transition:'width .12s ease' },
  notice: { color:'var(--t1)', fontSize:'var(--ui-font)', lineHeight:1.5 },
  error: { color:'var(--red)', fontSize:'var(--ui-font)', lineHeight:1.5, whiteSpace:'pre-wrap' },
  actions: { display:'flex', justifyContent:'flex-end', gap:8, padding:14, borderTop:'1px solid var(--b0)' },
  secondaryBtn: { border:'1px solid var(--b1)', borderRadius:3, background:'transparent', color:'var(--t1)', height:28, padding:'0 10px', cursor:'pointer', fontSize:'var(--ui-font)' },
  primaryBtn: { border:'none', borderRadius:3, background:'var(--acc)', color:'#0b1b24', height:28, padding:'0 12px', cursor:'pointer', fontSize:'var(--ui-font)' },
  primaryBtnDisabled: { border:'none', borderRadius:3, background:'var(--c3)', color:'var(--t2)', height:28, padding:'0 12px', cursor:'default', fontSize:'var(--ui-font)' },
}
