/**
 * MobileOAuthProvider - OAuth Client Provider for React Native
 *
 * Implements the OAuthClientProvider interface from @modelcontextprotocol/client
 * for mobile OAuth authentication using expo-web-browser and MMKV storage.
 *
 * This provider is used by the official MCP v2 transport auth seam. The mobile
 * adapter keeps the SDK's OAuth state and tokens in MMKV while completing the
 * browser callback through expo-web-browser.
 */
import type {
  AuthProvider,
  FetchLike,
  OAuthClientInformationContext,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens
} from '@modelcontextprotocol/client'
import { auth, extractWWWAuthenticateParams } from '@modelcontextprotocol/client'
import { fetch as expoFetch } from 'expo/fetch'
import * as WebBrowser from 'expo-web-browser'

import { loggerService } from '@/services/LoggerService'
import { storage, uuid } from '@/utils'

const logger = loggerService.withContext('MCP:OAuth')

const STORAGE_PREFIX = 'mcp_oauth_'
const REDIRECT_URL = 'cherry-studio://oauth/callback'

/**
 * Mobile OAuth Provider for MCP servers
 *
 * Implements the OAuthClientProvider interface required by the MCP SDK.
 * Uses MMKV for secure token storage and expo-web-browser for OAuth flows.
 *
 * @example
 * ```typescript
 * const provider = new MobileOAuthProvider(serverHash)
 * const transport = new RNStreamableHTTPClientTransport(url, { authProvider: provider })
 * ```
 */
export class MobileOAuthProvider implements OAuthClientProvider {
  private serverHash: string

  constructor(serverHash: string) {
    this.serverHash = serverHash
  }

  // ==================== Storage Keys ====================

  private get tokensKey(): string {
    return `${STORAGE_PREFIX}${this.serverHash}_tokens`
  }

  private get clientInfoKey(): string {
    return `${STORAGE_PREFIX}${this.serverHash}_client`
  }

  private get verifierKey(): string {
    return `${STORAGE_PREFIX}${this.serverHash}_verifier`
  }

  private get stateKey(): string {
    return `${STORAGE_PREFIX}${this.serverHash}_state`
  }

  private get discoveryKey(): string {
    return `${STORAGE_PREFIX}${this.serverHash}_discovery`
  }

  private get resourceKey(): string {
    return `${STORAGE_PREFIX}${this.serverHash}_resource`
  }

  private get authorizationServerKey(): string {
    return `${STORAGE_PREFIX}${this.serverHash}_authorization_server`
  }

  private get callbackKey(): string {
    return `${STORAGE_PREFIX}${this.serverHash}_callback`
  }

  // ==================== OAuthClientProvider Interface ====================

  /**
   * The URL to redirect the user agent to after authorization
   */
  get redirectUrl(): string {
    return REDIRECT_URL
  }

  /**
   * OAuth client metadata for dynamic registration
   */
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Cherry Studio App'
    } as OAuthClientMetadata
  }

  /**
   * Load client information from storage
   */
  clientInformation(_ctx?: OAuthClientInformationContext): OAuthClientInformationFull | undefined {
    const data = storage.getString(this.clientInfoKey)
    if (!data) return undefined

    try {
      return JSON.parse(data) as OAuthClientInformationFull
    } catch (error) {
      logger.error('Corrupted client information in storage, clearing', error as Error)
      storage.delete(this.clientInfoKey)
      return undefined
    }
  }

  /**
   * Save client information to storage
   */
  saveClientInformation(info: OAuthClientInformationFull, _ctx?: OAuthClientInformationContext): void {
    storage.set(this.clientInfoKey, JSON.stringify(info))
    logger.verbose('Saved client information')
  }

  /**
   * Load OAuth tokens from storage
   */
  tokens(_ctx?: OAuthClientInformationContext): OAuthTokens | undefined {
    const data = storage.getString(this.tokensKey)
    if (!data) return undefined

    try {
      return JSON.parse(data) as OAuthTokens
    } catch (error) {
      logger.error('Corrupted OAuth tokens in storage, clearing', error as Error)
      storage.delete(this.tokensKey)
      return undefined
    }
  }

  /**
   * Save OAuth tokens to storage
   */
  saveTokens(tokens: OAuthTokens, _ctx?: OAuthClientInformationContext): void {
    storage.set(this.tokensKey, JSON.stringify(tokens))
    logger.info('Saved OAuth tokens')
  }

  /**
   * Redirect user to authorization URL using expo-web-browser
   *
   * This method is called by the SDK's auth() function to start the OAuth flow.
   * It opens a web browser session that will redirect back to our app with the
   * authorization code.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    logger.info('Opening authorization URL in browser')

    const result = await WebBrowser.openAuthSessionAsync(authorizationUrl.toString(), this.redirectUrl)

    if (result.type !== 'success') {
      logger.warn(`OAuth flow ended with type: ${result.type}`)
      throw new Error(`OAuth authorization was cancelled or failed: ${result.type}`)
    }

    // Parse the callback URL to extract the authorization code
    const callbackUrl = new URL(result.url)
    const code = callbackUrl.searchParams.get('code')
    const error = callbackUrl.searchParams.get('error')
    const returnedState = callbackUrl.searchParams.get('state')

    // Verify state parameter for CSRF protection
    if (!returnedState || !this.verifyState(returnedState)) {
      throw new Error('OAuth state mismatch - possible CSRF attack')
    }

    if (error) {
      const errorDescription = callbackUrl.searchParams.get('error_description') || error
      logger.error(`OAuth error: ${errorDescription}`)
      throw new Error(`OAuth authorization failed: ${errorDescription}`)
    }

    if (!code) {
      logger.error('No authorization code in callback URL')
      throw new Error('No authorization code received from OAuth provider')
    }

    storage.set(
      this.callbackKey,
      JSON.stringify({
        code,
        iss: callbackUrl.searchParams.get('iss') || undefined
      })
    )
    logger.info('Received authorization code from OAuth provider')
  }

  /**
   * Read and clear the callback captured by redirectToAuthorization.
   *
   * The MCP SDK's browser-oriented auth() API returns `REDIRECT` after calling
   * redirectToAuthorization(). React Native's auth session already waits for
   * the deep-link callback, so the mobile adapter consumes the callback and
   * invokes auth() a second time with the authorization code.
   */
  consumeAuthorizationCallback(): { code: string; iss?: string } | undefined {
    const data = storage.getString(this.callbackKey)
    if (!data) return undefined

    storage.delete(this.callbackKey)
    storage.delete(this.stateKey)
    try {
      const callback = JSON.parse(data) as { code?: unknown; iss?: unknown }
      if (typeof callback.code !== 'string' || callback.code.length === 0) {
        return undefined
      }
      return {
        code: callback.code,
        iss: typeof callback.iss === 'string' && callback.iss.length > 0 ? callback.iss : undefined
      }
    } catch (error) {
      logger.error('Corrupted OAuth callback in storage, clearing', error as Error)
      return undefined
    }
  }

  /**
   * Save PKCE code verifier to storage
   */
  saveCodeVerifier(codeVerifier: string): void {
    storage.set(this.verifierKey, codeVerifier)
    logger.verbose('Saved PKCE code verifier')
  }

  /**
   * Load PKCE code verifier from storage
   * @throws Error if verifier is not found (indicates OAuth flow was not started properly)
   */
  codeVerifier(): string {
    const verifier = storage.getString(this.verifierKey)
    if (!verifier) {
      logger.error('PKCE code verifier not found in storage')
      throw new Error('PKCE code verifier not found. Please restart the OAuth flow.')
    }
    return verifier
  }

  /**
   * Generate OAuth state parameter for CSRF protection
   * Saves the state to storage for later verification
   */
  state(): string {
    const newState = uuid()
    storage.set(this.stateKey, newState)
    logger.verbose('Generated and saved OAuth state')
    return newState
  }

  /**
   * Verify the returned state parameter matches the stored state
   * This is critical for CSRF protection
   *
   * @param returnedState - The state parameter returned from the OAuth callback
   * @returns true if the state matches, false otherwise
   */
  verifyState(returnedState: string): boolean {
    const expectedState = storage.getString(this.stateKey)
    if (!expectedState) {
      logger.error('No stored state found for verification')
      return false
    }
    const isValid = returnedState === expectedState
    if (!isValid) {
      logger.error('OAuth state mismatch - possible CSRF attack')
    }
    return isValid
  }

  /**
   * Invalidate stored credentials
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery' | 'state'): void {
    switch (scope) {
      case 'all':
        storage.delete(this.tokensKey)
        storage.delete(this.clientInfoKey)
        storage.delete(this.verifierKey)
        storage.delete(this.stateKey)
        storage.delete(this.discoveryKey)
        storage.delete(this.resourceKey)
        storage.delete(this.authorizationServerKey)
        storage.delete(this.callbackKey)
        logger.info('Invalidated all OAuth credentials')
        break
      case 'tokens':
        storage.delete(this.tokensKey)
        logger.info('Invalidated OAuth tokens')
        break
      case 'client':
        storage.delete(this.clientInfoKey)
        logger.info('Invalidated OAuth client information')
        break
      case 'verifier':
        storage.delete(this.verifierKey)
        logger.info('Invalidated PKCE code verifier')
        break
      case 'discovery':
        storage.delete(this.discoveryKey)
        storage.delete(this.resourceKey)
        storage.delete(this.authorizationServerKey)
        logger.info('Invalidated OAuth discovery state')
        break
      case 'state':
        storage.delete(this.stateKey)
        logger.info('Invalidated OAuth state')
        break
    }
  }

  saveAuthorizationServerUrl(authorizationServerUrl: string): void {
    storage.set(this.authorizationServerKey, authorizationServerUrl)
  }

  authorizationServerUrl(): string | undefined {
    return storage.getString(this.authorizationServerKey)
  }

  saveResourceUrl(resourceUrl: string): void {
    storage.set(this.resourceKey, resourceUrl)
  }

  resourceUrl(): string | undefined {
    return storage.getString(this.resourceKey)
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    storage.set(this.discoveryKey, JSON.stringify(state))
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const data = storage.getString(this.discoveryKey)
    if (!data) return undefined

    try {
      return JSON.parse(data) as OAuthDiscoveryState
    } catch (error) {
      logger.error('Corrupted OAuth discovery state in storage, clearing', error as Error)
      storage.delete(this.discoveryKey)
      return undefined
    }
  }
}

/**
 * Create a MobileOAuthProvider for a given server URL
 *
 * @param serverUrl - The MCP server URL to create a provider for
 * @returns A MobileOAuthProvider instance
 */
export function createMobileOAuthProvider(serverUrl: string): MobileOAuthProvider {
  // Create a hash of the server URL for storage keys
  const hash = simpleHash(serverUrl)
  return new MobileOAuthProvider(hash)
}

/**
 * Adapt the mobile OAuth store to the official MCP v2 transport auth seam.
 * Streamable HTTP needs a current bearer token and a one-shot unauthorized
 * callback so it can retry the failed request after reauthorization.
 */
export function createMobileAuthProvider(serverUrl: string): AuthProvider {
  const oauthProvider = createMobileOAuthProvider(serverUrl)

  return {
    token: async () => oauthProvider.tokens()?.access_token,
    onUnauthorized: async context => {
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(context.response)
      const authorized = await runSdkOAuthFlow(oauthProvider, serverUrl, {
        fetchFn: context.fetchFn,
        resourceMetadataUrl,
        scope
      })
      if (!authorized) {
        throw new Error('OAuth authorization was cancelled or failed')
      }
    }
  }
}

/**
 * Simple hash function for creating storage keys
 * Uses a basic djb2 hash algorithm for consistency
 */
function simpleHash(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Check if a server has valid OAuth tokens stored
 *
 * @param serverUrl - The MCP server URL to check
 * @returns true if valid tokens exist, false otherwise
 */
export function hasOAuthTokens(serverUrl: string): boolean {
  const hash = simpleHash(serverUrl)
  const tokensKey = `${STORAGE_PREFIX}${hash}_tokens`
  const data = storage.getString(tokensKey)

  if (!data) return false

  try {
    const tokens = JSON.parse(data) as OAuthTokens
    return !!tokens.access_token
  } catch {
    return false
  }
}

/**
 * Clear OAuth tokens for a server
 *
 * @param serverUrl - The MCP server URL to clear tokens for
 */
export function clearOAuthTokens(serverUrl: string): void {
  const hash = simpleHash(serverUrl)
  const tokensKey = `${STORAGE_PREFIX}${hash}_tokens`
  storage.delete(tokensKey)
  logger.info('Cleared OAuth tokens for server')
}

interface SdkOAuthFlowOptions {
  fetchFn?: FetchLike
  resourceMetadataUrl?: URL
  scope?: string
}

/**
 * Run the MCP SDK OAuth orchestrator in a React Native auth session.
 *
 * The SDK's interactive branch returns `REDIRECT` after invoking the provider's
 * redirect callback. On mobile, that callback has already completed by the time
 * openAuthSessionAsync resolves, so we immediately run the SDK's callback leg to
 * exchange the code and persist issuer-bound tokens.
 */
async function runSdkOAuthFlow(
  provider: MobileOAuthProvider,
  serverUrl: string,
  options: SdkOAuthFlowOptions = {}
): Promise<boolean> {
  const authOptions = {
    serverUrl,
    fetchFn: options.fetchFn,
    resourceMetadataUrl: options.resourceMetadataUrl,
    scope: options.scope
  }

  const result = await auth(provider, authOptions)
  if (result === 'AUTHORIZED') return true

  const callback = provider.consumeAuthorizationCallback()
  if (!callback) {
    logger.warn('MCP OAuth redirect completed without an authorization callback')
    return false
  }

  const completion = await auth(provider, {
    ...authOptions,
    authorizationCode: callback.code,
    iss: callback.iss
  })
  return completion === 'AUTHORIZED'
}

function isOAuthCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /cancelled|canceled|user.?denied/i.test(message)
}

/**
 * Perform the complete MCP OAuth flow for an MCP server.
 *
 * Discovery, RFC 9728 resource binding, RFC 8414/OIDC metadata validation,
 * PKCE, dynamic registration, issuer checks, refresh, and token exchange are
 * delegated to the official MCP SDK. This keeps mobile behavior aligned with
 * the current MCP OAuth protocol instead of maintaining a second parser.
 */
export async function performOAuthFlow(serverUrl: string): Promise<boolean> {
  const provider = createMobileOAuthProvider(serverUrl)

  try {
    logger.info(`Starting MCP OAuth flow for: ${serverUrl}`)
    return await runSdkOAuthFlow(provider, serverUrl, {
      fetchFn: expoFetch as unknown as FetchLike
    })
  } catch (error) {
    if (isOAuthCancellation(error)) {
      logger.warn(`MCP OAuth flow cancelled for ${serverUrl}`)
      return false
    }
    logger.error('MCP OAuth flow failed:', error as Error)
    throw error
  }
}
