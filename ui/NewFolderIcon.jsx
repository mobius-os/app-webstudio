import { FolderPlus } from '@openai/apps-sdk-ui/components/Icon'

export function NewFolderIcon({ size = 17, ...props }) {
  return <FolderPlus width={size} height={size} aria-hidden="true" {...props} />
}
