---
name: webstudio-project
description: Work directly in a first-class Möbius Web Studio Project. Use when PROJECT_TYPE starts with webstudio: or the project context names Website, Mini-app, Interactive visualization, Document, Spreadsheet, or Presentation; edit the source tree under PROJECT_ROOT and keep the built result as a project artifact.
---

# Web Studio Project

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
  then verify the rendered result rather than trusting source alone.
- Keep generated output under the Project's artifact area; never commit it with
  the editable source tree.
