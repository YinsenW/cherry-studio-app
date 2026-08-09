import { StreamableHTTPClientTransport, type StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/client'

/**
 * React Native options for the official MCP v2 Streamable HTTP transport.
 *
 * The protocol implementation intentionally lives in the official SDK. This
 * package only normalizes the URL input and keeps the existing Cherry Studio
 * import path stable for the mobile app.
 */
export type RNStreamableHTTPClientTransportOptions = Omit<StreamableHTTPClientTransportOptions, 'fetch'> & {
  fetch?: typeof fetch
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
    super(typeof url === 'string' ? new URL(url) : url, options)
  }
}
