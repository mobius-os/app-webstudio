import { UploadDocuments } from '@openai/apps-sdk-ui/components/Icon'

export function UploadIcon({ size = 17, ...props }) {
  return <UploadDocuments width={size} height={size} aria-hidden="true" {...props} />
}
