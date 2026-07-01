import { CopyIcon } from './CopyIcon.jsx'
import { PublishIcon } from './PublishIcon.jsx'
import { UnpublishIcon } from './UnpublishIcon.jsx'

export function PublishDrawerAction({
  publishedUrl, publishing, canPublish, onPublish, onUnpublish,
}) {
  return (
    <div className="ws-drawer-publish" aria-label="Publish">
      {publishedUrl ? (
        <>
          <div className="ws-drawer-publish-url">{publishedUrl}</div>
          <div className="ws-drawer-publish-actions">
            <button
              type="button"
              className="ws-drawer-publish-btn"
              onClick={() => navigator.clipboard?.writeText(publishedUrl).catch(() => {})}
              title="Copy URL"
              aria-label="Copy published URL"
            >
              <CopyIcon size={16} />
              Copy
            </button>
            <a
              className="ws-drawer-publish-btn ws-drawer-publish-link"
              href={publishedUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open
            </a>
          </div>
          <button
            type="button"
            className="ws-drawer-publish-btn ws-drawer-publish-btn--wide"
            onClick={onUnpublish}
            disabled={publishing}
          >
            <UnpublishIcon size={18} />
            {publishing ? 'Unpublishing...' : 'Unpublish'}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="ws-drawer-publish-btn ws-drawer-publish-btn--wide"
          onClick={onPublish}
          disabled={publishing || !canPublish}
          title={!canPublish ? 'Build first' : (publishing ? 'Publishing...' : 'Publish site')}
        >
          <PublishIcon size={18} />
          {publishing ? 'Publishing...' : 'Publish site'}
        </button>
      )}
    </div>
  )
}

// Left slide-in file drawer (VSCode explorer shape): a panel that transforms
// in from the left edge over a dimming backdrop, opened by the logo toggle.
// It is ALWAYS mounted (the `--open` class drives the transform).
//
// `canMutate` is false until the file index has been confirmed against the
// server (App owns the check). While false we disable add/delete so the user
