import { DotsVerticalMoreMenu } from '@openai/apps-sdk-ui/components/Icon'

export function KebabIcon({ size = 18, ...props }) {
  return <DotsVerticalMoreMenu width={size} height={size} aria-hidden="true" {...props} />
}
