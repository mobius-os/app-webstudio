import { useCallback, useState } from 'react'
import { isHtmlDoc } from '../domain.js'
import { ChevronIcon } from './ChevronIcon.jsx'
import { FileGlyph } from './FileGlyph.jsx'
import { KebabIcon } from './KebabIcon.jsx'
import { useLongPress } from './useLongPress.js'

export function FileNode({
  node, selectedPath, onSelect, depth,
  onContextMenu, onMoveInto, mainPath, onSetMain, openMenuPath, parentPath = '',
}) {
  const [expanded, setExpanded] = useState(true)
  const [dropActive, setDropActive] = useState(false)
  const isFolder = !(node.children.size === 0 && node.isFile)
  const longPress = useLongPress((cx, cy) => {
    onContextMenu({ x: cx, y: cy, path: node.path, isFolder })
  })
  // Open the per-item action menu (Set main / Rename / Delete) anchored at the
  // kebab button. Same menu the right-click / long-press gesture opens — the
  // visible ⋯ button just makes those actions discoverable on touch.
  const openMenuFromButton = useCallback((e, isFolderItem) => {
    e.preventDefault()
    e.stopPropagation()
    // Toggle: a second press on this row's kebab closes its menu. The
    // ContextMenu's outside-close ignores [data-popover-trigger], so it can't
    // close-then-reopen on the same press (the old toggle-never-fires bug).
    if (openMenuPath === node.path) { onContextMenu(null); return }
    const r = e.currentTarget.getBoundingClientRect()
    onContextMenu({ x: r.right, y: r.bottom, path: node.path, isFolder: isFolderItem })
  }, [openMenuPath, node.path, onContextMenu])
  if (node.children.size === 0 && node.isFile) {
    const selected = node.path === selectedPath
    const isMain = node.path === mainPath
    const isHtml = isHtmlDoc(node.path)
    // Discoverable "set as main page" affordance: a visible accent-dot button
    // on every HTML page that isn't already the main page, alongside the
    // existing context-menu path (which still works). It is a SIBLING of the
    // row <button> (next to the kebab), not nested inside it: focusable content
    // inside a <button> is invalid HTML and pollutes the tree's roving-tabindex
    // (the row buttons are tabIndex={-1}). We stop propagation so tapping it
    // sets main without also selecting/opening the file.
    const activateSetMain = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (onSetMain) onSetMain(node.path)
    }
    return (
      <div className="ws-tree-row">
        <button
          type="button"
          className={`ws-tree-file ${selected ? 'ws-tree-file--selected' : ''}`}
          style={{ paddingLeft: `${10 + depth * 16}px` }}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selected}
          tabIndex={-1}
          data-tree-path={node.path}
          data-parent-path={parentPath}
          data-tree-kind="file"
          onClick={() => onSelect(node.path)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/mobius-path', node.path)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isFolder: false })
          }}
          {...longPress}
        >
          <span className="ws-tree-icon"><FileGlyph name={node.name} /></span>
          <span className="ws-tree-name">{node.name}</span>
          {/* One compact accent dot marks the main page (the preview renders
              it) — no text chip. */}
          {isMain && (
            <span
              className="ws-tree-main-dot"
              role="img"
              aria-label="Main page (preview renders this)"
              title="Preview renders this page"
            />
          )}
        </button>
        {isHtml && !isMain && onSetMain && (
          <button
            type="button"
            className="ws-tree-set-main"
            aria-label="Set as main page"
            title="Set as main page (the preview will render this page)"
            onClick={activateSetMain}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') activateSetMain(e) }}
          >
            <span className="ws-tree-set-main-dot" />
          </button>
        )}
        <button
          type="button"
          className="ws-tree-menu-btn" data-popover-trigger=""
          data-state={openMenuPath === node.path ? 'open' : 'closed'}
          aria-label={`Actions for ${node.name}`}
          aria-haspopup="menu"
          aria-expanded={openMenuPath === node.path}
          title="File actions"
          onClick={(e) => openMenuFromButton(e, false)}
        >
          <KebabIcon />
        </button>
      </div>
    )
  }
  // Folder node — own row plus indented children. We filter `.keep` entries
  // before sorting: those exist only so empty folders survive a backend that
  // has no mkdir endpoint (handleCreateFolder writes `files/<name>/.keep`).
  const sortedChildren = [...node.children.values()]
    .filter((c) => !(c.isFile && c.name === '.keep'))
    .sort((a, b) => {
      const af = a.children.size > 0 && !a.isFile
      const bf = b.children.size > 0 && !b.isFile
      if (af !== bf) return af ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  const dropMove = (e, destDir) => {
    e.preventDefault()
    // The folder onDrop is a DOM descendant of the root container's onDrop, so a
    // drop onto a folder would otherwise bubble up and run the root move too —
    // targeting the already-moved source path and 404ing. Stop propagation here.
    e.stopPropagation()
    setDropActive(false)
    const from = e.dataTransfer.getData('text/mobius-path')
    if (!from) return
    const leaf = from.split('/').pop()
    const base = destDir || 'files'
    onMoveInto(from, `${base}/${leaf}`)
  }

  if (depth < 0) {
    return (
      <div
        className={`ws-tree-root ${dropActive ? 'ws-tree-drop-active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropActive(true) }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => dropMove(e, node.path)}
      >
        {sortedChildren.map((c) => (
          <FileNode
            key={c.path}
            node={c}
            selectedPath={selectedPath}
            onSelect={onSelect}
            depth={0}
            onContextMenu={onContextMenu}
            onMoveInto={onMoveInto}
            mainPath={mainPath}
            onSetMain={onSetMain}
            openMenuPath={openMenuPath}
            parentPath=""
          />
        ))}
      </div>
    )
  }
  return (
    <>
      <div className="ws-tree-row">
        <button
          type="button"
          className={`ws-tree-folder ${dropActive ? 'ws-tree-drop-active' : ''}`}
          style={{ paddingLeft: `${10 + depth * 16}px` }}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={expanded}
          tabIndex={-1}
          data-tree-path={node.path}
          data-parent-path={parentPath}
          data-tree-kind="folder"
          onClick={() => setExpanded((e) => !e)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' && !expanded) {
              e.preventDefault()
              setExpanded(true)
            } else if (e.key === 'ArrowLeft' && expanded) {
              e.preventDefault()
              setExpanded(false)
            }
          }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropActive(true) }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(e) => dropMove(e, node.path)}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isFolder: true })
          }}
          {...longPress}
        >
          <span className={`ws-tree-icon ws-tree-chevron ${expanded ? 'ws-tree-chevron--open' : ''}`}>
            <ChevronIcon />
          </span>
          <span className="ws-tree-name">{node.name}/</span>
        </button>
        <button
          type="button"
          className="ws-tree-menu-btn" data-popover-trigger=""
          data-state={openMenuPath === node.path ? 'open' : 'closed'}
          aria-label={`Actions for ${node.name} folder`}
          aria-haspopup="menu"
          aria-expanded={openMenuPath === node.path}
          title="Folder actions"
          onClick={(e) => openMenuFromButton(e, true)}
        >
          <KebabIcon />
        </button>
      </div>
      {expanded && (
        <div role="group" className="ws-tree-group">
          {sortedChildren.map((c) => (
            <FileNode
              key={c.path}
              node={c}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              onMoveInto={onMoveInto}
              mainPath={mainPath}
              onSetMain={onSetMain}
              openMenuPath={openMenuPath}
              parentPath={node.path}
            />
          ))}
        </div>
      )}
    </>
  )
}
