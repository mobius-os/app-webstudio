import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  Code,
  FileCode,
  FileDocument,
  FilePresentation,
  Grid,
  Plus,
  WebsiteNetwork,
} from '@openai/apps-sdk-ui/components/Icon'

const TEMPLATES = [
  { id: 'website', label: 'Website', name: 'Untitled website', icon: WebsiteNetwork },
  { id: 'mini-app', label: 'Mini-app', name: 'Untitled mini-app', icon: FileCode },
  { id: 'visualization', label: 'Visualization', name: 'Untitled visualization', icon: Grid },
  { id: 'document', label: 'Document', name: 'Untitled document', icon: FileDocument },
  { id: 'spreadsheet', label: 'Spreadsheet', name: 'Untitled spreadsheet', icon: Grid },
  { id: 'presentation', label: 'Presentation', name: 'Untitled presentation', icon: FilePresentation },
]

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
.wsx-types { display: grid; grid-template-columns: repeat(auto-fit, minmax(126px, 1fr)); gap: 7px; }
.wsx-type { min-width: 0; min-height: 72px; display: grid; justify-items: start; align-content: center; gap: 8px; padding: 10px 11px; border: 1px solid var(--border-light, var(--border)); border-radius: 13px; color: var(--text); background: var(--surface); font: inherit; text-align: left; cursor: pointer; }
.wsx-type svg { color: var(--accent); }
.wsx-type span { overflow: hidden; max-width: 100%; font-size: 11px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.wsx-type:disabled { cursor: default; opacity: .55; }
.wsx-section { border-top: 1px solid var(--border-light, var(--border)); padding-top: 18px; }
.wsx-section-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 10px; }
.wsx-section-head h2 { margin: 0; font-size: 14px; letter-spacing: -.01em; }
.wsx-secondary { min-height: 40px; padding: 0 8px; border: 0; color: var(--muted); background: transparent; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
.wsx-secondary:hover { color: var(--text); }
.wsx-list { display: grid; gap: 3px; }
.wsx-project { width: 100%; min-height: 44px; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: 10px; color: var(--text); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.wsx-project:hover { background: var(--surface); }
.wsx-project-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.wsx-project-copy { min-width: 0; display: grid; gap: 2px; }
.wsx-project-copy strong, .wsx-project-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsx-project-copy strong { font-size: 13px; }
.wsx-project-copy small { color: var(--muted); font-size: 10px; }
.wsx-project > svg { color: var(--muted); }
.wsx-empty { min-height: 126px; display: grid; place-content: center; justify-items: center; gap: 7px; padding: 20px; border: 1px dashed var(--border-light, var(--border)); border-radius: 13px; color: var(--muted); text-align: center; }
.wsx-empty p { margin: 0; font-size: 12px; line-height: 1.45; }
.wsx-error { margin: 0 0 14px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--danger, #c43d3d) 28%, var(--border)); border-radius: 10px; color: var(--danger, #c43d3d); background: color-mix(in srgb, var(--danger, #c43d3d) 7%, var(--surface)); font-size: 12px; }
.wsx-type:focus-visible, .wsx-secondary:focus-visible, .wsx-project:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 620px) {
  .wsx-shell { padding-top: max(16px, env(safe-area-inset-top)); }
  .wsx-hero { grid-template-columns: 96px minmax(0, 1fr); gap: 14px; padding: 2px 0 18px; }
  .wsx-visual { min-height: 104px; border-radius: 18px; }
  .wsx-window { inset: 18px 12px; }
  .wsx-logo { width: 48px; height: 48px; }
  .wsx-title { font-size: 25px; }
  .wsx-description { margin-top: 8px; font-size: 13px; line-height: 1.45; }
  .wsx-types { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wsx-type { min-height: 54px; gap: 5px; padding-block: 8px; }
  .wsx-create { margin-bottom: 20px; }
}
@media (prefers-reduced-motion: no-preference) {
  .wsx-type, .wsx-project { transition: transform 140ms ease, background 140ms ease, border-color 140ms ease; }
  .wsx-type:hover { border-color: color-mix(in srgb, var(--accent) 34%, var(--border)); transform: translateY(-1px); }
  .wsx-type:active { transform: none; }
}
`

function templateFor(project) {
  return TEMPLATES.find(template => template.id === project?.template?.id) || TEMPLATES[0]
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

  async function createProject(template) {
    if (!projectApi || creatingId) return
    setCreatingId(template.id); setError('')
    try {
      const project = await projectApi.create({ templateId: `webstudio:${template.id}`, name: template.name })
      if (project?.id) await projectApi.open(project.id)
    } catch (cause) { setError(cause?.message || `Could not create a ${template.label.toLowerCase()} project.`) }
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
            <p className="wsx-description">Build websites, mini-apps, interactive visuals, documents, sheets, and presentations in a live project workspace.</p>
          </div>
        </section>

        <section className="wsx-create" aria-labelledby="wsx-create-title">
          <span id="wsx-create-title">Start a project</span>
          <div className="wsx-types">
            {TEMPLATES.map(template => {
              const Icon = template.icon
              return <button key={template.id} type="button" className="wsx-type" disabled={!!creatingId || !projectApi} onClick={() => void createProject(template)}><Icon size={19} aria-hidden="true" /><span>{creatingId === template.id ? 'Creating…' : template.label}</span></button>
            })}
          </div>
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
            <div className="wsx-empty"><Plus size={25} aria-hidden="true" /><p>Choose a format above to start building.</p></div>
          ) : (
            <div className="wsx-list">
              {rows.map(project => {
                const template = templateFor(project)
                const Icon = template.icon || Code
                return <button key={project.id} type="button" className="wsx-project" onClick={() => projectApi?.open(project.id)}>
                  <span className="wsx-project-icon" aria-hidden="true"><Icon size={16} /></span>
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
