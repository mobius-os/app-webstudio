import { Code } from '@openai/apps-sdk-ui/components/Icon'

export function CodeIcon({ size = 20, ...props }) {
  return <Code width={size} height={size} aria-hidden="true" {...props} />
}
