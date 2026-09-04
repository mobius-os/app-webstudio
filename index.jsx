import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  Code,
  FileCode,
  FileDocument,
  FilePresentation,
  Grid,
  WebsiteNetwork,
} from '@openai/apps-sdk-ui/components/Icon'

// The only creatable format for now is a website. The other formats stay in
// the map so recent projects made earlier still show the right icon and label,
// but they are no longer offered in the create surface.
const TYPES = {
  website: { id: 'website', label: 'Website', name: 'Untitled website', icon: WebsiteNetwork },
  'mini-app': { id: 'mini-app', label: 'Mini-app', name: 'Untitled mini-app', icon: FileCode },
  visualization: { id: 'visualization', label: 'Visualization', name: 'Untitled visualization', icon: Grid },
  document: { id: 'document', label: 'Document', name: 'Untitled document', icon: FileDocument },
  spreadsheet: { id: 'spreadsheet', label: 'Spreadsheet', name: 'Untitled spreadsheet', icon: Grid },
  presentation: { id: 'presentation', label: 'Presentation', name: 'Untitled presentation', icon: FilePresentation },
}
const WEBSITE = TYPES.website

const CSS = `
* { box-sizing: border-box; }
html, body, #root { min-height: 100%; }
body { margin: 0; }
.wsx-root { min-height: 100%; color: var(--text); background: var(--bg); font-family: var(--font); }
.wsx-shell { width: min(980px, 100%); margin: 0 auto; padding: max(20px, env(safe-area-inset-top)) clamp(16px, 5vw, 44px) max(28px, env(safe-area-inset-bottom)); }
.wsx-hero { display: grid; grid-template-columns: 210px minmax(0, 1fr); align-items: center; gap: clamp(24px, 6vw, 58px); padding: clamp(12px, 3vw, 26px) 0 clamp(25px, 5vw, 40px); }
.wsx-visual { position: relative; min-height: 220px; display: grid; place-items: center; overflow: hidden; border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border-light, var(--border))); border-radius: 24px; background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
.wsx-window { position: absolute; inset: 35px 22px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--accent) 17%, var(--border)); border-radius: 11px; background: var(--bg); box-shadow: 0 16px 42px color-mix(in srgb, var(--accent) 14%, transparent); transform: rotate(-3deg); }
.wsx-window::before { content: '•••'; display: block; height: 24px; padding: 1px 9px; border-bottom: 1px solid var(--border-light, var(--border)); color: color-mix(in srgb, var(--accent) 50%, var(--muted)); font: 17px/17px ui-monospace, monospace; letter-spacing: 2px; }
.wsx-window::after { content: ''; position: absolute; top: 46px; left: 16px; width: 58%; height: 7px; border-radius: 5px; background: color-mix(in srgb, var(--accent) 28%, transparent); box-shadow: 0 19px 0 color-mix(in srgb, var(--muted) 18%, transparent), 0 38px 0 color-mix(in srgb, var(--muted) 13%, transparent), 84px 38px 0 color-mix(in srgb, var(--accent) 16%, transparent); }
.wsx-logo { position: relative; z-index: 2; width: 88px; height: 88px; object-fit: contain; filter: drop-shadow(0 12px 18px color-mix(in srgb, var(--accent) 20%, transparent)); }
.wsx-copy { min-width: 0; }
.wsx-title { margin: 0; font-size: clamp(28px, 5vw, 42px); line-height: 1; letter-spacing: -.045em; font-weight: 680; }
.wsx-description { max-width: 50ch; margin: 14px 0 0; color: var(--muted); font-size: 15px; line-height: 1.55; }
.wsx-create { margin-bottom: clamp(30px, 5vw, 46px); }
.wsx-create > span { display: block; margin-bottom: 9px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.wsx-create-primary { width: 100%; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 15px 16px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); border-radius: 15px; color: var(--text); background: color-mix(in srgb, var(--accent) 8%, var(--surface)); font: inherit; text-align: left; cursor: pointer; }
.wsx-create-primary > svg:first-child { justify-self: center; width: 44px; height: 44px; padding: 11px; border-radius: 12px; color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface)); }
.wsx-create-primary-copy { min-width: 0; display: grid; gap: 2px; }
.wsx-create-primary-copy strong { font-size: 15px; font-weight: 680; letter-spacing: -.01em; }
.wsx-create-primary-copy small { color: var(--muted); font-size: 12px; }
.wsx-create-primary > svg:last-child { color: var(--muted); }
.wsx-create-primary:disabled { cursor: default; opacity: .6; }
.wsx-section { border-top: 1px solid var(--border-light, var(--border)); padding-top: 18px; }
.wsx-section-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 10px; }
.wsx-section-head h2 { margin: 0; font-size: 14px; letter-spacing: -.01em; }
.wsx-secondary { min-height: 40px; padding: 0 8px; border: 0; color: var(--muted); background: transparent; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
.wsx-secondary:hover { color: var(--text); }
.wsx-list { display: grid; gap: 3px; }
.wsx-project { width: 100%; min-height: 44px; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: 10px; color: var(--text); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.wsx-project:hover { background: var(--surface); }
.wsx-project-icon { width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--project-row-accent, var(--text)) 22%, var(--border)); border-radius: 8px; color: color-mix(in srgb, var(--project-row-accent, var(--text)) 72%, var(--text)); background: color-mix(in srgb, var(--project-row-accent, var(--text)) 7%, var(--surface)); }
.wsx-project-copy { min-width: 0; display: grid; gap: 2px; }
.wsx-project-copy strong, .wsx-project-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsx-project-copy strong { font-size: 13px; }
.wsx-project-copy small { color: var(--muted); font-size: 10px; }
.wsx-project > svg { color: var(--muted); }
.wsx-empty { min-height: 126px; display: grid; place-content: center; justify-items: center; gap: 7px; padding: 20px; border: 1px dashed var(--border-light, var(--border)); border-radius: 13px; color: var(--muted); text-align: center; }
.wsx-empty p { margin: 0; font-size: 12px; line-height: 1.45; }
.wsx-error { margin: 0 0 14px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--danger, #c43d3d) 28%, var(--border)); border-radius: 10px; color: var(--danger, #c43d3d); background: color-mix(in srgb, var(--danger, #c43d3d) 7%, var(--surface)); font-size: 12px; }
.wsx-create-primary:focus-visible, .wsx-secondary:focus-visible, .wsx-project:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 620px) {
  .wsx-shell { padding-top: max(16px, env(safe-area-inset-top)); }
  .wsx-hero { grid-template-columns: 96px minmax(0, 1fr); gap: 14px; padding: 2px 0 18px; }
  .wsx-visual { min-height: 104px; border-radius: 18px; }
  .wsx-window { inset: 18px 12px; }
  .wsx-logo { width: 48px; height: 48px; }
  .wsx-title { font-size: 25px; }
  .wsx-description { margin-top: 8px; font-size: 13px; line-height: 1.45; }
  .wsx-create { margin-bottom: 20px; }
  .wsx-create-primary { padding: 13px 14px; gap: 12px; }
}
@media (prefers-reduced-motion: no-preference) {
  .wsx-create-primary, .wsx-project { transition: transform 140ms ease, background 140ms ease, border-color 140ms ease; }
  .wsx-create-primary:hover:not(:disabled) { border-color: color-mix(in srgb, var(--accent) 46%, var(--border)); transform: translateY(-1px); }
  .wsx-create-primary:active { transform: none; }
}
`

function templateFor(project) {
  return TYPES[project?.template?.id] || WEBSITE
}

function projectSubtitle(project) {
  const template = templateFor(project)
  const updated = project?.updated_at ? new Date(project.updated_at) : null
  if (!updated || Number.isNaN(updated.getTime())) return `${template.label} project`
  return `${template.label} · Updated ${updated.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export default function App({ appId }) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [creatingId, setCreatingId] = useState('')
  const [error, setError] = useState('')
  const projectApi = window.mobius?.projects
  const logoUrl = `/api/apps/${appId}/icon`

  const refresh = useCallback(async ({ migrate = false } = {}) => {
    if (!projectApi) { setError('Projects need a newer Möbius shell.'); setLoading(false); return }
    setError('')
    try {
      const rows = migrate && typeof projectApi.migrate === 'function' ? await projectApi.migrate() : await projectApi.list()
      setProjects(Array.isArray(rows) ? rows : [])
    } catch (cause) { setError(cause?.message || 'Projects are unavailable right now.') }
    finally { setLoading(false) }
  }, [projectApi])

  useEffect(() => { void refresh({ migrate: true }) }, [refresh])

  async function createWebsite() {
    if (!projectApi || creatingId) return
    setCreatingId(WEBSITE.id); setError('')
    try {
      await projectApi.create({ templateId: `webstudio:${WEBSITE.id}`, name: WEBSITE.name })
    } catch (cause) { setError(cause?.message || 'Could not create a website project.') }
    finally { setCreatingId('') }
  }

  const rows = useMemo(() => [...projects].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0)), [projects])

  return (
    <main className="wsx-root">
      <style>{CSS}</style>
      <div className="wsx-shell">
        <section className="wsx-hero" aria-labelledby="wsx-title">
          <div className="wsx-visual" aria-hidden="true">
            <span className="wsx-window" />
            <img className="wsx-logo" src={logoUrl} alt="" />
          </div>
          <div className="wsx-copy">
            <h1 className="wsx-title" id="wsx-title">Web Studio</h1>
            <p className="wsx-description">Build and publish websites as live projects, each with a buildable artifact you can open on its own.</p>
          </div>
        </section>

        <section className="wsx-create" aria-labelledby="wsx-create-title">
          <span id="wsx-create-title">Start building</span>
          <button type="button" className="wsx-create-primary" disabled={!!creatingId || !projectApi} onClick={() => void createWebsite()}>
            <WebsiteNetwork size={22} aria-hidden="true" />
            <span className="wsx-create-primary-copy">
              <strong>{creatingId ? 'Creating…' : 'New website'}</strong>
              <small>Start from a clean website project</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </section>

        {error && <p className="wsx-error" role="alert">{error}</p>}

        <section className="wsx-section" aria-labelledby="wsx-projects-title">
          <div className="wsx-section-head">
            <h2 id="wsx-projects-title">Recent projects</h2>
            <button type="button" className="wsx-secondary" disabled={!projectApi} onClick={() => projectApi?.browse()}>View all Projects</button>
          </div>
          {loading ? (
            <div className="wsx-empty" role="status"><p>Loading projects…</p></div>
          ) : rows.length === 0 ? (
            <div className="wsx-empty"><WebsiteNetwork size={24} aria-hidden="true" /><p>Create a website above to get started.</p></div>
          ) : (
            <div className="wsx-list">
              {rows.map(project => {
                const template = templateFor(project)
                const Icon = template.icon || Code
                return <button key={project.id} type="button" className="wsx-project" onClick={() => projectApi?.open(project.id)}>
                  <span className="wsx-project-icon" aria-hidden="true" style={{ '--project-row-accent': /^#[0-9a-f]{6}$/i.test(project.color || '') ? project.color : 'var(--text)' }}><Icon size={16} /></span>
                  <span className="wsx-project-copy"><strong>{project.name}</strong><small>{projectSubtitle(project)}</small></span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
