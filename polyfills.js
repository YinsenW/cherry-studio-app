import structuredClone from '@ungap/structured-clone'
import { Buffer } from 'buffer'
import * as ExpoCrypto from 'expo-crypto'

// Polyfill btoa and atob for React Native
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = str => Buffer.from(str, 'binary').toString('base64')
}
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = b64 => Buffer.from(b64, 'base64').toString('binary')
}

// Polyfill globalThis.crypto for libraries that depend on Web Crypto API (e.g., pkce-challenge)
if (!globalThis.crypto) {
  globalThis.crypto = {
    getRandomValues: array => {
      const bytes = ExpoCrypto.getRandomBytes(array.length)
      array.set(bytes)
      return array
    },
    randomUUID: () => ExpoCrypto.randomUUID(),
    subtle: {
      digest: async (algorithm, data) => {
        // Normalize algorithm name
        const algoName = typeof algorithm === 'string' ? algorithm : algorithm.name
        const algoMap = {
          'SHA-1': ExpoCrypto.CryptoDigestAlgorithm.SHA1,
          'SHA-256': ExpoCrypto.CryptoDigestAlgorithm.SHA256,
          'SHA-384': ExpoCrypto.CryptoDigestAlgorithm.SHA384,
          'SHA-512': ExpoCrypto.CryptoDigestAlgorithm.SHA512
        }
        const expoCryptoAlgo = algoMap[algoName]
        if (!expoCryptoAlgo) {
          throw new Error(`Unsupported digest algorithm: ${algoName}`)
        }

        // Convert input to Uint8Array if needed
        const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data)

        // Use expo-crypto digest and return as ArrayBuffer
        const result = await ExpoCrypto.digest(expoCryptoAlgo, uint8Data)
        return result
      }
    }
  }
}

// Expo SDK 54 installs spec-compliant TextEncoder/TextDecoder and stream
// variants from its WinterCG runtime before App modules execute. Do not
// install the old URI-based decoder here: it cannot preserve a multi-byte
// UTF-8 sequence split across native fetch chunks and can break MCP SSE JSON.
if (!('structuredClone' in globalThis)) {
  globalThis.structuredClone = structuredClone
}

export {}
