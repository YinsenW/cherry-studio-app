import {
  deserializeMessage,
  type FetchLike,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type StartSSEOptions,
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions
} from '@modelcontextprotocol/client'
import { createParser } from 'eventsource-parser'

/** Native Expo fetch accepts a string URL even though the MCP SDK uses URL objects. */
export type RNStringUrlFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Convert the MCP SDK fetch contract to a native string-URL fetch contract. */
export function createMcpFetchBridge(fetchFn: RNStringUrlFetch): FetchLike {
  return (url, init) => fetchFn(typeof url === 'string' ? url : url.toString(), init)
}

type ReactNativeTransportInternals = {
  _abortController?: AbortController
  _serverRetryMs?: number
  _scheduleReconnection?: (options: StartSSEOptions, attemptCount?: number) => void
  _handleSseStream?: (
    stream: ReadableStream<Uint8Array | ArrayBuffer> | null,
    options: StartSSEOptions,
    isReconnectable: boolean
  ) => void
}

/**
 * React Native options for the official MCP v2 Streamable HTTP transport.
 *
 * The protocol implementation intentionally lives in the official SDK. This
 * package only normalizes the URL input and keeps the existing Cherry Studio
 * import path stable for the mobile app.
 */
export type RNStreamableHTTPClientTransportOptions = Omit<StreamableHTTPClientTransportOptions, 'fetch'> & {
  fetch?: RNStringUrlFetch
}

/**
 * React Native-compatible entry point for MCP Streamable HTTP.
 *
 * Expo/React Native supplies the fetch implementation while the MCP SDK owns
 * protocol behavior: modern/legacy version negotiation, JSON/SSE responses,
 * per-request cancellation, resumption, OAuth, pagination, cache hints and
 * session cleanup. Keeping this class as a thin adapter prevents the mobile
 * app from drifting away from the MCP specification.
 */
export class RNStreamableHTTPClientTransport extends StreamableHTTPClientTransport {
  constructor(url: string | URL, options?: RNStreamableHTTPClientTransportOptions) {
    const { fetch: nativeFetch, ...transportOptions } = options ?? {}
    super(typeof url === 'string' ? new URL(url) : url, {
      ...transportOptions,
      ...(nativeFetch ? { fetch: createMcpFetchBridge(nativeFetch) } : {})
    })

    // The SDK deliberately keeps protocol negotiation, headers, OAuth,
    // pagination and request lifecycle. Only replace its browser-specific SSE
    // body pipeline with a getReader()-based implementation for React Native.
    const internals = this as unknown as ReactNativeTransportInternals
    if (typeof internals._handleSseStream !== 'function' || typeof internals._scheduleReconnection !== 'function') {
      throw new Error(
        'The MCP client SDK Streamable HTTP internals changed; update the React Native SSE adapter before shipping.'
      )
    }
    internals._handleSseStream = (stream, sseOptions, isReconnectable) => {
      this.handleReactNativeSseStream(stream, sseOptions, isReconnectable)
    }
  }

  private handleReactNativeSseStream(
    stream: ReadableStream<Uint8Array | ArrayBuffer> | null,
    options: StartSSEOptions,
    isReconnectable: boolean
  ): void {
    if (!stream) {
      options.onRequestStreamEnd?.()
      return
    }

    const internals = this as unknown as ReactNativeTransportInternals
    const { onresumptiontoken, replayMessageId, requestSignal, onRequestStreamEnd } = options
    const isIntentionalAbort = () =>
      internals._abortController?.signal.aborted === true || requestSignal?.aborted === true
    let lastEventId: string | undefined
    let hasPrimingEvent = false
    let receivedResponse = false

    const finishOrReconnect = () => {
      if (
        (isReconnectable || hasPrimingEvent) &&
        !receivedResponse &&
        internals._abortController &&
        !isIntentionalAbort() &&
        internals._scheduleReconnection
      ) {
        try {
          internals._scheduleReconnection(
            {
              resumptionToken: lastEventId,
              onresumptiontoken,
              replayMessageId,
              requestSignal,
              onRequestStreamEnd
            },
            0
          )
        } catch (error) {
          this.onerror?.(new Error(`Failed to reconnect: ${error instanceof Error ? error.message : String(error)}`))
          onRequestStreamEnd?.()
        }
      } else if (!isIntentionalAbort()) {
        onRequestStreamEnd?.()
      }
    }

    // Reuse the SDK's own spec-compliant parser dependency. The mobile adapter
    // only replaces the browser TransformStream plumbing around it.
    const parser = createParser({
      onEvent: event => {
        if (event.id) {
          lastEventId = event.id
          hasPrimingEvent = true
          onresumptiontoken?.(event.id)
        }
        if (!event.data) return
        if (event.event && event.event !== 'message') return

        try {
          let message = deserializeMessage(event.data)
          if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
            receivedResponse = true
            if (replayMessageId !== undefined) {
              message = { ...message, id: replayMessageId } as JSONRPCMessage
            }
          }
          this.onmessage?.(message)
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)))
        }
      },
      onRetry: retryMs => {
        internals._serverRetryMs = retryMs
      }
    })

    const processStream = async () => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          parser.feed(typeof value === 'string' ? value : decoder.decode(value, { stream: true }))
        }
        parser.feed(decoder.decode())
        finishOrReconnect()
      } catch (error) {
        if (isIntentionalAbort()) return
        this.onerror?.(new Error(`SSE stream disconnected: ${error instanceof Error ? error.message : String(error)}`))
        finishOrReconnect()
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // A native stream may already have released its lock after abort.
        }
      }
    }

    void processStream()
  }
}
