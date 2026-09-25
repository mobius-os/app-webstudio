---
name: webstudio-project
description: Build or edit a website when Web Studio is installed. In a Website Project, edit PROJECT_ROOT and rebuild its website Creation. In an ordinary chat without a Project, follow the Pages workflow for a standalone website preview.
---

# Website work

Web Studio adds Website projects only. Use core Möbius App projects for
installable apps and the appropriate separate capability for other formats;
do not add those formats to Web Studio.

## Ordinary chat: build first, organize later

When there is no `$PROJECT_ROOT`, do not manufacture a Project as a prerequisite.
Read the `pages` skill to resolve the installed Pages app and mint the
page's stable `artifact_id`. Author the website in its durable editable tree:
`/data/apps/<PAGES_APP_ID>/sources/<artifact_id>/`. Start with `index.html` and
keep all local CSS, JavaScript, and assets there. A multi-file website does not
require a Project; create one only when the owner asks for its workspace.

Build a self-contained HTML preview from that source (inline local dependencies
in the preview, not in place in the editable files), then publish an immutable
Page version following `pages`. Include explicit builder provenance in the
Page record:

```json
{
  "project_import": {
    "template_id": "webstudio:website",
    "files": [
      {"storage_path": "sources/<artifact_id>/index.html", "path": "index.html"},
      {"storage_path": "sources/<artifact_id>/style.css", "path": "style.css"},
      {"storage_path": "sources/<artifact_id>/app.js", "path": "app.js"}
    ]
  }
}
```

List only files actually present, including every source input needed to build.
Write sources before publishing the record. Do not label ordinary mockups,
reports, or other Pages as Website builder outputs merely to make them eligible.

**Add to Projects manages this existing source tree; it does not copy it.**
For later edits, reuse this tree and page id, preserve provenance, and publish
a new preview version. If already managed by Projects, use that same Project's
root and build workflow; do not establish a second editable source tree.
Existing Page versions remain snapshots, never rewritten by source edits.
Agent-led work and collaboration can use the durable source without requiring
the Projects interface; public sharing and Git actions still need the owner's
explicit approval.

## Inside a Website Project

The Project is the workspace. Edit source files directly under `$PROJECT_ROOT`;
do not modify the installed Web Studio app or its app-scoped storage.

- Keep `index.html`, local CSS, JavaScript, and assets together.
- Do not load CDNs, remote fonts, scripts, or images. Project previews are
  intentionally isolated and external load-time dependencies can leave the
  result unusable.
- Use relative local asset paths and preserve unrelated source files.
- Save meaningful changes and rebuild the registered website Creation, then
  verify the rendered result rather than trusting source alone. A Creation
  opens in its own viewer, independent of the project workspace.
- Keep generated output under the Project's artifact area; never commit it with
  the editable source tree.
