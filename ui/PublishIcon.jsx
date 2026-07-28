import { Share } from '@openai/apps-sdk-ui/components/Icon'

export function PublishIcon({ size = 20, ...props }) {
  return <Share width={size} height={size} aria-hidden="true" {...props} />
}
