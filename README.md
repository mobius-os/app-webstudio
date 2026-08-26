# Web Studio

Web Studio is the website-project type for Möbius Projects. The app creates and
reopens website projects; Projects owns their files, chats, build history,
preview, and built-site artifacts.

## Project contract

- Template type: `webstudio:website`
- Starter files: `templates/index.html`, `templates/style.css`, and
  `templates/app.js`
- Build action: `project-builder.sh`
- Artifact: a self-contained website copied from the project root
- Agent guidance: `webstudio-project.md`

The installed app deliberately does not keep a parallel editor, chat, preview,
or file store. Those shared workspace responsibilities belong to Projects.

## Checks

```sh
npm test
npm run smoke
```

The checks validate the project manifest and launcher contract, syntax-check
the builder, and compile the app entry with Möbius's frontend compiler.
