import { getOAuthToken, saveOAuthToken } from './tokenStore'

const PROVIDER = 'github'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'

/**
 * GitHub OAuth Device Flow（gh CLI 同款）。
 *
 * 流程：
 * 1. POST /login/device/code → 拿 device_code + user_code + verification_uri
 * 2. 把 user_code 和 verification_uri 给用户，让用户在浏览器打开并输入码
 * 3. 轮询 POST /login/oauth/access_token 直到授权完成
 *
 * 无需 redirect URI（移动端友好）。需要用户先创建 GitHub OAuth App 拿 client_id。
 */

export interface GitHubDeviceFlowResult {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

/** 发起 Device Flow，拿用户码 */
export async function startGitHubDeviceFlow(clientId: string, scope?: string): Promise<GitHubDeviceFlowResult> {
  const resp = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      ...(scope ? { scope } : {})
    })
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`GitHub device flow 发起失败: ${resp.status} ${text.slice(0, 200)}`)
  }
  const data = await resp.json()
  if (data.error) {
    throw new Error(`GitHub device flow 错误: ${data.error} - ${data.error_description ?? ''}`)
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri ?? 'https://github.com/login/device',
    expires_in: data.expires_in ?? 900,
    interval: data.interval ?? 5
  }
}

/** 轮询换 token；授权中返回 null（需继续等），完成返回 token，出错抛异常 */
export async function pollGitHubToken(
  clientId: string,
  deviceCode: string
): Promise<{ access_token: string; token_type?: string; scope?: string } | null> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  })
  const data = await resp.json()

  // 授权中：continue polling
  if (data.error === 'authorization_pending' || data.error === 'slow_down') {
    return null
  }
  if (data.error === 'access_denied') {
    throw new Error('GitHub 授权被用户拒绝')
  }
  if (data.error === 'expired_token') {
    throw new Error('GitHub 授权码已过期，请重新发起')
  }
  if (!data.access_token) {
    throw new Error(`GitHub token 轮询异常: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return { access_token: data.access_token, token_type: data.token_type, scope: data.scope }
}

/** 已授权的 GitHub token（access_token） */
export function getGithubAccessToken(): string | undefined {
  return getOAuthToken(PROVIDER)?.access_token
}

/** 保存 GitHub token */
export function saveGithubToken(token: { access_token: string; token_type?: string; scope?: string }): void {
  saveOAuthToken(PROVIDER, { ...token })
}

/** 是否已授权 */
export function hasGithubToken(): boolean {
  return !!getGithubAccessToken()
}
