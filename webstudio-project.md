---
name: webstudio-project
description: Build or edit a Website, Mini-app, Interactive visualization, Document, Spreadsheet, or Presentation when Web Studio is installed. In a Project, edit PROJECT_ROOT and rebuild its artifact. In an ordinary chat with no Project, build a standalone Page (or an ordinary mini-app) directly; the owner can later import that work into Projects.
---

# Web Studio work

## Ordinary chat: build first, organize later

When there is no `$PROJECT_ROOT`, do not manufacture a Project as a prerequisite.

- Build websites, interactive visualizations, documents, spreadsheets, and
  presentations as standalone self-contained HTML Pages through the `artifacts`
  skill (the Pages app). They open independently as the finished work, not
  inside an editor.
- Build a durable mini-app through `building-apps-quickstart`; its source stays
  in the ordinary app workspace and its private runtime data stays with the
  installed app.
- Tell the owner they can later use **Projects → New → Import existing** to
  create an independent editable Project copy. Importing never turns the
  original Page or app into a live-linked Project.

This direct path is the default when the owner asks to make the work itself and
has not asked for a Project, a source workspace, or multi-file collaboration.

## Inside a Project

The Project is the workspace. Edit source files directly under `$PROJECT_ROOT`;
do not modify the installed Web Studio app or its app-scoped storage.

- Preserve the project format: HTML/CSS/JS for websites and visualizations,
  `index.jsx` plus `mobius.json` for mini-apps, Markdown for documents, CSV for
  spreadsheets, and self-contained HTML/CSS/JS for presentations.
- Do not load CDNs, remote fonts, scripts, or images. Project previews are
  intentionally isolated and external load-time dependencies can leave the
  result unusable.
- Use relative local asset paths and preserve unrelated source files.
- Save meaningful changes so the Project can rebuild its registered artifact,
  then verify the rendered result rather than trusting source alone. A built
  artifact opens in its own viewer, independent of the project workspace.
- Keep generated output under the Project's artifact area; never commit it with
  the editable source tree.
