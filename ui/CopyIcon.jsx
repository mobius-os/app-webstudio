import { Copy } from '@openai/apps-sdk-ui/components/Icon'

export function CopyIcon({ size = 16, ...props }) {
  return <Copy width={size} height={size} aria-hidden="true" {...props} />
}
