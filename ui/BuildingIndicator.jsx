import { Spin } from '@openai/apps-sdk-ui/components/Icon'

export function BuildingIndicator({ size = 20 }) {
  return <Spin width={size} height={size} aria-hidden="true" className="ws-building-spin" />
}
