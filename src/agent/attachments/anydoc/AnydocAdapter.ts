import type { File } from 'expo-file-system'

import { extractPdfText } from '@/modules/pdf-text-extractor'

import { anydocRuntimeBridge } from './AnydocRuntimeBridge'
import { ANYDOC_WEB_RUNTIME_VERSION } from './generated/anydocWebRuntime.generated'

const MAX_ANYDOC_INPUT_BYTES = 24 * 1024 * 1024
const MAX_DERIVED_MARKDOWN_BYTES = 12 * 1024 * 1024

export type NormalizedDocument = {
  markdown: string
  engine: 'anydoc-wasm' | 'pdf-native-fallback'
  engineVersion: string
}

function isRuntimeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('runtime is not mounted') ||
    message.includes('runtime did not become ready') ||
    message.includes('runtime was detached') ||
    message.includes('runtime failed to initialize')
  )
}

function assertDerivedSize(markdown: string): void {
  const bytes = new TextEncoder().encode(markdown).byteLength
  if (bytes > MAX_DERIVED_MARKDOWN_BYTES) {
    throw new Error('Converted document exceeds the 12 MiB derived-text safety limit.')
  }
}

/** Official anydoc WASM runs inside a sandboxed local WebView, never remotely. */
export class AnydocAdapter {
  async normalize(file: File, extension: string): Promise<NormalizedDocument> {
    if (file.size > MAX_ANYDOC_INPUT_BYTES) {
      throw new Error('Office/PDF attachments are limited to 24 MiB for local anydoc conversion on mobile.')
    }

    try {
      await anydocRuntimeBridge.prepare()
      const markdown = await anydocRuntimeBridge.convert({
        base64: await file.base64(),
        extension: extension.replace(/^\./, '').toLocaleLowerCase()
      })
      assertDerivedSize(markdown)
      return { markdown, engine: 'anydoc-wasm', engineVersion: ANYDOC_WEB_RUNTIME_VERSION }
    } catch (error) {
      // Existing native PDFKit/PDFBox extraction remains a resilience path if
      // the WebView runtime itself is unavailable. Conversion errors such as
      // encrypted or resource-limited documents are never bypassed.
      if (extension.toLocaleLowerCase() !== '.pdf' || !isRuntimeUnavailable(error)) throw error
      const result = await extractPdfText(file.uri, { maxPages: 100 })
      const suffix = result.isTruncated
        ? `\n\n[PDF extraction stopped after ${result.extractedPages} of ${result.totalPages} pages.]`
        : ''
      const markdown = result.text + suffix
      assertDerivedSize(markdown)
      return { markdown, engine: 'pdf-native-fallback', engineVersion: 'platform' }
    }
  }
}
