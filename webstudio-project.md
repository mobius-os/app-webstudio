---
name: webstudio-project
description: Work directly in a first-class Möbius Website Project. Use when PROJECT_TYPE is webstudio:website or the project context names the Website type; create and edit the source tree under PROJECT_ROOT and keep the built site as a project artifact.
---

# Website Project

The Project is the workspace. Edit source files directly under `$PROJECT_ROOT`;
do not modify the installed Web Studio app or its app-scoped storage.

- Keep a clear HTML entry point (normally `index.html`) with relative local CSS,
  JavaScript, image, and font paths.
- Do not load CDNs, remote fonts, scripts, or images. Project previews are
  intentionally isolated and external load-time dependencies can leave the
  page unusable.
- Build the entry file with the Project's **Build as website** artifact action
  after meaningful changes and verify the rendered result, not only the source.
- Preserve unrelated source and asset files. Put new assets inside the Project
  tree so the artifact builder can copy them with the site.
