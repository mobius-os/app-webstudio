import { File } from '@openai/apps-sdk-ui/components/Icon'

export function NewFileIcon({ size = 17, ...props }) {
  return <File width={size} height={size} aria-hidden="true" {...props} />
}
