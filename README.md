# Web Studio

Web Studio creates and reopens first-class Möbius Projects for websites,
mini-apps, interactive visualizations, documents, spreadsheets, and
presentations. Projects owns their files, chats, build history, preview, and
built artifacts.

## Project contract

- Template types: `webstudio:website`, `mini-app`, `visualization`, `document`,
  `spreadsheet`, and `presentation`
- Starter source: local HTML/CSS/JS, React, Markdown, or CSV according to type
- Build actions: confined self-contained website, mini-app, reading-view, and
  data-view builders
- Artwork: each example format carries crop-safe local cover art
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
