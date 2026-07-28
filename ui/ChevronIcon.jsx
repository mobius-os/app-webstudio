import { ChevronRight } from '@openai/apps-sdk-ui/components/Icon'

export function ChevronIcon({ size = 14, ...props }) {
  return <ChevronRight width={size} height={size} aria-hidden="true" {...props} />
}
