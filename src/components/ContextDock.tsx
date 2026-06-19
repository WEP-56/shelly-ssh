import { useEffect, useMemo, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { downloadDir, join } from '@tauri-apps/api/path'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useStore, type Connection, type RightDockTab } from '../store'
import { useI18n, type I18nKey } from '../i18n'
import {
  cancelFileJob,
  listFileJobs,
  onFileJobUpdated,
  queueCreateFile,
  queueDelete,
  queueDownload,
  queueListDir,
  queueMkdir,
  queuePreview,
  queueRename,
  queueUpload,
  type FileJob,
  type RemoteFileEntry,
  type UploadConflictPolicy,
} from '../lib/files'
import { clearCommandHistory as clearCommandHistoryDb, deleteCommandHistory, deleteSnippet, saveSnippet } from '../lib/db'
import { sendCommandToActiveTerminal } from '../lib/commands'

type PreviewState = { path: string; content: string }
type CreateDraft = { kind: 'file' | 'folder'; parentPath: string; name: string }
type RenameDraft = { path: string; name: string }
type FileContextMenu = { x: number; y: number; entry?: RemoteFileEntry }
type DroppedFile = File & { path?: string }
type DropTarget = { path: string; label: string; rowPath: string }
type DownloadConfirm = { entry: RemoteFileEntry; localPath: string }
type UploadConfirm = { localPath: string; remotePath: string; conflictPolicy: UploadConflictPolicy }
type MultiUploadConfirm = { localPaths: string[]; parentPath: string; conflictPolicy: UploadConflictPolicy }
type DeleteConfirm = { entry: RemoteFileEntry }
type RemoteDragPayload = { path: string; name: string; isDir: boolean }
type PointerRemoteDrag = {
  payload: RemoteDragPayload
  entry: RemoteFileEntry
  startX: number
  startY: number
  currentX: number
  currentY: number
  dragging: boolean
  downloadStarted: boolean
}

const REMOTE_DRAG_MIME = 'application/x-shelly-remote-entry'

export function ContextDock({ active }: { active: Connection | undefined }) {
  const { t } = useI18n()
  const { rightTab, setRightTab, rightDockWidth, setRightDockWidth } = useStore(s => s)
  const [mountedTabs, setMountedTabs] = useState<Record<RightDockTab, boolean>>(() => ({
    files: rightTab === 'files',
    history: rightTab === 'history',
    snippets: rightTab === 'snippets',
  }))
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    setMountedTabs(prev => prev[rightTab] ? prev : { ...prev, [rightTab]: true })
  }, [rightTab])

  const onResizeDown = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startW: rightDockWidth }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      setRightDockWidth(dragRef.current.startW + dragRef.current.startX - ev.clientX)
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    e.preventDefault()
  }

  return (
    <div style={s.root}>
      <div className="resize-handle resize-handle-left" style={s.resizeHandle} onMouseDown={onResizeDown} />
      <div style={s.tabs}>
        {(['files', 'history', 'snippets'] as RightDockTab[]).map(tab => (
          <button
            key={tab}
            style={{ ...s.tab, ...(rightTab === tab ? s.tabOn : {}) }}
            onClick={() => setRightTab(tab)}
          >
            {t(dockTabKey(tab))}
          </button>
        ))}
      </div>
      <div style={s.body}>
        {mountedTabs.files && (
          <div style={{ ...s.view, display: rightTab === 'files' ? 'block' : 'none' }}>
            <FilesPanel active={active} />
          </div>
        )}
        {mountedTabs.history && (
          <div style={{ ...s.view, display: rightTab === 'history' ? 'block' : 'none' }}>
            <HistoryPanel width={rightDockWidth} />
          </div>
        )}
        {mountedTabs.snippets && (
          <div style={{ ...s.view, display: rightTab === 'snippets' ? 'block' : 'none' }}>
            <SnippetsPanel width={rightDockWidth} />
          </div>
        )}
      </div>
    </div>
  )
}

function FilesPanel({ active }: { active: Connection | undefined }) {
  const { t } = useI18n()
  const { rightDockWidth, defaultDownloadDir } = useStore(s => s)
  const [rootByDevice, setRootByDevice] = useState<Record<string, string>>(() => readJsonPref('shelly:fileRoots', {}))
  const [expandedByDevice, setExpandedByDevice] = useState<Record<string, string[]>>(() => readJsonPref('shelly:fileExpanded', {}))
  const [selectedByDevice, setSelectedByDevice] = useState<Record<string, string | null>>(() => readJsonPref('shelly:fileSelected', {}))
  const [previewByDevice, setPreviewByDevice] = useState<Record<string, PreviewState | null>>({})
  const [jobs, setJobs] = useState<FileJob[]>([])
  const [dirCache, setDirCache] = useState<Record<string, RemoteFileEntry[]>>({})
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null)
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null)
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [downloadConfirm, setDownloadConfirm] = useState<DownloadConfirm | null>(null)
  const [uploadConfirm, setUploadConfirm] = useState<UploadConfirm | null>(null)
  const [multiUploadConfirm, setMultiUploadConfirm] = useState<MultiUploadConfirm | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null)
  const [pointerDrag, setPointerDrag] = useState<PointerRemoteDrag | null>(null)
  const [err, setErr] = useState('')
  const fileListRef = useRef<HTMLDivElement>(null)
  const remoteDragRef = useRef<RemoteDragPayload | null>(null)
  const remoteDropHandledRef = useRef(false)
  const pointerDragRef = useRef<PointerRemoteDrag | null>(null)
  const suppressClickRef = useRef(false)

  const deviceId = active?.id ?? ''
  const connected = active?.status === 'connected' && !!active.sessionId
  const canLoad = !!active && connected
  const rootPath = rootByDevice[deviceId] ?? '.'
  const expanded = useMemo(() => new Set(expandedByDevice[deviceId] ?? []), [expandedByDevice, deviceId])
  const selectedPath = selectedByDevice[deviceId] ?? null
  const preview = previewByDevice[deviceId] ?? null
  const rootEntries = deviceId ? dirCache[cacheKey(deviceId, rootPath)] ?? [] : []
  const selectedEntry = useMemo(() => {
    if (!deviceId || !selectedPath) return undefined
    return findEntryInCache(dirCache, deviceId, selectedPath)
  }, [dirCache, deviceId, selectedPath])
  const runningJob = useMemo(() => jobs.find(job => job.status === 'queued' || job.status === 'running'), [jobs])
  const latestJob = jobs[0]
  const retryableUploadJob = useMemo(() => {
    return jobs.find(job => job.kind === 'upload' && job.status === 'failed' && (job.failedEntries?.length ?? 0) > 0)
  }, [jobs])
  const activePreviewJob = useMemo(() => {
    return jobs.find(job => job.kind === 'preview' && job.path === selectedPath && (job.status === 'queued' || job.status === 'running'))
  }, [jobs, selectedPath])

  useEffect(() => {
    if (!active?.id) {
      setJobs([])
      return
    }
    listFileJobs(active?.id).then(setJobs).catch(err => console.warn('[files] list jobs failed', err))
  }, [active?.id])

  useEffect(() => {
    setErr('')
  }, [active?.id])

  useEffect(() => {
    writeJsonPref('shelly:fileRoots', rootByDevice)
  }, [rootByDevice])

  useEffect(() => {
    writeJsonPref('shelly:fileExpanded', expandedByDevice)
  }, [expandedByDevice])

  useEffect(() => {
    writeJsonPref('shelly:fileSelected', selectedByDevice)
  }, [selectedByDevice])

  useEffect(() => {
    if (!active?.id) return
    let unlisten: (() => void) | undefined
    onFileJobUpdated(job => {
      if (active?.id && job.deviceId !== active.id) return
      setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)].slice(0, 20))
      if (job.kind === 'listDir' && job.status === 'succeeded' && job.entries) {
        setDirCache(prev => ({ ...prev, [cacheKey(job.deviceId, job.path)]: job.entries ?? [] }))
      }
      if (job.kind === 'preview' && job.status === 'succeeded' && job.content != null) {
        setPreviewByDevice(prev => ({ ...prev, [job.deviceId]: { path: job.path, content: job.content ?? '' } }))
      }
      if (
        (job.kind === 'listDir' || job.kind === 'download' || job.kind === 'upload' || job.kind === 'preview' ||
          job.kind === 'delete' || job.kind === 'rename' || job.kind === 'mkdir' || job.kind === 'createFile') &&
        job.status === 'failed'
      ) {
        setErr(job.message ?? 'File job failed')
      }
      if ((job.kind === 'upload' || job.kind === 'delete' || job.kind === 'rename' || job.kind === 'mkdir' || job.kind === 'createFile') && job.status === 'succeeded') {
        loadDir(parentPath(job.path), true).catch(err => setErr(err?.toString() ?? 'Refresh failed'))
      }
      if (job.kind === 'delete' && job.status === 'succeeded') {
        setSelectedByDevice(prev => prev[job.deviceId] === job.path ? { ...prev, [job.deviceId]: null } : prev)
        setPreviewByDevice(prev => prev[job.deviceId]?.path === job.path ? { ...prev, [job.deviceId]: null } : prev)
      }
    }).then(fn => { unlisten = fn })
    return () => unlisten?.()
  }, [active?.id, active?.sessionId])

  const setRootPath = (path: string) => {
    if (!deviceId) return
    setRootByDevice(prev => ({ ...prev, [deviceId]: path }))
  }

  const setSelectedPath = (path: string | null) => {
    if (!deviceId) return
    setSelectedByDevice(prev => ({ ...prev, [deviceId]: path }))
  }

  const loadDir = async (path: string, force = false) => {
    if (!active) return
    setErr('')
    const normalized = normalizeRemotePath(path)
    if (!force && dirCache[cacheKey(active.id, normalized)]) return
    const job = await queueListDir(active.id, active.sessionId ?? null, normalized)
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
  }

  const toggleDir = (entry: RemoteFileEntry) => {
    if (!deviceId) return
    setSelectedPath(entry.path)
    const isOpen = expanded.has(entry.path)
    setExpandedByDevice(prev => {
      const current = new Set(prev[deviceId] ?? [])
      if (isOpen) current.delete(entry.path)
      else current.add(entry.path)
      return { ...prev, [deviceId]: [...current] }
    })
    if (!isOpen) {
      loadDir(entry.path).catch(err => setErr(err?.toString() ?? 'Refresh failed'))
    }
  }

  const previewFile = async (entry = selectedEntry) => {
    if (!active || !entry || entry.isDir) return
    setErr('')
    const job = await queuePreview(active.id, active.sessionId ?? null, entry.path)
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
  }

  const downloadFile = async () => {
    if (!active || !selectedEntry || selectedEntry.isDir) return
    await downloadFileFor(selectedEntry)
  }

  const downloadFileFor = async (entry: RemoteFileEntry) => {
    if (!active) return
    const base = defaultDownloadDir || await downloadDir()
    setDownloadConfirm({ entry, localPath: await join(base, entry.name) })
  }

  const submitDownload = async () => {
    if (!active || !downloadConfirm?.localPath.trim()) return
    setErr('')
    const job = await queueDownload(active.id, active.sessionId ?? null, downloadConfirm.entry.path, downloadConfirm.localPath.trim())
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
    setDownloadConfirm(null)
  }

  const chooseDownloadTarget = async () => {
    if (!downloadConfirm) return
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('dock.download'),
      defaultPath: defaultDownloadDir || undefined,
    })
    if (typeof selected === 'string') {
      setDownloadConfirm(prev => prev ? { ...prev, localPath: joinLocalPath(selected, prev.entry.name) } : prev)
    }
  }

  const uploadFile = async (parentPath = targetParentPath(selectedEntry, rootPath), localPathArg?: string) => {
    if (!active) return
    const selected = localPathArg ?? await open({ multiple: false, title: t('dock.upload') })
    const localPath = Array.isArray(selected) ? selected[0] : selected
    if (!localPath?.trim()) return
    setUploadConfirm({ localPath, remotePath: defaultUploadPath(localPath, parentPath), conflictPolicy: 'overwrite' })
  }

  const submitUpload = async () => {
    if (!active || !uploadConfirm?.localPath.trim() || !uploadConfirm.remotePath.trim()) return
    setErr('')
    const job = await queueUpload(active.id, active.sessionId ?? null, uploadConfirm.localPath.trim(), normalizeRemotePath(uploadConfirm.remotePath.trim()), uploadConfirm.conflictPolicy)
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
    setUploadConfirm(null)
  }

  const chooseUploadFile = async () => {
    const selected = await open({ multiple: false, title: t('dock.upload') })
    if (typeof selected === 'string') {
      setUploadConfirm(prev => prev
        ? { ...prev, localPath: selected, remotePath: defaultUploadPath(selected, parentPath(prev.remotePath)) }
        : { localPath: selected, remotePath: defaultUploadPath(selected, targetParentPath(selectedEntry, rootPath)), conflictPolicy: 'overwrite' })
    }
  }

  const uploadFiles = async (files: DroppedFile[], parentPath = targetParentPath(selectedEntry, rootPath)) => {
    if (!active || files.length === 0) return
    await uploadLocalPaths(files.map(file => file.path).filter(Boolean) as string[], parentPath)
  }

  const uploadLocalPaths = async (localPaths: string[], parentPath = targetParentPath(selectedEntry, rootPath)) => {
    const paths = localPaths.filter(Boolean)
    if (!active || paths.length === 0) return
    if (paths.length === 1) {
      setUploadConfirm({ localPath: paths[0], remotePath: defaultUploadPath(paths[0], parentPath), conflictPolicy: 'overwrite' })
      return
    }
    setMultiUploadConfirm({ localPaths: paths, parentPath, conflictPolicy: 'overwrite' })
  }

  const submitMultiUpload = async () => {
    if (!active || !multiUploadConfirm) return
    setErr('')
    for (const localPath of multiUploadConfirm.localPaths) {
      const remotePath = joinRemotePath(multiUploadConfirm.parentPath, fileNameFromPath(localPath))
      const job = await queueUpload(active.id, active.sessionId ?? null, localPath, remotePath, multiUploadConfirm.conflictPolicy)
      setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
    }
    setMultiUploadConfirm(null)
  }

  const cancelRunningJob = async () => {
    if (!runningJob) return
    try {
      const job = await cancelFileJob(runningJob.id)
      setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
    } catch (err: any) {
      setErr(err?.toString() ?? 'Cancel failed')
    }
  }

  const retryFailedUpload = async (job: FileJob) => {
    if (!active || !job.failedEntries?.length) return
    setErr('')
    for (const failure of job.failedEntries) {
      const retryJob = await queueUpload(active.id, active.sessionId ?? null, failure.localPath, failure.remotePath, 'overwrite')
      setJobs(prev => [retryJob, ...prev.filter(item => item.id !== retryJob.id)])
    }
  }

  const submitCreate = async () => {
    if (!active || !createDraft?.name.trim()) return
    setErr('')
    const remotePath = joinRemotePath(createDraft.parentPath, createDraft.name.trim())
    const job = createDraft.kind === 'folder'
      ? await queueMkdir(active.id, active.sessionId ?? null, remotePath)
      : await queueCreateFile(active.id, active.sessionId ?? null, remotePath)
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
    setCreateDraft(null)
  }

  const submitRename = async () => {
    if (!active || !renameDraft?.name.trim()) return
    const entry = findEntryInCache(dirCache, active.id, renameDraft.path)
    if (!entry || entry.name === renameDraft.name.trim()) {
      setRenameDraft(null)
      return
    }
    setErr('')
    const targetPath = joinRemotePath(parentPath(entry.path), renameDraft.name.trim())
    const job = await queueRename(active.id, active.sessionId ?? null, entry.path, targetPath)
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
    setRenameDraft(null)
  }

  const moveEntry = async (entry: RemoteDragPayload, targetDir: string) => {
    if (!active) return
    const fromParent = parentPath(entry.path)
    const normalizedTarget = normalizeRemotePath(targetDir)
    if (!canMoveRemotePayload(entry, normalizedTarget)) return
    const targetPath = joinRemotePath(normalizedTarget, entry.name)
    setErr('')
    const job = await queueRename(active.id, active.sessionId ?? null, entry.path, targetPath)
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
    setSelectedPath(targetPath)
    loadDir(fromParent, true).catch(err => setErr(err?.toString() ?? 'Refresh failed'))
    loadDir(normalizedTarget, true).catch(err => setErr(err?.toString() ?? 'Refresh failed'))
  }

  const deleteEntry = async (entry = selectedEntry) => {
    if (!active || !entry) return
    setDeleteConfirm({ entry })
  }

  const submitDelete = async () => {
    if (!active || !deleteConfirm) return
    setErr('')
    const job = await queueDelete(active.id, active.sessionId ?? null, deleteConfirm.entry.path, deleteConfirm.entry.isDir)
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
    setDeleteConfirm(null)
  }

  const startCreate = (kind: CreateDraft['kind'], parentPath = targetParentPath(selectedEntry, rootPath)) => {
    if (!deviceId) return
    if (parentPath !== rootPath) {
      setExpandedByDevice(prev => {
        const current = new Set(prev[deviceId] ?? [])
        current.add(parentPath)
        return { ...prev, [deviceId]: [...current] }
      })
      loadDir(parentPath).catch(err => setErr(err?.toString() ?? 'Refresh failed'))
    }
    setContextMenu(null)
    setCreateDraft({ kind, parentPath, name: kind === 'folder' ? 'new-folder' : 'new-file' })
  }

  const openContextMenu = (e: React.MouseEvent, entry?: RemoteFileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    if (entry) setSelectedPath(entry.path)
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const startPointerDrag = (entry: RemoteFileEntry, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const payload = { path: entry.path, name: entry.name, isDir: entry.isDir }
    const drag = {
      payload,
      entry,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      dragging: false,
      downloadStarted: false,
    }
    pointerDragRef.current = drag
    setPointerDrag(drag)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const resolveDropTarget = (x: number, y: number): DropTarget | null => {
    const list = fileListRef.current
    if (!list) return null
    const cssX = x / window.devicePixelRatio
    const cssY = y / window.devicePixelRatio
    const rect = list.getBoundingClientRect()
    if (cssX < rect.left || cssX > rect.right || cssY < rect.top || cssY > rect.bottom) return null
    const el = document.elementFromPoint(cssX, cssY)?.closest<HTMLElement>('[data-remote-drop-target]')
    const path = el?.dataset.remoteDropTarget || rootPath
    const label = el?.dataset.remoteDropLabel || fileNameFromPath(rootPath) || rootPath
    const rowPath = el?.dataset.remoteDropRow || rootPath
    return { path, label, rowPath }
  }

  const resolveDomDropTarget = (x: number, y: number): DropTarget | null => {
    const list = fileListRef.current
    if (!list) return null
    const rect = list.getBoundingClientRect()
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-remote-drop-target]')
    const path = el?.dataset.remoteDropTarget || rootPath
    const label = el?.dataset.remoteDropLabel || fileNameFromPath(rootPath) || rootPath
    const rowPath = el?.dataset.remoteDropRow || rootPath
    return { path, label, rowPath }
  }

  const clearPointerDrag = () => {
    pointerDragRef.current = null
    setPointerDrag(null)
    setDropTarget(null)
  }

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const current = pointerDragRef.current
      if (!current) return
      const distance = Math.hypot(e.clientX - current.startX, e.clientY - current.startY)
      const dragging = current.dragging || distance > 4
      const next = { ...current, currentX: e.clientX, currentY: e.clientY, dragging }
      pointerDragRef.current = next
      setPointerDrag(next)
      if (!dragging) return
      suppressClickRef.current = true
      const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight
      if (outside) {
        if (!next.downloadStarted) {
          const downloaded = { ...next, downloadStarted: true }
          pointerDragRef.current = downloaded
          setPointerDrag(downloaded)
          setDropTarget(null)
          downloadFileFor(downloaded.entry).catch(err => setErr(err?.toString() ?? 'Download failed'))
        }
        return
      }
      const target = resolveDomDropTarget(e.clientX, e.clientY)
      setDropTarget(target && canMoveRemotePayload(next.payload, target.path) ? target : null)
    }

    const onPointerUp = (e: PointerEvent) => {
      const current = pointerDragRef.current
      if (!current) return
      const target = current.dragging ? resolveDomDropTarget(e.clientX, e.clientY) : null
      if (target && canMoveRemotePayload(current.payload, target.path)) {
        moveEntry(current.payload, target.path).catch(err => setErr(err?.toString() ?? 'Move failed'))
      }
      clearPointerDrag()
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }

    const onPointerCancel = () => {
      clearPointerDrag()
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
    }
  }, [active?.id, active?.sessionId, rootPath])

  useEffect(() => {
    if (!active || !canLoad || dirCache[cacheKey(active.id, rootPath)]) return
    queueListDir(active.id, active.sessionId ?? null, rootPath)
      .then(job => setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)]))
      .catch(err => setErr(err?.toString() ?? 'Refresh failed'))
  }, [active?.id, active?.sessionId, canLoad, rootPath])

  useEffect(() => {
    if (!canLoad) return
    let unlisten: (() => void) | undefined
    let disposed = false
    getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload
      if (payload.type === 'leave') {
        setDropTarget(null)
        return
      }
      const target = resolveDropTarget(payload.position.x, payload.position.y)
      if (payload.type === 'enter' || payload.type === 'over') {
        setDropTarget(target)
        return
      }
      if (payload.type === 'drop') {
        setDropTarget(null)
        if (!target) return
        uploadLocalPaths(payload.paths, target.path).catch(err => setErr(err?.toString() ?? 'Upload failed'))
      }
    }).then(fn => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
      setDropTarget(null)
    }
  }, [canLoad, rootPath, active?.id, active?.sessionId, selectedPath])

  return (
    <div style={s.fileWorkspace} onClick={() => setContextMenu(null)}>
      <div style={{ ...s.fileExplorer, width: rightDockWidth }} title={latestJob ? `${latestJob.kind}: ${latestJob.status} - ${latestJob.message ?? latestJob.path}` : undefined}>
        {runningJob && (
          <div style={s.jobBar}>
            <div style={s.topProgress}>
              <span style={{ ...s.topProgressFill, width: `${Math.max(8, runningJob.progress)}%` }} />
            </div>
            <span style={s.jobText}>{jobLabel(runningJob)}</span>
            <button style={s.jobCancel} onClick={cancelRunningJob} title="Cancel transfer">
              <i className="ti ti-x" />
            </button>
          </div>
        )}
        {!runningJob && retryableUploadJob && (
          <div style={s.jobBar} title={retryableUploadJob.message ?? undefined}>
            <span style={s.jobText}>
              {t('dock.failedEntries')}: {retryableUploadJob.failedEntries?.length ?? 0}
            </span>
            <button
              style={s.jobCancel}
              onClick={() => retryFailedUpload(retryableUploadJob).catch(err => setErr(err?.toString() ?? 'Retry failed'))}
              title={t('dock.retryFailed')}
            >
              <i className="ti ti-refresh" />
            </button>
          </div>
        )}

        <div style={s.fileHeader}>
          <div style={s.explorerTitle}>{t('dock.remote')}</div>
          <input
            style={s.pathInput}
            value={rootPath}
            onChange={e => setRootPath(e.target.value)}
            disabled={!canLoad}
            onKeyDown={e => e.key === 'Enter' && loadDir(rootPath, true).catch(err => setErr(err?.toString() ?? 'Refresh failed'))}
          />
          <button style={s.iconBtn} disabled={!canLoad} onClick={() => loadDir(rootPath, true).catch(err => setErr(err?.toString() ?? 'Refresh failed'))} title={t('dock.refresh')}>
            <i className="ti ti-refresh" />
          </button>
          <button style={s.iconBtn} disabled={!canLoad} onClick={() => startCreate('file', targetParentPath(selectedEntry, rootPath))} title={t('dock.newFile')}>
            <i className="ti ti-file-plus" />
          </button>
          <button style={s.iconBtn} disabled={!canLoad} onClick={() => startCreate('folder', targetParentPath(selectedEntry, rootPath))} title={t('dock.newFolder')}>
            <i className="ti ti-folder-plus" />
          </button>
          <button style={s.iconBtn} disabled={!canLoad} onClick={() => setExpandedByDevice(prev => ({ ...prev, [deviceId]: [] }))} title={t('dock.collapseAll')}>
            <i className="ti ti-fold-down" />
          </button>
        </div>

        {!active && <Empty text={t('dock.selectConnection')} />}
        {active && !canLoad && <Empty text={t('dock.connectToLoad')} />}
        {canLoad && rootEntries.length === 0 && !runningJob && <Empty text={t('dock.refreshToLoad')} />}
        {err && <div style={s.err}>{err}</div>}

        {(rootEntries.length > 0 || !!createDraft) && (
          <div
            ref={fileListRef}
            data-remote-drop-target={rootPath}
            data-remote-drop-label={rootPath}
            data-remote-drop-row={rootPath}
            style={{ ...s.fileList, ...(dropTarget?.rowPath === rootPath ? s.fileListDrop : {}) }}
            onClick={e => {
              if (e.target !== e.currentTarget) return
              setSelectedPath(null)
              setPreviewByDevice(prev => ({ ...prev, [deviceId]: null }))
            }}
            onContextMenu={e => openContextMenu(e)}
            onDragOver={e => {
              if (!canLoad) return
              e.preventDefault()
              const remotePayload = remoteDragRef.current ?? readRemoteDragPayload(e.dataTransfer)
              e.dataTransfer.dropEffect = remotePayload && canMoveRemotePayload(remotePayload, rootPath) ? 'move' : 'copy'
              if (remotePayload) setDropTarget({ path: rootPath, label: rootPath, rowPath: rootPath })
            }}
            onDrop={e => {
              if (!canLoad) return
              e.preventDefault()
              const remotePayload = remoteDragRef.current ?? readRemoteDragPayload(e.dataTransfer)
              if (remotePayload) {
                remoteDropHandledRef.current = true
                moveEntry(remotePayload, rootPath).catch(err => setErr(err?.toString() ?? 'Move failed'))
                setDropTarget(null)
                return
              }
              uploadFiles(Array.from(e.dataTransfer.files) as DroppedFile[], dropTarget?.path ?? rootPath)
                .catch(err => setErr(err?.toString() ?? 'Upload failed'))
            }}
          >
            {dropTarget && <div style={s.dropHint}>Upload to {dropTarget.label}</div>}
            {createDraft?.parentPath === rootPath && (
              <CreateRow draft={createDraft} setDraft={setCreateDraft} onSubmit={submitCreate} onCancel={() => setCreateDraft(null)} depth={0} />
            )}
            {renderTree(rootEntries, 0, {
              deviceId,
              dirCache,
              expanded,
              selectedPath,
              createDraft,
              renameDraft,
              setSelectedPath,
              toggleDir,
              openContextMenu,
              previewFile: entry => previewFile(entry).catch(err => setErr(err?.toString() ?? 'Preview failed')),
              setRenameDraft,
              setCreateDraft,
              submitCreate,
              submitRename,
              uploadFiles,
              moveEntry,
              startDownload: entry => downloadFileFor(entry).catch(err => setErr(err?.toString() ?? 'Download failed')),
              startPointerDrag,
              shouldSuppressClick: () => suppressClickRef.current,
              setRemoteDrag: payload => {
                remoteDragRef.current = payload
                remoteDropHandledRef.current = false
              },
              getRemoteDrag: () => remoteDragRef.current,
              clearRemoteDrag: () => {
                remoteDragRef.current = null
                remoteDropHandledRef.current = false
                setDropTarget(null)
              },
              markRemoteDropHandled: () => {
                remoteDropHandledRef.current = true
              },
              isRemoteDropHandled: () => remoteDropHandledRef.current,
              setDropTarget,
              dropTargetRow: dropTarget?.rowPath ?? null,
            })}
          </div>
        )}

        {pointerDrag?.dragging && (
          <div style={{ ...s.pointerDragGhost, left: pointerDrag.currentX + 10, top: pointerDrag.currentY + 8 }}>
            <i className={`ti ${pointerDrag.entry.isDir ? 'ti-folder' : fileIcon(pointerDrag.entry.name)}`} />
            <span>{pointerDrag.entry.name}</span>
          </div>
        )}

        {contextMenu && (
          <FileMenu
            menu={contextMenu}
            rootPath={rootPath}
            onClose={() => setContextMenu(null)}
            onNewFile={parent => startCreate('file', parent)}
            onNewFolder={parent => startCreate('folder', parent)}
            onUpload={parent => uploadFile(parent).catch(err => setErr(err?.toString() ?? 'Upload failed'))}
            onPreview={entry => previewFile(entry).catch(err => setErr(err?.toString() ?? 'Preview failed'))}
            onDownload={entry => {
              setSelectedPath(entry.path)
              downloadFileFor(entry).catch(err => setErr(err?.toString() ?? 'Download failed'))
            }}
            onRename={entry => setRenameDraft({ path: entry.path, name: entry.name })}
            onDelete={entry => deleteEntry(entry).catch(err => setErr(err?.toString() ?? 'Delete failed'))}
          />
        )}

        {downloadConfirm && (
          <FileTransferDialog
            title={t('dock.download')}
            primaryLabel={t('dock.download')}
            sourceLabel={downloadConfirm.entry.path}
            pathLabel="Local path"
            pathValue={downloadConfirm.localPath}
            onPathChange={localPath => setDownloadConfirm(prev => prev ? { ...prev, localPath } : prev)}
            onBrowse={() => chooseDownloadTarget().catch(err => setErr(err?.toString() ?? 'Choose folder failed'))}
            onCancel={() => setDownloadConfirm(null)}
            onSubmit={() => submitDownload().catch(err => setErr(err?.toString() ?? 'Download failed'))}
          />
        )}

        {uploadConfirm && (
          <FileTransferDialog
            title={t('dock.upload')}
            primaryLabel={t('dock.upload')}
            sourceLabel={uploadConfirm.localPath}
            pathLabel="Remote path"
            pathValue={uploadConfirm.remotePath}
            onPathChange={remotePath => setUploadConfirm(prev => prev ? { ...prev, remotePath } : prev)}
            onBrowse={() => chooseUploadFile().catch(err => setErr(err?.toString() ?? 'Choose file failed'))}
            conflictPolicy={uploadConfirm.conflictPolicy}
            onConflictPolicyChange={conflictPolicy => setUploadConfirm(prev => prev ? { ...prev, conflictPolicy } : prev)}
            onCancel={() => setUploadConfirm(null)}
            onSubmit={() => submitUpload().catch(err => setErr(err?.toString() ?? 'Upload failed'))}
          />
        )}

        {multiUploadConfirm && (
          <ConfirmDialog
            title={t('dock.upload')}
            message={`Upload ${multiUploadConfirm.localPaths.length} files to ${multiUploadConfirm.parentPath}?`}
            primaryLabel={t('dock.upload')}
            conflictPolicy={multiUploadConfirm.conflictPolicy}
            onConflictPolicyChange={conflictPolicy => setMultiUploadConfirm(prev => prev ? { ...prev, conflictPolicy } : prev)}
            onCancel={() => setMultiUploadConfirm(null)}
            onSubmit={() => submitMultiUpload().catch(err => setErr(err?.toString() ?? 'Upload failed'))}
          />
        )}

        {deleteConfirm && (
          <ConfirmDialog
            title={t('dock.deleteConfirmTitle')}
            message={[
              t(deleteConfirm.entry.isDir ? 'dock.deleteFolderConfirm' : 'dock.deleteFileConfirm'),
              deleteConfirm.entry.path,
              active ? `${active.name} · ${active.username}@${active.host}` : '',
            ].filter(Boolean).join('\n\n')}
            primaryLabel={t('general.delete')}
            danger
            onCancel={() => setDeleteConfirm(null)}
            onSubmit={() => submitDelete().catch(err => setErr(err?.toString() ?? 'Delete failed'))}
          />
        )}
      </div>

      {preview && (
        <PreviewPane preview={preview} onClose={() => setPreviewByDevice(prev => ({ ...prev, [deviceId]: null }))} />
      )}
    </div>
  )
}

function PreviewPane({ preview, onClose }: { preview: PreviewState; onClose: () => void }) {
  const { t } = useI18n()
  const { filePreviewWidth, setFilePreviewWidth } = useStore(s => s)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onResizeDown = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startW: filePreviewWidth }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      setFilePreviewWidth(dragRef.current.startW + dragRef.current.startX - ev.clientX)
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    e.preventDefault()
  }

  return (
    <div style={{ ...s.previewPane, width: filePreviewWidth }}>
      <div className="resize-handle resize-handle-left" style={s.previewResizeHandle} onMouseDown={onResizeDown} />
      <div style={s.previewTop}>
        <div style={s.previewTitle}>
          <i className={`ti ${fileIcon(preview.path)}`} style={{ color: fileIconColor(preview.path), fontSize:'var(--ui-font-lg)' }} />
          <span style={s.previewName}>{fileNameFromPath(preview.path)}</span>
        </div>
        <button style={s.close} onClick={onClose} title={t('general.close')}><i className="ti ti-x" /></button>
      </div>
      <pre style={s.previewPre}>{preview.content}</pre>
    </div>
  )
}

function FileTransferDialog({
  title,
  primaryLabel,
  sourceLabel,
  pathLabel,
  pathValue,
  onPathChange,
  onBrowse,
  conflictPolicy,
  onConflictPolicyChange,
  onCancel,
  onSubmit,
}: {
  title: string
  primaryLabel: string
  sourceLabel: string
  pathLabel: string
  pathValue: string
  onPathChange: (value: string) => void
  onBrowse: () => void
  conflictPolicy?: UploadConflictPolicy
  onConflictPolicyChange?: (value: UploadConflictPolicy) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const { t } = useI18n()
  return (
    <div style={s.transferOverlay} onMouseDown={onCancel}>
      <div style={s.transferDialog} onMouseDown={e => e.stopPropagation()}>
        <div style={s.transferTitle}>{title}</div>
        <div style={s.transferSource}>{sourceLabel}</div>
        <label style={s.transferField}>
          <span>{pathLabel}</span>
          <div style={s.transferPathRow}>
            <input
              autoFocus
              style={s.transferInput}
              value={pathValue}
              onChange={e => onPathChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') onSubmit()
                if (e.key === 'Escape') onCancel()
              }}
            />
            <button style={s.toolBtn} type="button" onClick={onBrowse}>{t('general.browse')}</button>
          </div>
        </label>
        {conflictPolicy && onConflictPolicyChange && (
          <label style={s.transferField}>
            <span>{t('dock.conflict')}</span>
            <select
              style={s.transferInput}
              value={conflictPolicy}
              onChange={e => onConflictPolicyChange(e.target.value as UploadConflictPolicy)}
            >
              <option value="overwrite">{t('dock.conflictOverwrite')}</option>
              <option value="skip">{t('dock.conflictSkip')}</option>
              <option value="fail">{t('dock.conflictFail')}</option>
            </select>
          </label>
        )}
        <div style={s.transferActions}>
          <button style={s.toolBtn} type="button" onClick={onCancel}>{t('general.cancel')}</button>
          <button style={s.primaryBtn} type="button" onClick={onSubmit}>{primaryLabel}</button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDialog({
  title,
  message,
  primaryLabel,
  danger,
  conflictPolicy,
  onConflictPolicyChange,
  onCancel,
  onSubmit,
}: {
  title: string
  message: string
  primaryLabel: string
  danger?: boolean
  conflictPolicy?: UploadConflictPolicy
  onConflictPolicyChange?: (value: UploadConflictPolicy) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const { t } = useI18n()
  return (
    <div style={s.transferOverlay} onMouseDown={onCancel}>
      <div style={s.transferDialog} onMouseDown={e => e.stopPropagation()}>
        <div style={s.transferTitle}>{title}</div>
        <div style={s.confirmMessage}>{message}</div>
        {conflictPolicy && onConflictPolicyChange && (
          <label style={s.transferField}>
            <span>{t('dock.conflict')}</span>
            <select
              style={s.transferInput}
              value={conflictPolicy}
              onChange={e => onConflictPolicyChange(e.target.value as UploadConflictPolicy)}
            >
              <option value="overwrite">{t('dock.conflictOverwrite')}</option>
              <option value="skip">{t('dock.conflictSkip')}</option>
              <option value="fail">{t('dock.conflictFail')}</option>
            </select>
          </label>
        )}
        <div style={s.transferActions}>
          <button style={s.toolBtn} type="button" onClick={onCancel}>{t('general.cancel')}</button>
          <button style={danger ? s.dangerBtn : s.primaryBtn} type="button" onClick={onSubmit}>{primaryLabel}</button>
        </div>
      </div>
    </div>
  )
}

function CreateRow({
  draft,
  setDraft,
  onSubmit,
  onCancel,
  depth,
}: {
  draft: CreateDraft
  setDraft: (draft: CreateDraft | null) => void
  onSubmit: () => void
  onCancel: () => void
  depth: number
}) {
  return (
    <div style={{ ...s.editRow, paddingLeft: 5 + depth * 13 }}>
      <i className={`ti ${draft.kind === 'folder' ? 'ti-folder' : 'ti-file'}`} style={{ color: draft.kind === 'folder' ? '#dcdcaa' : 'var(--t2)', fontSize:'var(--ui-font-lg)' }} />
      <input
        autoFocus
        style={s.treeInput}
        value={draft.name}
        onChange={e => setDraft({ ...draft, name: e.target.value })}
        onBlur={() => draft.name.trim() ? onSubmit() : onCancel()}
        onKeyDown={e => {
          if (e.key === 'Enter') onSubmit()
          if (e.key === 'Escape') onCancel()
        }}
      />
    </div>
  )
}

function RenameRow({
  entry,
  draft,
  setDraft,
  onSubmit,
  onCancel,
  depth,
}: {
  entry: RemoteFileEntry
  draft: RenameDraft
  setDraft: (draft: RenameDraft | null) => void
  onSubmit: () => void
  onCancel: () => void
  depth: number
}) {
  return (
    <div style={{ ...s.editRow, paddingLeft: 5 + depth * 13 }}>
      <i className={`ti ${entry.isDir ? 'ti-folder' : fileIcon(entry.name)}`} style={{ color: entry.isDir ? '#dcdcaa' : fileIconColor(entry.name), fontSize:'var(--ui-font-lg)' }} />
      <input
        autoFocus
        style={s.treeInput}
        value={draft.name}
        onChange={e => setDraft({ ...draft, name: e.target.value })}
        onBlur={() => draft.name.trim() ? onSubmit() : onCancel()}
        onKeyDown={e => {
          if (e.key === 'Enter') onSubmit()
          if (e.key === 'Escape') onCancel()
        }}
      />
    </div>
  )
}

function FileMenu({
  menu,
  rootPath,
  onClose,
  onNewFile,
  onNewFolder,
  onUpload,
  onPreview,
  onDownload,
  onRename,
  onDelete,
}: {
  menu: FileContextMenu
  rootPath: string
  onClose: () => void
  onNewFile: (parent: string) => void
  onNewFolder: (parent: string) => void
  onUpload: (parent: string) => void
  onPreview: (entry: RemoteFileEntry) => void
  onDownload: (entry: RemoteFileEntry) => void
  onRename: (entry: RemoteFileEntry) => void
  onDelete: (entry: RemoteFileEntry) => void
}) {
  const { t } = useI18n()
  const entry = menu.entry
  const parent = targetParentPath(entry, rootPath)
  const item = (icon: string, label: string, onClick: () => void, danger = false) => (
    <button style={{ ...s.menuItem, ...(danger ? s.menuDanger : {}) }} onClick={() => { onClick(); onClose() }}>
      <i className={`ti ${icon}`} />
      <span>{label}</span>
    </button>
  )

  return (
    <div style={{ ...s.contextMenu, left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
      {item('ti-file-plus', t('dock.newFile'), () => onNewFile(parent))}
      {item('ti-folder-plus', t('dock.newFolder'), () => onNewFolder(parent))}
      {item('ti-upload', t('dock.upload'), () => onUpload(parent))}
      {entry && !entry.isDir && item('ti-eye', t('dock.preview'), () => onPreview(entry))}
      {entry && item('ti-download', t('dock.download'), () => onDownload(entry))}
      {entry && item('ti-pencil', t('dock.rename'), () => onRename(entry))}
      {entry && <div style={s.menuSep} />}
      {entry && item('ti-trash', t('general.delete'), () => onDelete(entry), true)}
    </div>
  )
}

interface RenderCtx {
  deviceId: string
  dirCache: Record<string, RemoteFileEntry[]>
  expanded: Set<string>
  selectedPath: string | null
  createDraft: CreateDraft | null
  renameDraft: RenameDraft | null
  setSelectedPath: (path: string | null) => void
  toggleDir: (entry: RemoteFileEntry) => void
  openContextMenu: (e: React.MouseEvent, entry?: RemoteFileEntry) => void
  previewFile: (entry: RemoteFileEntry) => void
  setRenameDraft: (draft: RenameDraft | null) => void
  setCreateDraft: (draft: CreateDraft | null) => void
  submitCreate: () => void
  submitRename: () => void
  uploadFiles: (files: DroppedFile[], parentPath: string) => void
  moveEntry: (entry: RemoteDragPayload, targetDir: string) => void
  startDownload: (entry: RemoteFileEntry) => void
  startPointerDrag: (entry: RemoteFileEntry, e: React.PointerEvent<HTMLElement>) => void
  shouldSuppressClick: () => boolean
  setRemoteDrag: (payload: RemoteDragPayload) => void
  getRemoteDrag: () => RemoteDragPayload | null
  clearRemoteDrag: () => void
  markRemoteDropHandled: () => void
  isRemoteDropHandled: () => boolean
  setDropTarget: (target: DropTarget | null) => void
  dropTargetRow: string | null
}

function renderTree(entries: RemoteFileEntry[], depth: number, ctx: RenderCtx): React.ReactNode[] {
  return entries.flatMap(entry => {
    const isOpen = entry.isDir && ctx.expanded.has(entry.path)
    const children = entry.isDir ? ctx.dirCache[cacheKey(ctx.deviceId, entry.path)] : undefined
    const row = ctx.renameDraft?.path === entry.path ? (
      <RenameRow
        key={entry.path}
        entry={entry}
        draft={ctx.renameDraft}
        setDraft={ctx.setRenameDraft}
        onSubmit={ctx.submitRename}
        onCancel={() => ctx.setRenameDraft(null)}
        depth={depth}
      />
    ) : (
      <div key={entry.path}>
        <button
          data-remote-drop-target={entry.isDir ? entry.path : parentPath(entry.path)}
          data-remote-drop-label={entry.isDir ? entry.name : parentPath(entry.path)}
          data-remote-drop-row={entry.path}
          style={{
            ...s.fileRow,
            ...(ctx.selectedPath === entry.path ? s.fileRowOn : {}),
            ...(ctx.dropTargetRow === entry.path ? s.fileRowDrop : {}),
            paddingLeft: 5 + depth * 13,
          }}
          onDoubleClick={() => !entry.isDir && ctx.previewFile(entry)}
          onContextMenu={e => ctx.openContextMenu(e, entry)}
          onPointerDown={e => ctx.startPointerDrag(entry, e)}
          onClick={e => {
            if (ctx.shouldSuppressClick()) {
              e.preventDefault()
              e.stopPropagation()
              return
            }
            ctx.setSelectedPath(entry.path)
            if (entry.isDir) {
              ctx.toggleDir(entry)
            } else {
            }
          }}
          title={entry.path}
        >
          <i className={`ti ${entry.isDir ? (isOpen ? 'ti-chevron-down' : 'ti-chevron-right') : fileIcon(entry.name)}`} style={{ color: entry.isDir ? 'var(--t1)' : fileIconColor(entry.name), fontSize:'var(--ui-font-lg)' }} />
          <span style={s.fileName}>{entry.name}</span>
          <span style={s.fileMeta}>{entry.isDir ? '' : formatSize(entry.size)}</span>
        </button>
      </div>
    )
    if (!isOpen) return [row]
    const childRows = [
      ...(ctx.createDraft?.parentPath === entry.path
        ? [<CreateRow key={`${entry.path}:create`} draft={ctx.createDraft} setDraft={ctx.setCreateDraft} onSubmit={ctx.submitCreate} onCancel={() => ctx.setCreateDraft(null)} depth={depth + 1} />]
        : []),
      ...(children
      ? renderTree(children, depth + 1, ctx)
      : [<div key={`${entry.path}:loading`} style={{ ...s.loadingRow, paddingLeft: 22 + (depth + 1) * 13 }}>loading...</div>]),
    ]
    return [row, ...childRows]
  })
}

function HistoryPanel({ width }: { width: number }) {
  const { t } = useI18n()
  const { commandHistory, removeCommandHistory, clearCommandHistory } = useStore(s => s)
  const [err, setErr] = useState('')

  const insert = async (command: string) => {
    setErr('')
    await sendCommandToActiveTerminal(command, 'insert')
  }

  const run = async (command: string) => {
    setErr('')
    await sendCommandToActiveTerminal(command, 'run')
  }

  const remove = async (id: string) => {
    await deleteCommandHistory(id)
    removeCommandHistory(id)
  }

  const clearAll = async () => {
    await clearCommandHistoryDb()
    clearCommandHistory()
  }

  return (
    <div style={{ ...s.panel, width }}>
      {commandHistory.length > 0 && (
        <div style={s.actionTop}>
          <span style={s.actionLabel}>{t('dock.history')}</span>
          <button style={s.linkBtn} onClick={() => clearAll().catch(err => setErr(err?.toString() ?? 'Clear failed'))}>{t('general.clear')}</button>
        </div>
      )}
      {commandHistory.length === 0 ? <Empty text={t('dock.historyEmpty')} /> : commandHistory.map(item => (
        <div key={item.id} style={s.rowCard} onDoubleClick={() => insert(item.command).catch(err => setErr(err?.toString() ?? 'Insert failed'))}>
          <div style={s.commandText}>{item.command}</div>
          <div style={s.rowTop}>
            <div style={s.muted}>{item.connectionName || t('dock.unknownDevice')}</div>
            <div style={s.inlineForm}>
              <button style={s.linkBtn} onClick={() => insert(item.command).catch(err => setErr(err?.toString() ?? 'Insert failed'))}>{t('command.insert')}</button>
              <button style={s.linkBtn} onClick={() => run(item.command).catch(err => setErr(err?.toString() ?? 'Run failed'))}>{t('command.run')}</button>
              <button style={s.linkBtn} onClick={() => remove(item.id).catch(err => setErr(err?.toString() ?? 'Delete failed'))}>{t('general.delete')}</button>
            </div>
          </div>
        </div>
      ))}
      {err && <div style={s.err}>{err}</div>}
    </div>
  )
}

function SnippetsPanel({ width }: { width: number }) {
  const { t } = useI18n()
  const { commandSnippets, upsertCommandSnippet, removeCommandSnippet } = useStore(s => s)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const canSave = name.trim() && command.trim()
  const sorted = useMemo(() => [...commandSnippets].sort((a, b) => a.name.localeCompare(b.name)), [commandSnippets])

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setErr('')
    try {
      const saved = await saveSnippet({ name, command })
      upsertCommandSnippet({
        id: saved.id,
        name: saved.name,
        command: saved.command,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      })
      setName('')
      setCommand('')
    } catch (e: any) {
      setErr(e?.toString() ?? 'Failed to save snippet')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    await deleteSnippet(id)
    removeCommandSnippet(id)
  }

  const insert = async (command: string) => {
    setErr('')
    await sendCommandToActiveTerminal(command, 'insert')
  }

  const run = async (command: string) => {
    setErr('')
    await sendCommandToActiveTerminal(command, 'run')
  }

  return (
    <div style={{ ...s.panel, width }}>
      <div style={s.snippetForm}>
        <input style={s.smallInput} value={name} onChange={e => setName(e.target.value)} placeholder={t('dock.name')} />
        <textarea
          style={s.snippetCommandInput}
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault()
              save()
            }
          }}
          placeholder={t('dock.actualCommand')}
        />
        <button style={s.saveBtn} disabled={!canSave || busy} onClick={save}>{t('general.save')}</button>
        {err && <div style={s.err}>{err}</div>}
      </div>

      {sorted.length === 0 ? <Empty text={t('dock.snippetsEmpty')} /> : sorted.map(item => (
        <div key={item.id} style={s.rowCard} onDoubleClick={() => insert(item.command).catch(err => setErr(err?.toString() ?? 'Insert failed'))}>
          <div style={s.rowTop}>
            <span style={s.snippetName}>/snp-{item.name}</span>
            <div style={s.inlineForm}>
              <button style={s.linkBtn} onClick={() => insert(item.command).catch(err => setErr(err?.toString() ?? 'Insert failed'))}>{t('command.insert')}</button>
              <button style={s.linkBtn} onClick={() => run(item.command).catch(err => setErr(err?.toString() ?? 'Run failed'))}>{t('command.run')}</button>
              <button style={s.linkBtn} onClick={() => remove(item.id).catch(err => setErr(err?.toString() ?? 'Delete failed'))}>{t('general.delete')}</button>
            </div>
          </div>
          <div style={s.commandText}>{item.command}</div>
          <div style={s.muted}>{t('dock.snippetAlso').replace('{name}', item.name)}</div>
        </div>
      ))}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div style={s.empty}>{text}</div>
}

function dockTabKey(tab: RightDockTab): I18nKey {
  return `dock.${tab}` as I18nKey
}

function formatSize(size?: number | null) {
  if (size == null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function jobLabel(job: FileJob) {
  const path = fileNameFromPath(job.path)
  const message = job.message ?? job.kind
  return `${Math.max(0, Math.min(100, job.progress))}% ${message}${path ? ` - ${path}` : ''}`
}

function normalizeRemotePath(path: string) {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  return normalized || '.'
}

function cacheKey(deviceId: string, path: string) {
  return `${deviceId}:${normalizeRemotePath(path)}`
}

function parentPath(path: string) {
  const normalized = normalizeRemotePath(path)
  if (normalized === '.' || normalized === '/' || !normalized.includes('/')) return '.'
  const withoutTrailing = normalized.replace(/\/$/, '')
  const index = withoutTrailing.lastIndexOf('/')
  if (index <= 0) return normalized.startsWith('/') ? '/' : '.'
  return withoutTrailing.slice(0, index)
}

function isRemoteDescendant(path: string, ancestor: string) {
  const normalizedPath = normalizeRemotePath(path).replace(/\/$/, '')
  const normalizedAncestor = normalizeRemotePath(ancestor).replace(/\/$/, '')
  if (normalizedPath === normalizedAncestor) return false
  if (normalizedAncestor === '/') return normalizedPath.startsWith('/')
  return normalizedPath.startsWith(`${normalizedAncestor}/`)
}

function canMoveRemotePayload(entry: RemoteDragPayload, targetDir: string) {
  const fromParent = normalizeRemotePath(parentPath(entry.path))
  const sourcePath = normalizeRemotePath(entry.path)
  const normalizedTarget = normalizeRemotePath(targetDir)
  const targetPath = joinRemotePath(normalizedTarget, entry.name)
  if (fromParent === normalizedTarget) return false
  if (targetPath === sourcePath) return false
  if (entry.isDir && (normalizedTarget === sourcePath || isRemoteDescendant(normalizedTarget, sourcePath))) return false
  return true
}

function joinRemotePath(base: string, name: string) {
  const safeName = name.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'upload.bin'
  const normalized = normalizeRemotePath(base)
  if (normalized === '.') return safeName
  if (normalized === '/') return `/${safeName}`
  return `${normalized.replace(/\/$/, '')}/${safeName}`
}

function fileNameFromPath(path: string) {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path
}

function defaultDownloadPath(entry: RemoteFileEntry) {
  return `downloads\\${entry.name}`
}

function joinLocalPath(dir: string, name: string) {
  const separator = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${separator}${name}`
}

function readRemoteDragPayload(dataTransfer: DataTransfer): RemoteDragPayload | null {
  const raw = dataTransfer.getData(REMOTE_DRAG_MIME)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as RemoteDragPayload
    return value.path && value.name ? value : null
  } catch {
    return null
  }
}

function defaultUploadPath(localPath: string, parentPath: string) {
  const name = fileNameFromPath(localPath.replace(/\\/g, '/')) || 'upload.bin'
  return joinRemotePath(parentPath, name)
}

function targetParentPath(entry: RemoteFileEntry | undefined, rootPath: string) {
  if (!entry) return rootPath
  return entry.isDir ? entry.path : parentPath(entry.path)
}

function findEntryInCache(cache: Record<string, RemoteFileEntry[]>, deviceId: string, path: string) {
  for (const [key, entries] of Object.entries(cache)) {
    if (!key.startsWith(`${deviceId}:`)) continue
    const found = entries.find(entry => entry.path === path)
    if (found) return found
  }
  return undefined
}

function readJsonPref<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function writeJsonPref(key: string, value: unknown) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(key, JSON.stringify(value))
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext ?? '')) return 'ti-brand-typescript'
  if (['json', 'lock'].includes(ext ?? '')) return 'ti-braces'
  if (['md', 'txt', 'log', 'yml', 'yaml', 'toml'].includes(ext ?? '')) return 'ti-file-text'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext ?? '')) return 'ti-photo'
  if (['zip', 'gz', 'tar', '7z'].includes(ext ?? '')) return 'ti-archive'
  return 'ti-file'
}

function fileIconColor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (['ts', 'tsx'].includes(ext ?? '')) return 'var(--acc)'
  if (['js', 'jsx'].includes(ext ?? '')) return '#dcdcaa'
  if (['json', 'lock'].includes(ext ?? '')) return '#b5cea8'
  if (['html', 'xml'].includes(ext ?? '')) return '#ce9178'
  if (['md', 'txt', 'log'].includes(ext ?? '')) return 'var(--t1)'
  return 'var(--t2)'
}

const s: Record<string, React.CSSProperties> = {
  root: { width:'100%', height:'100%', minWidth:0, minHeight:0, flexShrink:0, background:'var(--c0)', borderLeft:'1px solid var(--b1)', display:'flex', flexDirection:'column', overflow:'hidden', position:'relative' },
  resizeHandle: { position:'absolute', left:0, top:0, bottom:0, width:5, cursor:'col-resize', zIndex:5 },
  tabs: { display:'flex', borderBottom:'1px solid var(--b1)', height:30, flexShrink:0, paddingLeft:4, alignItems:'center' },
  tab: { flex:1, height:'100%', border:'none', background:'transparent', color:'var(--t2)', cursor:'pointer', fontSize:'var(--ui-font-sm)', fontFamily:'var(--fm)' },
  tabOn: { color:'var(--t0)', boxShadow:'inset 0 1px 0 var(--acc)' },
  close: { background:'none', border:'none', color:'var(--t2)', cursor:'pointer', padding:'0 6px', fontSize:'var(--ui-font)', display:'flex', alignItems:'center' },
  body: { flex:1, minHeight:0, overflow:'hidden' },
  view: { height:'100%', minHeight:0 },
  loading: { padding:12, color:'var(--t3)', fontSize:'var(--ui-font)', fontFamily:'var(--fm)' },
  panel: { height:'100%', minHeight:0, overflowY:'auto', padding:8, display:'flex', flexDirection:'column', gap:8 },
  empty: { fontSize:'var(--ui-font)', color:'var(--t3)', padding:'14px 8px', textAlign:'center', lineHeight:1.7 },
  fileWorkspace: { height:'100%', minHeight:0, display:'flex', background:'var(--c0)' },
  fileExplorer: { flexShrink:0, height:'100%', minHeight:0, overflow:'hidden', padding:8, display:'flex', flexDirection:'column', gap:8, position:'relative' },
  jobBar: { minHeight:24, border:'1px solid var(--b0)', borderRadius:3, background:'var(--c1)', overflow:'hidden', display:'grid', gridTemplateColumns:'1fr 24px', alignItems:'center', position:'relative', flexShrink:0 },
  topProgress: { position:'absolute', left:0, right:0, top:0, height:2, background:'transparent', overflow:'hidden' },
  topProgressFill: { display:'block', height:'100%', background:'var(--acc)', transition:'width 0.16s ease' },
  jobText: { minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--t1)', fontSize:'var(--ui-font-sm)', padding:'3px 6px 2px' },
  jobCancel: { width:24, height:22, border:'none', background:'transparent', color:'var(--t2)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center' },
  fileHeader: { display:'flex', gap:5, alignItems:'center' },
  explorerTitle: { color:'var(--t0)', fontSize:'var(--ui-font)', fontWeight:700, letterSpacing:'0.02em', textTransform:'uppercase', flexShrink:0 },
  pathInput: { flex:1, minWidth:0, height:22, border:'1px solid var(--b0)', borderRadius:3, background:'var(--c1)', color:'var(--t0)', fontSize:'var(--ui-font-sm)', fontFamily:'var(--fm)', padding:'0 7px', outline:'none' },
  iconBtn: { width:22, height:22, border:'none', borderRadius:3, background:'transparent', color:'var(--t1)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0 },
  fileList: { flex:'1 1 0px', minHeight:0, display:'flex', flexDirection:'column', gap:0, border:'1px solid rgba(255,255,255,0.045)', borderRadius:3, overflowY:'auto', overflowX:'hidden', background:'var(--c0)' },
  fileListDrop: { border:'1px solid var(--acc)', background:'color-mix(in srgb, var(--acc) 10%, var(--c0))' },
  fileRow: { width:'100%', height:23, display:'flex', alignItems:'center', gap:6, border:'none', background:'transparent', color:'var(--t0)', cursor:'pointer', fontFamily:'var(--fm)', padding:'0 6px', textAlign:'left' },
  fileRowOn: { background:'#2a2d2e' },
  fileRowDrop: { background:'color-mix(in srgb, var(--acc) 22%, var(--c0))', boxShadow:'inset 2px 0 0 var(--acc)' },
  dropHint: { position:'sticky', top:0, zIndex:3, minHeight:22, display:'flex', alignItems:'center', padding:'0 8px', background:'color-mix(in srgb, var(--acc) 24%, var(--c0))', color:'var(--t0)', fontSize:'var(--ui-font-sm)', borderBottom:'1px solid var(--acc)', pointerEvents:'none' },
  pointerDragGhost: { position:'fixed', zIndex:2500, maxWidth:260, height:24, display:'flex', alignItems:'center', gap:6, padding:'0 8px', border:'1px solid var(--b2)', borderRadius:4, background:'var(--c1)', color:'var(--t0)', boxShadow:'0 8px 20px rgba(0,0,0,0.36)', fontSize:'var(--ui-font-sm)', pointerEvents:'none', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  editRow: { height:23, display:'flex', alignItems:'center', gap:6, background:'var(--c1)', color:'var(--t0)' },
  treeInput: { flex:1, minWidth:0, height:20, border:'1px solid var(--acc)', borderRadius:2, background:'var(--c0)', color:'var(--t0)', fontSize:'var(--ui-font)', fontFamily:'var(--fm)', padding:'0 5px', outline:'none' },
  loadingRow: { height:22, display:'flex', alignItems:'center', color:'var(--t2)', fontSize:'var(--ui-font-sm)', fontFamily:'var(--fm)' },
  fileName: { flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:'var(--ui-font)' },
  fileMeta: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', flexShrink:0 },
  fileActions: { flexShrink:0, border:'1px solid var(--b0)', borderRadius:4, background:'var(--c1)', padding:7, display:'flex', flexDirection:'column', gap:6 },
  actionTop: { display:'flex', alignItems:'center', justifyContent:'space-between', gap:6 },
  actionLabel: { color:'var(--t1)', fontSize:'var(--ui-font-sm)', textTransform:'uppercase' },
  inlineForm: { display:'flex', alignItems:'center', gap:5 },
  toolBtn: { height:24, border:'1px solid var(--b1)', borderRadius:3, background:'var(--c1)', color:'var(--t0)', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)', display:'inline-flex', alignItems:'center', justifyContent:'center', gap:5, padding:'0 8px' },
  dangerBtn: { height:24, border:'1px solid rgba(244,71,71,0.22)', borderRadius:3, background:'rgba(244,71,71,0.08)', color:'#f48771', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)', display:'inline-flex', alignItems:'center', justifyContent:'center', gap:5, padding:'0 8px' },
  primaryBtn: { height:24, border:'none', borderRadius:3, background:'var(--acc)', color:'#0b1b24', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)', display:'inline-flex', alignItems:'center', justifyContent:'center', gap:5, padding:'0 10px' },
  transferOverlay: { position:'absolute', inset:0, zIndex:30, display:'flex', alignItems:'center', justifyContent:'center', padding:14, background:'rgba(0,0,0,0.34)' },
  transferDialog: { width:'min(420px, 100%)', border:'1px solid var(--b2)', borderRadius:6, background:'var(--c1)', boxShadow:'0 18px 50px rgba(0,0,0,0.45)', padding:12, display:'flex', flexDirection:'column', gap:9 },
  transferTitle: { color:'var(--t0)', fontSize:'var(--ui-font-md)', fontWeight:700 },
  confirmMessage: { color:'var(--t1)', fontSize:'var(--ui-font)', lineHeight:1.5, overflowWrap:'anywhere' },
  transferSource: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  transferField: { display:'flex', flexDirection:'column', gap:6, color:'var(--t1)', fontSize:'var(--ui-font-sm)' },
  transferPathRow: { display:'grid', gridTemplateColumns:'1fr auto', gap:6 },
  transferInput: { height:26, minWidth:0, border:'1px solid var(--b1)', borderRadius:3, background:'var(--c0)', color:'var(--t0)', fontFamily:'var(--fm)', fontSize:'var(--ui-font)', padding:'0 7px', outline:'none' },
  transferActions: { display:'flex', justifyContent:'flex-end', gap:7 },
  contextMenu: { position:'fixed', zIndex:2000, minWidth:150, padding:'4px 0', border:'1px solid var(--b2)', borderRadius:4, background:'var(--c1)', boxShadow:'0 8px 24px rgba(0,0,0,0.35)' },
  menuItem: { width:'100%', height:25, display:'flex', alignItems:'center', gap:8, border:'none', background:'transparent', color:'var(--t0)', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font)', padding:'0 10px', textAlign:'left' },
  menuDanger: { color:'#f48771' },
  menuSep: { height:1, background:'rgba(255,255,255,0.08)', margin:'4px 0' },
  previewPane: { flexShrink:0, minHeight:0, borderLeft:'1px solid var(--b1)', background:'var(--c0)', display:'flex', flexDirection:'column', overflow:'hidden', position:'relative' },
  previewResizeHandle: { position:'absolute', left:0, top:0, bottom:0, width:5, cursor:'col-resize', zIndex:4 },
  previewTop: { height:32, borderBottom:'1px solid var(--b0)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, padding:'0 9px', flexShrink:0 },
  previewTitle: { minWidth:0, display:'flex', alignItems:'center', gap:7 },
  previewName: { color:'var(--t0)', fontSize:'var(--ui-font)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  previewPre: { margin:0, padding:'10px 12px', overflow:'auto', color:'var(--t0)', fontSize:'var(--ui-font)', lineHeight:1.5, fontFamily:'var(--fm)', whiteSpace:'pre-wrap', flex:1, minHeight:0 },
  linkBtn: { border:'none', background:'transparent', color:'var(--acc)', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font-sm)', padding:0 },
  rowCard: { border:'1px solid var(--b0)', borderRadius:4, background:'var(--c1)', padding:7, display:'flex', flexDirection:'column', gap:5 },
  rowTop: { display:'flex', justifyContent:'space-between', gap:8 },
  commandText: { color:'var(--t0)', fontSize:'var(--ui-font)', lineHeight:1.45, overflowWrap:'anywhere' },
  muted: { color:'var(--t2)', fontSize:'var(--ui-font-sm)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  snippetForm: { border:'1px solid var(--b0)', borderRadius:4, background:'var(--c1)', padding:7, display:'flex', flexDirection:'column', gap:6 },
  smallInput: { height:24, border:'1px solid var(--b1)', borderRadius:3, background:'var(--c1)', color:'var(--t0)', fontSize:'var(--ui-font)', fontFamily:'var(--fm)', padding:'0 7px', outline:'none' },
  snippetCommandInput: { minHeight:62, resize:'vertical', border:'1px solid var(--b1)', borderRadius:3, background:'var(--c1)', color:'var(--t0)', fontSize:'var(--ui-font)', fontFamily:'var(--fm)', padding:'6px 7px', outline:'none', lineHeight:1.45 },
  saveBtn: { height:24, border:'none', borderRadius:3, background:'var(--acc)', color:'#fff', cursor:'pointer', fontFamily:'var(--fm)', fontSize:'var(--ui-font)' },
  err: { color:'var(--red)', fontSize:'var(--ui-font-sm)' },
  snippetName: { color:'var(--acc)', fontSize:'var(--ui-font)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
}
