import { Check } from '@openai/apps-sdk-ui/components/Icon'

export function CheckIcon({ size = 16, ...props }) {
  return <Check width={size} height={size} aria-hidden="true" {...props} />
}
