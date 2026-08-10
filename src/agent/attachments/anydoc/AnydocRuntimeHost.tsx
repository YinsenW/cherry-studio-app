import { Asset } from 'expo-asset'
import { File } from 'expo-file-system'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform, StyleSheet } from 'react-native'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'

import { loggerService } from '@/services/LoggerService'

import { anydocRuntimeBridge } from './AnydocRuntimeBridge'
import { ANYDOC_WEB_RUNTIME_SOURCE, ANYDOC_WEB_RUNTIME_VERSION } from './generated/anydocWebRuntime.generated'

const logger = loggerService.withContext('AnydocRuntimeHost')
const wasmModule = require('@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm') as number

function runtimeHtml(): string {
  const glue = ANYDOC_WEB_RUNTIME_SOURCE.replace(/<\/script/gi, '<\\/script')
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; img-src 'none'; style-src 'none'">
</head><body><script>
${glue}
(() => {
  'use strict';
  const VERSION = ${JSON.stringify(ANYDOC_WEB_RUNTIME_VERSION)};
  const MAX_INPUT_BASE64 = 36 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
  const OUTPUT_CHUNK = 128 * 1024;
  let wasmChunks = [];
  const requests = new Map();
  const send = payload => window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  const decodeBase64 = value => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const fail = (error, id) => send({
    type: 'error', id,
    code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
    message: error instanceof Error ? error.message : String(error)
  });
  const receive = async event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    try {
      if (message.type === 'wasm-start') {
        wasmChunks = [];
      } else if (message.type === 'wasm-chunk') {
        wasmChunks.push(message.chunk);
      } else if (message.type === 'wasm-end') {
        const bytes = decodeBase64(wasmChunks.join(''));
        wasmChunks = [];
        await globalThis.__cherryAnydoc.init(bytes);
        send({ type: 'ready', version: VERSION });
      } else if (message.type === 'request-start') {
        requests.set(message.id, { extension: message.extension, chunks: [], characters: 0 });
      } else if (message.type === 'request-chunk') {
        const request = requests.get(message.id);
        if (!request) return;
        request.characters += message.chunk.length;
        if (request.characters > MAX_INPUT_BASE64) throw new Error('Document exceeds the anydoc bridge input limit.');
        request.chunks.push(message.chunk);
      } else if (message.type === 'request-end') {
        const request = requests.get(message.id);
        requests.delete(message.id);
        if (!request) return;
        const bytes = decodeBase64(request.chunks.join(''));
        const format = globalThis.__cherryAnydoc.formatFromExtension(request.extension) || null;
        const markdown = globalThis.__cherryAnydoc.toMarkdownBytes(bytes, format);
        if (new TextEncoder().encode(markdown).byteLength > MAX_OUTPUT_BYTES) {
          throw new Error('Converted document exceeds the 12 MiB derived-text safety limit.');
        }
        send({ type: 'result-start', id: message.id });
        for (let offset = 0; offset < markdown.length; offset += OUTPUT_CHUNK) {
          send({ type: 'result-chunk', id: message.id, chunk: markdown.slice(offset, offset + OUTPUT_CHUNK) });
        }
        send({ type: 'result-end', id: message.id });
      }
    } catch (error) {
      if (message && message.id) requests.delete(message.id);
      fail(error, message && message.id);
    }
  };
  document.addEventListener('message', receive);
  window.addEventListener('message', receive);
})();
</script></body></html>`
}

export function AnydocRuntimeHost() {
  const webView = useRef<WebView>(null)
  const html = useMemo(runtimeHtml, [])
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (Platform.OS === 'web') return
    return anydocRuntimeBridge.attach(
      message => webView.current?.postMessage(message),
      () => setActive(true)
    )
  }, [])

  const initialize = useCallback(async () => {
    try {
      const asset = Asset.fromModule(wasmModule)
      await asset.downloadAsync()
      if (!asset.localUri) throw new Error('Bundled anydoc WebAssembly asset has no local URI.')
      const wasmBase64 = await new File(asset.localUri).base64()
      anydocRuntimeBridge.initialize(wasmBase64)
    } catch (error) {
      logger.error('Unable to initialize local anydoc runtime', error as Error)
      anydocRuntimeBridge.failInitialization(error)
    }
  }, [])

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    anydocRuntimeBridge.handleMessage(event.nativeEvent.data)
  }, [])

  if (Platform.OS === 'web' || !active) return null
  return (
    <WebView
      ref={webView}
      source={{ html }}
      style={styles.hidden}
      javaScriptEnabled
      domStorageEnabled={false}
      originWhitelist={['*']}
      incognito
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      onLoadEnd={() => void initialize()}
      onMessage={onMessage}
      onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
    />
  )
}

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0
  }
})
