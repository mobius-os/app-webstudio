import { Pencil } from '@openai/apps-sdk-ui/components/Icon'

export function PencilIcon({ size = 16, ...props }) {
  return <Pencil width={size} height={size} aria-hidden="true" {...props} />
}
