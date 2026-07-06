// Fire-and-forget analytics for Reflection's nightly digest. The runtime
// buffers these and flushes at most once every few seconds to signals.jsonl in
// the app's own storage; the digest counts signal names and surfaces the last
// few error messages. This helper mirrors the guarded idiom sibling catalog
// apps use (window.mobius?.signal?.(...)): the hook may be absent on an older
// shell and the runtime silently drops non-flat payloads, so we optional-chain
// and swallow everything — analytics must never throw into app logic.
export function signal(name, payload) {
  try {
    window?.mobius?.signal?.(name, payload)
  } catch {
    // Never let telemetry break the app.
  }
}
