/* A focused project launcher: resume work first, with creation owned by Projects. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, WebsiteNetwork, Plus, Search } from '@openai/apps-sdk-ui/components/Icon'

const LOCAL_TEMPLATE_ID = 'website'
const CSS = `
* { box-sizing: border-box; }
body { margin: 0; }
.wsx-root { min-height: 100%; color: var(--text); background: var(--bg); font-family: var(--font); }
.wsx-shell { width: min(820px, 100%); margin: 0 auto; padding: 24px clamp(16px, 4vw, 36px) max(28px, env(safe-area-inset-bottom)); }
.wsx-header { display: flex; align-items: center; gap: 16px; }
.wsx-logo { width: 56px; height: 56px; object-fit: contain; flex: 0 0 auto; }
.wsx-header h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -.03em; }
.wsx-description { margin: 8px 0 0; max-width: 52ch; font-size: 14px; line-height: 1.5; color: var(--muted); }
.wsx-primary { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; border: 0; border-radius: 10px; color: var(--accent-fg, white); background: var(--accent); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.wsx-create { margin: 24px 0 28px; }
.wsx-section { border-top: 1px solid var(--border); padding-top: 12px; }
.wsx-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wsx-section-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
.wsx-secondary { min-height: 44px; padding: 0 8px; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
.wsx-secondary:hover { color: var(--text); background: var(--surface); border-radius: 8px; }
.wsx-search { display: flex; gap: 10px; align-items: center; min-height: 44px; padding: 0 12px; margin: 10px 0 12px; border: 1px solid var(--border); border-radius: 10px; color: var(--muted); background: var(--surface); }
.wsx-search input { width: 100%; min-width: 0; min-height: 44px; padding: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 14px; }
.wsx-search:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.wsx-search input::placeholder { color: var(--muted); }
.wsx-list { display: grid; gap: 4px; }
.wsx-project { width: 100%; min-height: 60px; display: flex; align-items: center; gap: 12px; padding: 8px; border: 0; border-radius: 10px; color: var(--text); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.wsx-project:hover { background: var(--surface); }
.wsx-project-icon { width: 36px; height: 36px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--project-row-accent, var(--text)) 25%, var(--border)); border-radius: 10px; color: var(--project-row-accent, var(--text)); background: var(--surface); }
.wsx-project-copy { min-width: 0; flex: 1; display: grid; gap: 4px; }
.wsx-project-copy strong { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsx-project-copy small { font-size: 12px; color: var(--muted); }
.wsx-project > svg { color: var(--muted); flex-shrink: 0; }
.wsx-empty { padding: 28px 8px; color: var(--muted); font-size: 14px; line-height: 1.5; }
.wsx-empty p { margin: 0 0 8px; }
.wsx-error { color: var(--danger); font-size: 14px; line-height: 1.5; }
.wsx-error p { margin: 8px 0; }
.wsx-primary:focus-visible, .wsx-secondary:focus-visible, .wsx-project:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.wsx-root button:disabled { cursor: default; opacity: .55; }
.wsx-root ::selection { color: var(--text); background: var(--accent-dim, var(--surface)); }
@media (max-width: 520px) {
  .wsx-shell { padding-top: 20px; }
  .wsx-header { align-items: flex-start; gap: 12px; }
  .wsx-logo { width: 48px; height: 48px; }
  .wsx-header h1 { font-size: 25px; }
  .wsx-primary { width: 100%; }
}
`

export default function App({ appId }) {
  const projectApi = window.mobius?.projects
  const [projects, setProjects] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  const refresh = useCallback(async ({ migrate = false } = {}) => {
    if (!projectApi?.templates) { setLoadError('Refresh Möbius to load Projects support.'); setLoading(false); return }
    setLoading(true)
    setLoadError('')
    try {
      const [rows, types] = await Promise.all([
        migrate ? projectApi.migrate() : projectApi.list(),
        projectApi.templates(),
      ])
      const websites = rows.filter(row => row.template?.id === LOCAL_TEMPLATE_ID)
      setProjects(websites)
      setTemplates(types)
      window.mobius?.signal?.('app_ready', { item_count: websites.length })
    } catch (cause) {
      setLoadError(cause?.message || 'Could not load your projects. Try again.')
    } finally { setLoading(false) }
  }, [projectApi])
  useEffect(() => { void refresh({ migrate: true }) }, [refresh])

  async function createProject() {
    const template = templates.find(row => row.id === LOCAL_TEMPLATE_ID)
    if (!template || creating) return
    setCreating(true); setError('')
    try {
      await projectApi.create({ templateId: template.key, name: 'Untitled website' })
      window.mobius?.signal?.('item_created', { type: 'website' })
    } catch (cause) { setError(cause?.message || 'Could not create your website. Try again.') }
    finally { setCreating(false) }
  }
  async function openProject(id) {
    setError('')
    try { await projectApi.open(id) }
    catch (cause) { setError(cause?.message || 'Could not open this project. Refresh the list and try again.') }
  }
  const rows = useMemo(() => [...projects].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    .filter(row => row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [projects, search])
  const canCreate = templates.some(row => row.id === LOCAL_TEMPLATE_ID)
  return (
    <main className="wsx-root">
      <style>{CSS}</style>
      <div className="wsx-shell">
        <header className="wsx-header">
          <img className="wsx-logo" src={`/api/apps/${appId}/icon`} alt="" />
          <div><h1>Web Studio</h1><p className="wsx-description">Build a website with project chats, source files and a live preview.</p></div>
        </header>
        <div className="wsx-create">
          <button type="button" className="wsx-primary" disabled={creating || !canCreate} onClick={() => void createProject()}><Plus width={18} height={18} aria-hidden="true" />{creating ? 'Creating…' : 'New website'}</button>
          {!loading && !loadError && !canCreate && <p className="wsx-error" role="alert">This project type is unavailable. Refresh the list or check the app installation.</p>}
        </div>
        {error && <p className="wsx-error" role="alert">{error}</p>}
        <section className="wsx-section" aria-labelledby="wsx-projects-title">
          <header className="wsx-section-head"><h2 id="wsx-projects-title">Your websites</h2><button type="button" className="wsx-secondary" disabled={loading} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh'}</button></header>
          {loadError && <div className="wsx-error" role="alert"><p>{loadError}</p><button type="button" className="wsx-secondary" onClick={() => void refresh()}>Try again</button></div>}
          {projects.length > 0 && <label className="wsx-search"><Search width={18} height={18} aria-hidden="true" /><input type="search" aria-label="Find a website" placeholder="Find a website" value={search} onChange={event => setSearch(event.target.value)} /></label>}
          {loading && projects.length === 0 ? <p className="wsx-empty" role="status">Loading your websites…</p>
            : !loadError && projects.length === 0 ? <div className="wsx-empty"><p>Your website projects will appear here.</p><p>Start one above, then use its chat to describe what you want to make.</p></div>
            : rows.length === 0 && projects.length > 0 ? <div className="wsx-empty"><p>No websites match “{search}”.</p><button className="wsx-secondary" onClick={() => setSearch('')}>Clear search</button></div>
            : <div className="wsx-list">{rows.map(project => {
              const date = new Date(project.updated_at || '')
              return <button type="button" className="wsx-project" key={project.id} onClick={() => void openProject(project.id)}>
                <span className="wsx-project-icon" aria-hidden="true" style={{ '--project-row-accent': /^#[0-9a-f]{6}$/i.test(project.color || '') ? project.color : 'var(--text)' }}><WebsiteNetwork width={18} height={18} /></span>
                <span className="wsx-project-copy"><strong>{project.name}</strong><small>{Number.isNaN(date.getTime()) ? 'Website' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span>
                <ChevronRight width={16} height={16} aria-hidden="true" />
              </button>
            })}</div>}
        </section>
      </div>
    </main>
  )
}
