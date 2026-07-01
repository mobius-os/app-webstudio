import { useEffect, useRef, useState } from 'react'
import { DEFAULT_PROJECT } from '../constants.js'
import { ChevronIcon } from './ChevronIcon.jsx'

export function ProjectSelector({
  projects, projectsLoaded, activeProjectId,
  onSwitchProject, renamingId, onCommitRename, onCancelRename,
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const inputRef = useRef(null)
  // Set when Enter/Escape already resolved the edit, so the blur that fires as
  // the input unmounts does not commit a second (or, on Escape, a cancelled) value.
  const skipBlurRef = useRef(false)
  const active = projects.find((p) => p.id === activeProjectId) || projects[0] || DEFAULT_PROJECT

  useEffect(() => {
    if (renamingId !== active.id) return
    skipBlurRef.current = false
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [active.id, renamingId])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="ws-project-picker" ref={ref}>
      {renamingId === active.id ? (
        <input
          ref={inputRef}
          className="ws-project-rename-input"
          defaultValue={active.name}
          aria-label="Project name"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { skipBlurRef.current = true; onCommitRename(active.id, e.currentTarget.value) }
            else if (e.key === 'Escape') { skipBlurRef.current = true; onCancelRename() }
          }}
          onBlur={(e) => {
            if (skipBlurRef.current) { skipBlurRef.current = false; return }
            onCommitRename(active.id, e.currentTarget.value)
          }}
        />
      ) : (
        <button
          type="button"
          className="ws-project-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Switch project"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ws-project-trigger-name">{active.name}</span>
          <ChevronIcon size={13} />
        </button>
      )}
      {open && (
        <div className="ws-project-menu" role="menu">
          <div className="ws-project-list" role="group" aria-label="Projects">
            {projectsLoaded ? projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitemradio"
                aria-checked={project.id === activeProjectId}
                className={`ws-project-item ${project.id === activeProjectId ? 'ws-project-item--active' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (project.id !== activeProjectId) onSwitchProject(project.id)
                }}
              >
                <span className="ws-project-item-name">{project.name}</span>
              </button>
            )) : (
              <div className="ws-project-loading">Loading projects...</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
