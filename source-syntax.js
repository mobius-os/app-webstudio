const SOURCE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html',
  'htm', 'svg', 'xml', 'py', 'sh', 'bash', 'yaml', 'yml', 'toml', 'sql',
])

const SOURCE_TOKEN_RE = /(<!--[\s\S]*?-->|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(import|from|as|export|default|const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|async|await|yield|typeof|instanceof|in|of|def|lambda|with|elif|fi|then|select|insert|update|delete|create|where|join|order|group|by)\b|\b(true|false|null|undefined|None|True|False)\b|\b(0x[\da-fA-F]+|\d+(?:\.\d+)?)|(<\/?[A-Za-z][\w.-]*)/g

export function sourceKind(path) {
  const name = String(path || '').split('/').pop() || ''
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return SOURCE_EXTENSIONS.has(ext) ? ext : ''
}

function tokenClass(match) {
  if (match[1]) return 'cm-syn-comment'
  if (match[2]) return 'cm-syn-string'
  if (match[3]) return 'cm-syn-keyword'
  if (match[4]) return 'cm-syn-literal'
  if (match[5]) return 'cm-syn-number'
  return 'cm-syn-tag'
}

export function sourceTokens(path, text) {
  if (!sourceKind(path)) return []
  const tokens = []
  SOURCE_TOKEN_RE.lastIndex = 0
  let match
  while ((match = SOURCE_TOKEN_RE.exec(String(text || '')))) {
    tokens.push({
      from: match.index,
      to: match.index + match[0].length,
      className: tokenClass(match),
    })
  }
  return tokens
}
