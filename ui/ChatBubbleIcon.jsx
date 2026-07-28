import { Chat } from '@openai/apps-sdk-ui/components/Icon'

export function ChatBubbleIcon({ size = 20, ...props }) {
  return <Chat width={size} height={size} aria-hidden="true" {...props} />
}
