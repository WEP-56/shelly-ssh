import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type Connection, type RightDockTab } from '../store'
import {
  listFileJobs,
  onFileJobUpdated,
  queueCreateFile,
  queueDelete,
  queueDownload,
  queueListDir,
  queueMkdir,
  queuePreview,
  queueRename,
  type FileJob,
  type RemoteFileEntry,
} from '../lib/files'
import { deleteSnippet, saveSnippet } from '../lib/db'

const AgentPanel = lazy(() => import('./AgentPanel').then(module => ({ default: module.AgentPanel })))

type PreviewState = { path: string; content: string }
type CreateDraft = { kind: 'file' | 'folder'; parentPath: string; name: string }
type RenameDraft = { path: string; name: string }
type FileContextMenu = { x: number; y: number; entry?: RemoteFileEntry }

export function ContextDock({ active, onClose }: { active: Connection | undefined; onClose: () => void }) {
  const { rightTab, setRightTab, rightDockWidth, setRightDockWidth } = useStore(s => s)
  const [mountedTabs, setMountedTabs] = useState<Record<RightDockTab, boolean>>(() => ({
    files: rightTab === 'files',
    history: rightTab === 'history',
    snippets: rightTab === 'snippets',
    agent: rightTab === 'agent',
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
        {(['files', 'history', 'snippets', 'agent'] as RightDockTab[]).map(tab => (
          <button
            key={tab}
            style={{ ...s.tab, ...(rightTab === tab ? s.tabOn : {}) }}
            onClick={() => setRightTab(tab)}
          >
            {tab}
          </button>
        ))}
        <button style={s.close} onClick={onClose}><i className="ti ti-chevron-right" /></button>
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
        {mountedTabs.agent && (
          <div style={{ ...s.view, display: rightTab === 'agent' ? 'block' : 'none' }}>
            <Suspense fallback={<div style={s.loading}>loading agent...</div>}>
              <AgentPanel active={active} width={rightDockWidth} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  )
}

function FilesPanel({ active }: { active: Connection | undefined }) {
  const { rightDockWidth } = useStore(s => s)
  const [rootByDevice, setRootByDevice] = useState<Record<string, string>>(() => readJsonPref('shelly:fileRoots', {}))
  const [expandedByDevice, setExpandedByDevice] = useState<Record<string, string[]>>(() => readJsonPref('shelly:fileExpanded', {}))
  const [selectedByDevice, setSelectedByDevice] = useState<Record<string, string | null>>(() => readJsonPref('shelly:fileSelected', {}))
  const [previewByDevice, setPreviewByDevice] = useState<Record<string, PreviewState | null>>({})
  const [jobs, setJobs] = useState<FileJob[]>([])
  const [dirCache, setDirCache] = useState<Record<string, RemoteFileEntry[]>>({})
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null)
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null)
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null)
  const [err, setErr] = useState('')

  const deviceId = active?.id ?? ''
  const connected = active?.status === 'connected' && !!active.sessionId
  const canLoad = !!active && (connected || !!active.rememberPassword)
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
    if (!active || entry.isDir) return
    const localPath = window.prompt('Local download path', defaultDownloadPath(entry))
    if (!localPath?.trim()) return
    setErr('')
    const job = await queueDownload(active.id, active.sessionId ?? null, entry.path, localPath.trim())
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
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

  const deleteEntry = async (entry = selectedEntry) => {
    if (!active || !entry) return
    const ok = window.confirm(`Delete ${entry.name}?`)
    if (!ok) return
    setErr('')
    const job = await queueDelete(active.id, active.sessionId ?? null, entry.path, entry.isDir)
    setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)])
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

  useEffect(() => {
    if (!active || !canLoad || dirCache[cacheKey(active.id, rootPath)]) return
    queueListDir(active.id, active.sessionId ?? null, rootPath)
      .then(job => setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)]))
      .catch(err => setErr(err?.toString() ?? 'Refresh failed'))
  }, [active?.id, active?.sessionId, canLoad, rootPath])

  return (
    <div style={s.fileWorkspace} onClick={() => setContextMenu(null)}>
      <div style={{ ...s.fileExplorer, width: rightDockWidth }} title={latestJob ? `${latestJob.kind}: ${latestJob.status} - ${latestJob.message ?? latestJob.path}` : undefined}>
        {runningJob && (
          <div style={s.topProgress}>
            <span style={{ ...s.topProgressFill, width: `${Math.max(8, runningJob.progress)}%` }} />
          </div>
        )}

        <div style={s.fileHeader}>
          <div style={s.explorerTitle}>remote</div>
          <input
            style={s.pathInput}
            value={rootPath}
            onChange={e => setRootPath(e.target.value)}
            disabled={!canLoad}
            onKeyDown={e => e.key === 'Enter' && loadDir(rootPath, true).catch(err => setErr(err?.toString() ?? 'Refresh failed'))}
          />
          <button style={s.iconBtn} disabled={!canLoad} onClick={() => loadDir(rootPath, true).catch(err => setErr(err?.toString() ?? 'Refresh failed'))} title="refresh">
            <i className="ti ti-refresh" />
          </button>
          <button style={s.iconBtn} disabled={!canLoad} onClick={() => startCreate('file', targetParentPath(selectedEntry, rootPath))} title="new file">
            <i className="ti ti-file-plus" />
          </button>
          <button style={s.iconBtn} disabled={!canLoad} onClick={() => startCreate('folder', targetParentPath(selectedEntry, rootPath))} title="new folder">
            <i className="ti ti-folder-plus" />
          </button>
          <button style={s.iconBtn} disabled={!canLoad} onClick={() => setExpandedByDevice(prev => ({ ...prev, [deviceId]: [] }))} title="collapse all">
            <i className="ti ti-fold-down" />
          </button>
        </div>

        {!active && <Empty text="Select a connection first." />}
        {active && !canLoad && <Empty text="Connect or remember password to load files." />}
        {canLoad && rootEntries.length === 0 && !runningJob && <Empty text="Refresh to load remote files." />}
        {err && <div style={s.err}>{err}</div>}

        {(rootEntries.length > 0 || !!createDraft) && (
          <div style={s.fileList} onContextMenu={e => openContextMenu(e)}>
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
            })}
          </div>
        )}

        {contextMenu && (
          <FileMenu
            menu={contextMenu}
            rootPath={rootPath}
            onClose={() => setContextMenu(null)}
            onNewFile={parent => startCreate('file', parent)}
            onNewFolder={parent => startCreate('folder', parent)}
            onPreview={entry => previewFile(entry).catch(err => setErr(err?.toString() ?? 'Preview failed'))}
            onDownload={entry => {
              setSelectedPath(entry.path)
              downloadFileFor(entry).catch(err => setErr(err?.toString() ?? 'Download failed'))
            }}
            onRename={entry => setRenameDraft({ path: entry.path, name: entry.name })}
            onDelete={entry => deleteEntry(entry).catch(err => setErr(err?.toString() ?? 'Delete failed'))}
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
          <i className={`ti ${fileIcon(preview.path)}`} style={{ color: fileIconColor(preview.path), fontSize:13 }} />
          <span style={s.previewName}>{fileNameFromPath(preview.path)}</span>
        </div>
        <button style={s.close} onClick={onClose} title="close preview"><i className="ti ti-x" /></button>
      </div>
      <pre style={s.previewPre}>{preview.content}</pre>
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
      <i className={`ti ${draft.kind === 'folder' ? 'ti-folder' : 'ti-file'}`} style={{ color: draft.kind === 'folder' ? '#dcdcaa' : '#686868', fontSize:13 }} />
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
      <i className={`ti ${entry.isDir ? 'ti-folder' : fileIcon(entry.name)}`} style={{ color: entry.isDir ? '#dcdcaa' : fileIconColor(entry.name), fontSize:13 }} />
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
  onPreview: (entry: RemoteFileEntry) => void
  onDownload: (entry: RemoteFileEntry) => void
  onRename: (entry: RemoteFileEntry) => void
  onDelete: (entry: RemoteFileEntry) => void
}) {
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
      {item('ti-file-plus', 'New File', () => onNewFile(parent))}
      {item('ti-folder-plus', 'New Folder', () => onNewFolder(parent))}
      {entry && !entry.isDir && item('ti-eye', 'Preview', () => onPreview(entry))}
      {entry && !entry.isDir && item('ti-download', 'Download', () => onDownload(entry))}
      {entry && item('ti-pencil', 'Rename', () => onRename(entry))}
      {entry && <div style={s.menuSep} />}
      {entry && item('ti-trash', 'Delete', () => onDelete(entry), true)}
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
          style={{ ...s.fileRow, ...(ctx.selectedPath === entry.path ? s.fileRowOn : {}), paddingLeft: 5 + depth * 13 }}
          onDoubleClick={() => !entry.isDir && ctx.previewFile(entry)}
          onContextMenu={e => ctx.openContextMenu(e, entry)}
          onClick={() => {
            ctx.setSelectedPath(entry.path)
            if (entry.isDir) {
              ctx.toggleDir(entry)
            } else {
            }
          }}
          title={entry.path}
        >
          <i className={`ti ${entry.isDir ? (isOpen ? 'ti-chevron-down' : 'ti-chevron-right') : fileIcon(entry.name)}`} style={{ color: entry.isDir ? '#9d9d9d' : fileIconColor(entry.name), fontSize:13 }} />
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
  const { commandHistory } = useStore(s => s)
  return (
    <div style={{ ...s.panel, width }}>
      {commandHistory.length === 0 ? <Empty text="No command history yet." /> : commandHistory.map(item => (
        <div key={item.id} style={s.rowCard}>
          <div style={s.commandText}>{item.command}</div>
          <div style={s.muted}>{item.connectionName || 'unknown device'}</div>
        </div>
      ))}
    </div>
  )
}

function SnippetsPanel({ width }: { width: number }) {
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

  return (
    <div style={{ ...s.panel, width }}>
      <div style={s.snippetForm}>
        <input style={s.smallInput} value={name} onChange={e => setName(e.target.value)} placeholder="name" />
        <input
          style={s.smallInput}
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          placeholder="actual command"
        />
        <button style={s.saveBtn} disabled={!canSave || busy} onClick={save}>save</button>
        {err && <div style={s.err}>{err}</div>}
      </div>

      {sorted.length === 0 ? <Empty text="No snippets yet." /> : sorted.map(item => (
        <div key={item.id} style={s.rowCard}>
          <div style={s.rowTop}>
            <span style={s.snippetName}>/snp-{item.name}</span>
            <button style={s.linkBtn} onClick={() => remove(item.id).catch(err => setErr(err?.toString() ?? 'Delete failed'))}>delete</button>
          </div>
          <div style={s.commandText}>{item.command}</div>
          <div style={s.muted}>also /snippets-{item.name}</div>
        </div>
      ))}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div style={s.empty}>{text}</div>
}

function formatSize(size?: number | null) {
  if (size == null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
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
  if (['ts', 'tsx'].includes(ext ?? '')) return '#569cd6'
  if (['js', 'jsx'].includes(ext ?? '')) return '#dcdcaa'
  if (['json', 'lock'].includes(ext ?? '')) return '#b5cea8'
  if (['html', 'xml'].includes(ext ?? '')) return '#ce9178'
  if (['md', 'txt', 'log'].includes(ext ?? '')) return '#9d9d9d'
  return '#686868'
}

const s: Record<string, React.CSSProperties> = {
  root: { flexShrink:0, background:'#1e1e1e', borderLeft:'1px solid rgba(0,0,0,0.4)', display:'flex', flexDirection:'column', overflow:'hidden', position:'relative' },
  resizeHandle: { position:'absolute', left:0, top:0, bottom:0, width:5, cursor:'col-resize', zIndex:5 },
  tabs: { display:'flex', borderBottom:'1px solid rgba(0,0,0,0.4)', height:30, flexShrink:0, paddingLeft:4, alignItems:'center' },
  tab: { flex:1, height:'100%', border:'none', background:'transparent', color:'#686868', cursor:'pointer', fontSize:10.5, fontFamily:'var(--fm)' },
  tabOn: { color:'#d4d4d4', boxShadow:'inset 0 1px 0 #569cd6' },
  close: { background:'none', border:'none', color:'#686868', cursor:'pointer', padding:'0 6px', fontSize:11, display:'flex', alignItems:'center' },
  body: { flex:1, minHeight:0, overflow:'hidden' },
  view: { height:'100%', minHeight:0 },
  loading: { padding:12, color:'#454545', fontSize:11, fontFamily:'var(--fm)' },
  panel: { height:'100%', minHeight:0, overflowY:'auto', padding:8, display:'flex', flexDirection:'column', gap:8 },
  empty: { fontSize:11, color:'#454545', padding:'14px 8px', textAlign:'center', lineHeight:1.7 },
  fileWorkspace: { height:'100%', minHeight:0, display:'flex', background:'#1e1e1e' },
  fileExplorer: { flexShrink:0, height:'100%', minHeight:0, overflow:'hidden', padding:8, display:'flex', flexDirection:'column', gap:8, position:'relative' },
  topProgress: { position:'sticky', top:0, zIndex:2, height:2, margin:'-8px -8px 6px', background:'transparent', overflow:'hidden' },
  topProgressFill: { display:'block', height:'100%', background:'#569cd6', transition:'width 0.16s ease' },
  fileHeader: { display:'flex', gap:5, alignItems:'center' },
  explorerTitle: { color:'#d4d4d4', fontSize:11, fontWeight:700, letterSpacing:'0.02em', textTransform:'uppercase', flexShrink:0 },
  pathInput: { flex:1, minWidth:0, height:22, border:'1px solid rgba(255,255,255,0.06)', borderRadius:3, background:'#202020', color:'#d4d4d4', fontSize:10.5, fontFamily:'var(--fm)', padding:'0 7px', outline:'none' },
  iconBtn: { width:22, height:22, border:'none', borderRadius:3, background:'transparent', color:'#9d9d9d', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0 },
  fileList: { flex:'1 1 0px', minHeight:0, display:'flex', flexDirection:'column', gap:0, border:'1px solid rgba(255,255,255,0.045)', borderRadius:3, overflowY:'auto', overflowX:'hidden', background:'#191919' },
  fileRow: { width:'100%', height:23, display:'flex', alignItems:'center', gap:6, border:'none', background:'transparent', color:'#d4d4d4', cursor:'pointer', fontFamily:'var(--fm)', padding:'0 6px', textAlign:'left' },
  fileRowOn: { background:'#2a2d2e' },
  editRow: { height:23, display:'flex', alignItems:'center', gap:6, background:'#202020', color:'#d4d4d4' },
  treeInput: { flex:1, minWidth:0, height:20, border:'1px solid #569cd6', borderRadius:2, background:'#1e1e1e', color:'#d4d4d4', fontSize:11, fontFamily:'var(--fm)', padding:'0 5px', outline:'none' },
  loadingRow: { height:22, display:'flex', alignItems:'center', color:'#686868', fontSize:10.5, fontFamily:'var(--fm)' },
  fileName: { flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:11 },
  fileMeta: { color:'#686868', fontSize:10, flexShrink:0 },
  fileActions: { flexShrink:0, border:'1px solid rgba(255,255,255,0.06)', borderRadius:4, background:'#202020', padding:7, display:'flex', flexDirection:'column', gap:6 },
  actionTop: { display:'flex', alignItems:'center', justifyContent:'space-between', gap:6 },
  actionLabel: { color:'#9d9d9d', fontSize:10, textTransform:'uppercase' },
  inlineForm: { display:'flex', alignItems:'center', gap:5 },
  toolBtn: { height:24, border:'1px solid rgba(255,255,255,0.08)', borderRadius:3, background:'#252526', color:'#d4d4d4', cursor:'pointer', fontFamily:'var(--fm)', fontSize:10.5, display:'inline-flex', alignItems:'center', justifyContent:'center', gap:5, padding:'0 8px' },
  dangerBtn: { height:24, border:'1px solid rgba(244,71,71,0.22)', borderRadius:3, background:'rgba(244,71,71,0.08)', color:'#f48771', cursor:'pointer', fontFamily:'var(--fm)', fontSize:10.5, display:'inline-flex', alignItems:'center', justifyContent:'center', gap:5, padding:'0 8px' },
  contextMenu: { position:'fixed', zIndex:2000, minWidth:150, padding:'4px 0', border:'1px solid rgba(255,255,255,0.12)', borderRadius:4, background:'#252526', boxShadow:'0 8px 24px rgba(0,0,0,0.35)' },
  menuItem: { width:'100%', height:25, display:'flex', alignItems:'center', gap:8, border:'none', background:'transparent', color:'#d4d4d4', cursor:'pointer', fontFamily:'var(--fm)', fontSize:11, padding:'0 10px', textAlign:'left' },
  menuDanger: { color:'#f48771' },
  menuSep: { height:1, background:'rgba(255,255,255,0.08)', margin:'4px 0' },
  previewPane: { flexShrink:0, minHeight:0, borderLeft:'1px solid rgba(0,0,0,0.45)', background:'#1b1b1b', display:'flex', flexDirection:'column', overflow:'hidden', position:'relative' },
  previewResizeHandle: { position:'absolute', left:0, top:0, bottom:0, width:5, cursor:'col-resize', zIndex:4 },
  previewTop: { height:32, borderBottom:'1px solid rgba(255,255,255,0.06)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, padding:'0 9px', flexShrink:0 },
  previewTitle: { minWidth:0, display:'flex', alignItems:'center', gap:7 },
  previewName: { color:'#d4d4d4', fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  previewPre: { margin:0, padding:'10px 12px', overflow:'auto', color:'#d4d4d4', fontSize:11, lineHeight:1.5, fontFamily:'var(--fm)', whiteSpace:'pre-wrap', flex:1, minHeight:0 },
  linkBtn: { border:'none', background:'transparent', color:'#569cd6', cursor:'pointer', fontFamily:'var(--fm)', fontSize:10, padding:0 },
  rowCard: { border:'1px solid rgba(255,255,255,0.06)', borderRadius:4, background:'#202020', padding:7, display:'flex', flexDirection:'column', gap:5 },
  rowTop: { display:'flex', justifyContent:'space-between', gap:8 },
  commandText: { color:'#d4d4d4', fontSize:11, lineHeight:1.45, overflowWrap:'anywhere' },
  muted: { color:'#686868', fontSize:10, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  snippetForm: { border:'1px solid rgba(255,255,255,0.06)', borderRadius:4, background:'#202020', padding:7, display:'flex', flexDirection:'column', gap:6 },
  smallInput: { height:24, border:'1px solid rgba(255,255,255,0.08)', borderRadius:3, background:'#252526', color:'#d4d4d4', fontSize:11, fontFamily:'var(--fm)', padding:'0 7px', outline:'none' },
  saveBtn: { height:24, border:'none', borderRadius:3, background:'#569cd6', color:'#fff', cursor:'pointer', fontFamily:'var(--fm)', fontSize:11 },
  err: { color:'#f44747', fontSize:10 },
  snippetName: { color:'#569cd6', fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
}
