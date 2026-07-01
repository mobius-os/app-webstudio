const stub = new Proxy(function () {}, {
  get: (target, prop) => (prop === Symbol.toPrimitive || prop === Symbol.iterator ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
})

export const EditorState = stub
export const Compartment = stub
export const EditorView = stub
export const keymap = stub
export const history = stub
export const historyKeymap = []
export const defaultKeymap = []
export const indentWithTab = stub
