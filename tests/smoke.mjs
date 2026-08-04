// `npm run smoke` — compile the whole module tree the way Möbius compiles
// mini-apps (Rolldown, from the shell's frontend) and throw the output away.
// Packages stay external, so this is a parse-and-link check of this repo's own
// files: no output means every source_files entry compiled.
import { compileSmoke } from './bundle.mjs'

await compileSmoke('index.jsx')
