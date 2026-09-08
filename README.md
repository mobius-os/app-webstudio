# Web Studio

Web Studio is a Project app for websites only. It adds **Website** to
**Projects +**, and provides a focused launcher for your website projects.
Projects owns the source files, chats, build history, and preview.

## Project contract

- Template: `webstudio:website`
- Starter source: local `index.html`, `style.css`, and `app.js`
- Build: `project-builder.sh` produces a self-contained website Creation
- Agent guidance: `webstudio-project.md`

Web Studio has no mini-app, visualization, document, spreadsheet, or
presentation templates or specialist builders. App projects belong to core
Möbius; other formats can be supplied by other Project apps.

Existing projects and built outputs are not deleted by this change. Older
non-website projects remain accessible through Projects in the shell drawer, but their removed
specialist builders are no longer supplied by Web Studio.

The app does not keep a parallel editor, chat, preview, or file store.

## Checks

```sh
npm test
npm run smoke
```
