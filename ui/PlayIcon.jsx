import { Play } from '@openai/apps-sdk-ui/components/Icon'

export function PlayIcon({ size = 20, ...props }) {
  return <Play width={size} height={size} aria-hidden="true" {...props} />
}
