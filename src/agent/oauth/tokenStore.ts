import { storage } from '@/utils'

/**
 * 通用 OAuth token 存储（MMKV，按 provider 键隔离）。
 *
 * 给 GitHub（Device Flow）和飞书（授权码）共用。每个 provider 一个存储键，
 * 存 access_token / refresh_token / 过期时间等。
 */

export interface OAuthStoredToken {
  access_token: string
  token_type?: string
  refresh_token?: string
  /** 过期时间（Unix 秒）；GitHub 的 token 默认不过期，飞书的 user_access_token 2h 过期 */
  expires_at?: number
  scope?: string
  [key: string]: unknown
}

const PREFIX = 'agent_oauth_'

function keyFor(provider: string): string {
  return `${PREFIX}${provider}_token`
}

/** 读取 token；返回 undefined 表示未授权 */
export function getOAuthToken(provider: string): OAuthStoredToken | undefined {
  const raw = storage.getString(keyFor(provider))
  if (!raw) return undefined
  try {
    const token = JSON.parse(raw) as OAuthStoredToken
    // 检查是否过期（飞书 token 2h 有效）
    if (token.expires_at && Date.now() / 1000 >= token.expires_at) {
      return undefined
    }
    return token
  } catch {
    storage.delete(keyFor(provider))
    return undefined
  }
}

/** 保存 token */
export function saveOAuthToken(provider: string, token: OAuthStoredToken): void {
  storage.set(keyFor(provider), JSON.stringify(token))
}

/** 清除 token（登出） */
export function clearOAuthToken(provider: string): void {
  storage.delete(keyFor(provider))
}

/** 判断是否已授权（有效 token 存在） */
export function hasOAuthToken(provider: string): boolean {
  return getOAuthToken(provider) !== undefined
}
