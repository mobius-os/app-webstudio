import { Eye } from '@openai/apps-sdk-ui/components/Icon'

export function EyeIcon({ size = 20, ...props }) {
  return <Eye width={size} height={size} aria-hidden="true" {...props} />
}
