import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generated = readFileSync(
  join(repositoryRoot, 'src/agent/attachments/anydoc/generated/anydocWebRuntime.generated.ts'),
  'utf8'
)
const match = generated.match(/export const ANYDOC_WEB_RUNTIME_SOURCE = (.*)\n$/)
if (!match) throw new Error('Generated anydoc WebView runtime source was not found.')

Function(JSON.parse(match[1]))()
const runtime = globalThis.__cherryAnydoc
if (!runtime) throw new Error('Generated anydoc runtime did not expose its sandbox API.')

const wasmPath = resolve(repositoryRoot, 'node_modules/@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm')
await runtime.init(new Uint8Array(readFileSync(wasmPath)))
const input = new TextEncoder().encode('{\\rtf1\\ansi Cherry anydoc mobile integration}')
const markdown = runtime.toMarkdownBytes(input, runtime.formatFromExtension('rtf'))
if (!markdown.includes('Cherry anydoc mobile integration')) {
  throw new Error('Pinned anydoc WASM initialized but failed the RTF conversion smoke test.')
}
