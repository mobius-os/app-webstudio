import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_PROJECT } from '../constants.js'
import { buildTree, isHtmlDoc } from '../domain.js'
import { ContextMenu } from './ContextMenu.jsx'
import { FileNode } from './FileNode.jsx'
import { NewFileIcon } from './NewFileIcon.jsx'
import { NewFolderIcon } from './NewFolderIcon.jsx'
import { PencilIcon } from './PencilIcon.jsx'
import { PlusIcon } from './PlusIcon.jsx'
import { ProjectSelector } from './ProjectSelector.jsx'
import { PublishDrawerAction } from './PublishDrawerAction.jsx'
import { TrashIcon } from './TrashIcon.jsx'
import { UploadIcon } from './UploadIcon.jsx'

export function FileNavPanel({
  appId, open, onClose, files, selectedPath, onSelect, canMutate,
  onCreateFile, onCreateFolder, onDeleteFile, onDeleteFolder,
  onUpload, onMove, onMoveTo, onRename, mainPath, onSetMain, returnFocusRef,
  projects, projectsLoaded, activeProjectId,
  onSwitchProject, onNewProject, onRenameProject, onDeleteProject,
  renamingId, onCommitProjectRename, onCancelProjectRename,
  publishedUrl, publishing, buildStatus, canPublish, onPublish, onUnpublish,
}) {
  const root = useMemo(() => buildTree(files), [files])
  const treeRef = useRef(null)
  const prevOpenRef = useRef(open)
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)
  const [ctx, setCtx] = useState(null)
  const closeCtx = useCallback(() => setCtx(null), [])
  useEffect(() => { if (!open) setCtx(null) }, [open])

  // Swipe-left-to-close, ported faithfully from the Möbius shell Drawer:
  // touchstart captures the origin (only when open + a single touch),
  // touchmove drags the panel 1:1 with the finger while the gesture is
  // dominantly horizontal-left, touchend either closes (≥70px past origin
  // AND horizontal-dominant) or snaps back. The CSS transition is disabled
  // mid-drag via `ws-file-drawer--dragging` so the panel tracks the finger
  // without easing; clearing the class lets the normal transform-transition
  // animate the snap/close. The scrim-click-to-close path is untouched.
  const drawerRef = useRef(null)
  const dragStart = useRef(null) // { x, y } or null

  const onDrawerTouchStart = useCallback((e) => {
    if (!open || e.touches.length !== 1) return
    dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }, [open])

  const onDrawerTouchMove = useCallback((e) => {
    if (!dragStart.current || e.touches.length !== 1) return
    const dx = e.touches[0].clientX - dragStart.current.x
    const dy = e.touches[0].clientY - dragStart.current.y
    if (dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      const el = drawerRef.current
      if (!el) return
      el.classList.add('ws-file-drawer--dragging')
      el.style.transform = `translateX(${Math.max(dx, -el.offsetWidth)}px)`
    }
  }, [])

  const onDrawerTouchEnd = useCallback((e) => {
    if (!dragStart.current) return
    const t = e.changedTouches[0]
    const dx = t.clientX - dragStart.current.x
    const dy = t.clientY - dragStart.current.y
    const shouldClose = dx < -70 && Math.abs(dx) > Math.abs(dy) * 1.35
    const el = drawerRef.current
    if (el) {
      el.classList.remove('ws-file-drawer--dragging')
      if (shouldClose) {
        // Animate from the drag position to closed, then clear the inline
        // transform after the transition so the next open doesn't start from
        // an inline translateX(-100%) that conflicts with the --open class.
        el.style.transform = 'translateX(-100%)'
        const cleanup = () => {
          if (el) el.style.transform = ''
          el.removeEventListener('transitionend', cleanup)
        }
        el.addEventListener('transitionend', cleanup, { once: true })
      } else {
        // Snap back: clearing the inline transform lets the .ws-file-drawer
        // --open class's translateX(0) take over with the transition running
        // from the drag position.
        el.style.transform = ''
      }
    }
    dragStart.current = null
    if (shouldClose) onClose?.()
  }, [onClose])

  // touchcancel positions are unreliable across browsers; treat cancel as
  // "snap back, don't close" — never evaluate the close threshold on cancel.
  const onDrawerTouchCancel = useCallback(() => {
    const el = drawerRef.current
    if (el) {
      el.classList.remove('ws-file-drawer--dragging')
      el.style.transform = ''
    }
    dragStart.current = null
  }, [])

  const treeItems = useCallback(() => {
    if (!treeRef.current) return []
    return Array.from(treeRef.current.querySelectorAll('[role="treeitem"]'))
  }, [])

  const focusTreeItem = useCallback((item) => {
    if (item && typeof item.focus === 'function') item.focus()
  }, [])

  const focusSelectedOrFirst = useCallback(() => {
    const items = treeItems()
    if (items.length === 0) return
    const selected = selectedPath
      ? items.find((item) => item.getAttribute('data-tree-path') === selectedPath)
      : null
    focusTreeItem(selected || items[0])
  }, [focusTreeItem, selectedPath, treeItems])

  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (open && !wasOpen) {
      const raf = requestAnimationFrame(focusSelectedOrFirst)
      return () => cancelAnimationFrame(raf)
    }
    if (!open && wasOpen) {
      returnFocusRef?.current?.focus?.()
    }
  }, [focusSelectedOrFirst, open, returnFocusRef])

  const handleTreeFocus = useCallback((event) => {
    if (event.target === treeRef.current) focusSelectedOrFirst()
  }, [focusSelectedOrFirst])

  const handleTreeKeyDown = useCallback((event) => {
    if (event.defaultPrevented) return
    const current = event.target.closest?.('[role="treeitem"]')
    if (!current || !treeRef.current?.contains(current)) return
    const items = treeItems()
    const index = items.indexOf(current)
    if (index < 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusTreeItem(items[Math.min(index + 1, items.length - 1)])
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusTreeItem(items[Math.max(index - 1, 0)])
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusTreeItem(items[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      focusTreeItem(items[items.length - 1])
    } else if (event.key === 'ArrowRight') {
      if (current.getAttribute('aria-expanded') === 'true') {
        const level = Number(current.getAttribute('aria-level') || '0')
        const child = items.slice(index + 1).find((item) => (
          Number(item.getAttribute('aria-level') || '0') > level
        ))
        if (child) {
          event.preventDefault()
          focusTreeItem(child)
        }
      }
    } else if (event.key === 'ArrowLeft') {
      const ppath = current.getAttribute('data-parent-path')
      if (ppath) {
        const parent = items.find((item) => item.getAttribute('data-tree-path') === ppath)
        if (parent) {
          event.preventDefault()
          focusTreeItem(parent)
        }
      }
    }
  }, [focusTreeItem, treeItems])

  // Context actions. An HTML file additionally offers "Set as main page"
  // (unless it already is) so the user can pick which page the preview renders.
  const ctxItems = ctx ? [
    ...(!ctx.isFolder && isHtmlDoc(ctx.path) && ctx.path !== mainPath
      ? [{ label: 'Set as main page', onSelect: () => onSetMain(ctx.path) }]
      : []),
    { label: 'Move to...', onSelect: () => onMoveTo(ctx.path) },
    { label: 'Rename', onSelect: () => onRename(ctx.path) },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => (ctx.isFolder ? onDeleteFolder(ctx.path) : onDeleteFile(ctx.path)),
    },
  ] : []

  return (
    <>
      <div
        className={`ws-drawer-scrim ${open ? 'ws-drawer-scrim--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={drawerRef}
        className={`ws-file-drawer ${open ? 'ws-file-drawer--open' : ''}`}
        aria-label="File tree"
        aria-hidden={!open}
        onTouchStart={onDrawerTouchStart}
        onTouchMove={onDrawerTouchMove}
        onTouchEnd={onDrawerTouchEnd}
        onTouchCancel={onDrawerTouchCancel}
      >
        <div className="ws-project-row">
          <ProjectSelector
            projects={projects}
            projectsLoaded={projectsLoaded}
            activeProjectId={activeProjectId}
            onSwitchProject={onSwitchProject}
            renamingId={renamingId}
            onCommitRename={onCommitProjectRename}
            onCancelRename={onCancelProjectRename}
          />
          <div className="ws-project-row-actions">
            <button className="ws-icon-btn" onClick={onNewProject} disabled={!projectsLoaded} title="New project" aria-label="New project"><PlusIcon size={18} /></button>
            <button className="ws-icon-btn" onClick={() => onRenameProject(activeProjectId)} disabled={!projectsLoaded} title="Rename project" aria-label="Rename project"><PencilIcon size={15} /></button>
            <button className="ws-icon-btn ws-icon-btn--danger" onClick={() => onDeleteProject(activeProjectId)} disabled={!projectsLoaded || activeProjectId === DEFAULT_PROJECT.id || projects.length <= 1} title="Delete project" aria-label="Delete project"><TrashIcon size={15} /></button>
          </div>
        </div>
        <PublishDrawerAction
          publishedUrl={publishedUrl}
          publishing={publishing}
          canPublish={canPublish}
          onPublish={onPublish}
          onUnpublish={onUnpublish}
        />
        <div className="ws-drawer-actions">
          <span className="ws-files-label">Files</span>
          <div className="ws-files-actions">
            <button className="ws-icon-btn" onClick={onCreateFile} disabled={!canMutate} title="New file" aria-label="New file"><NewFileIcon size={17} /></button>
            <button className="ws-icon-btn" onClick={onCreateFolder} disabled={!canMutate} title="New folder" aria-label="New folder"><NewFolderIcon size={17} /></button>
            <button className="ws-icon-btn" onClick={() => fileInputRef.current && fileInputRef.current.click()} disabled={!canMutate} title="Upload files" aria-label="Upload files"><UploadIcon size={17} /></button>
            {/* Upload folder: the only trigger for folderInputRef (webkitdirectory).
                Without it the folder-upload input below was unreachable dead code.
                A trailing "/" marks it as the folder variant of Upload. */}
            <button className="ws-icon-btn ws-icon-btn--folder-up" onClick={() => folderInputRef.current && folderInputRef.current.click()} disabled={!canMutate} title="Upload folder" aria-label="Upload folder"><UploadIcon size={17} /><span aria-hidden="true">/</span></button>
          </div>
          {/* Hidden file/folder pickers. Materialise the FileList into a real
              array SYNCHRONOUSLY before resetting input.value: onUpload is async
              (it awaits before reading the list), and `e.target.value = ''`
              empties the live FileList the input still owns. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fl = Array.from(e.target.files || [])
              e.target.value = ''
              onUpload(fl, { asFolder: false })
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            style={{ display: 'none' }}
            onChange={(e) => {
              const fl = Array.from(e.target.files || [])
              e.target.value = ''
              onUpload(fl, { asFolder: true })
            }}
          />
        </div>
        {!canMutate && (
          <div className="ws-drawer-syncing" role="status">
            Loading your files… add, upload, and delete unlock once they sync.
          </div>
        )}
        <div
          ref={treeRef}
          className="ws-drawer-tree"
          role="tree"
          aria-label="Project files"
          tabIndex={0}
          onFocus={handleTreeFocus}
          onKeyDown={handleTreeKeyDown}
        >
          {files.length === 0 ? (
            canMutate ? (
              <div className="ws-drawer-empty">
                Upload a file, or open the project chat to tell the agent what to build.
              </div>
            ) : null
          ) : (
            <FileNode
              node={(root.children.size === 1 && root.children.has('files')) ? root.children.get('files') : root}
              selectedPath={selectedPath}
              onSelect={(p) => { onSelect(p); onClose() }}
              depth={-1}
              onContextMenu={setCtx}
              onMoveInto={onMove}
              mainPath={mainPath}
              onSetMain={onSetMain}
              openMenuPath={ctx ? ctx.path : null}
            />
          )}
        </div>
        {ctx && (
          <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onClose={closeCtx} />
        )}
      </aside>
    </>
  )
}

// ----------------------------------------------------------------------
// Embedded shell chat. The runtime mounts the real ChatView into an
// iframe, so this app does not duplicate SSE handling, composer state,
// attachments, provider controls, queueing, or polling.
