declare const MACRO: {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  VERSION_CHANGELOG: string
  ISSUES_EXPLAINER: string
  FEEDBACK_CHANNEL: string
}

// Vendored skill assets imported as text (Bun's default loaders would convert
// .md to HTML and resolve unknown extensions to file paths — always import
// with `with { type: 'text' }`).
declare module '*.md' {
  const content: string
  export default content
}
declare module '*.txt' {
  const content: string
  export default content
}
declare module '*.py' {
  const content: string
  export default content
}
declare module '*.xsd' {
  const content: string
  export default content
}
declare module '*.xml' {
  const content: string
  export default content
}
declare module '*.html' {
  const content: string
  export default content
}
declare module '*.sh' {
  const content: string
  export default content
}
declare module '*.js' {
  const content: string
  export default content
}

// Binary assets via Bun's default file loader (path string; embedded asset
// path in compiled builds).
declare module '*.ttf' {
  const path: string
  export default path
}
declare module '*.pdf' {
  const path: string
  export default path
}
declare module '*.gz' {
  const path: string
  export default path
}
