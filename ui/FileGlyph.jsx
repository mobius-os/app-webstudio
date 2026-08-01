import { fileKind } from '../domain.js'
import { File, FileCode, FileImage } from '@openai/apps-sdk-ui/components/Icon'

export function FileGlyph({ name, size = 16 }) {
  const kind = fileKind(name)
  const Glyph = kind === 'image'
    ? FileImage
    : ['code', 'json', 'html', 'css'].includes(kind) ? FileCode : File
  return <Glyph width={size} height={size} aria-hidden="true" />
}
