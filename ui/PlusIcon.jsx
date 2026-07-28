import { Plus } from '@openai/apps-sdk-ui/components/Icon'

export function PlusIcon({ size = 18, ...props }) {
  return <Plus width={size} height={size} aria-hidden="true" {...props} />
}
