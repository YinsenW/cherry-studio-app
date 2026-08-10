import { createMcpFetchBridge, type RNStringUrlFetch } from '@cherrystudio/react-native-streamable-http'
import type { FetchLike } from '@modelcontextprotocol/client'
import { fetch as expoFetch, type FetchRequestInit } from 'expo/fetch'

/**
 * Bridge the web-standard MCP fetch contract to Expo's native fetch contract.
 *
 * The MCP SDK intentionally passes URL objects to its transport and OAuth
 * discovery fetch functions. Expo SDK 54's JavaScript declaration and native
 * bridge accept a string URL, so forwarding the object directly fails on
 * Android before any network request is made. Keep the conversion at this
 * single boundary so transport, health checks, OAuth discovery, registration,
 * token exchange and tool calls all use the same mobile-safe implementation.
 */
export const mcpExpoNativeFetch: RNStringUrlFetch = async (url, init) => {
  const response = await expoFetch(url, init as FetchRequestInit)
  return response as unknown as Response
}

export const mcpExpoFetch: FetchLike = createMcpFetchBridge(mcpExpoNativeFetch)
