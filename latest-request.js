export function makeLatestRequestGate() {
  let latest = 0
  return {
    begin() { latest += 1; return latest },
    isCurrent(requestId) { return requestId === latest },
  }
}
