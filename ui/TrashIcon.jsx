import { Trash } from '@openai/apps-sdk-ui/components/Icon'

export function TrashIcon({ size = 16, ...props }) {
  return <Trash width={size} height={size} aria-hidden="true" {...props} />
}
