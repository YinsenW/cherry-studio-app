import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'

import { uuid } from '@/utils'

import { getOAuthToken, saveOAuthToken } from './tokenStore'

const PROVIDER = 'feishu'

// 飞书自建应用在后台注册的回调地址（App 深链）
const REDIRECT_URI = 'cherry-studio://oauth/callback'

/**
 * 飞书 OAuth 授权码流程（PKCE）。
 *
 * 前置：用户在 https://open.feishu.cn/app 创建自建应用，
 * 在「安全设置 → 重定向 URL」里注册 `cherry-studio://oauth/callback`，
 * 开启用户身份能力，拿 App ID + App Secret。
 *
 * 流程：
 * 1. 构造授权 URL（含 code_challenge + state）
 * 2. 打开系统浏览器授权 → 回跳 `cherry-studio://oauth/callback?code=...&state=...`
 * 3. 用 code 换 user_access_token
 *
 * 注意：飞书授权码换 token 端点是公开稳定接口，路径如与官方文档有出入
 * 以最新文档为准（https://open.feishu.cn/document/common-capabilities/sso/web-application-sso/web-app-oauth-flow）。
 */

const AUTH_URL = 'https://open.feishu.cn/open-apis/authen/v1/index'
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generateCodeVerifier(): string {
  return base64UrlEncode(Crypto.getRandomBytes(32))
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

/**
 * 发起飞书授权码流程（打开浏览器，等用户授权回跳）。
 * @returns 授权成功返回 access_token；用户取消返回 null
 */
export async function authorizeFeishu(appId: string, appSecret: string): Promise<{ access_token: string } | null> {
  const verifier = generateCodeVerifier()
  const challenge = await generateCodeChallenge(verifier)
  const state = uuid()

  const url = new URL(AUTH_URL)
  url.searchParams.set('app_id', appId)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  // 需要的基础权限：获取用户基本信息
  url.searchParams.set('scope', 'contact:user.base:readonly')

  const result = await WebBrowser.openAuthSessionAsync(url.toString(), REDIRECT_URI)
  if (result.type !== 'success') {
    return null
  }

  const callbackUrl = new URL(result.url)
  const code = callbackUrl.searchParams.get('code')
  const returnedState = callbackUrl.searchParams.get('state')
  const error = callbackUrl.searchParams.get('error')

  if (error) {
    throw new Error(`飞书授权失败: ${callbackUrl.searchParams.get('error_description') ?? error}`)
  }
  if (!code) {
    throw new Error('飞书授权回调缺少 code')
  }
  if (!returnedState || returnedState !== state) {
    throw new Error('飞书授权 state 不匹配（CSRF 防护）')
  }

  // 换 token
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      app_id: appId,
      app_secret: appSecret,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    })
  })
  const data = await resp.json()
  if (!data.access_token) {
    throw new Error(`飞书换取 token 失败: ${JSON.stringify(data).slice(0, 200)}`)
  }

  saveOAuthToken(PROVIDER, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    // 飞书 user_access_token 有效期 2h
    expires_at: Date.now() / 1000 + (data.expires_in ?? 7200)
  })
  return { access_token: data.access_token }
}

/** 已授权的飞书 user_access_token */
export function getFeishuAccessToken(): string | undefined {
  return getOAuthToken(PROVIDER)?.access_token
}

/** 是否已授权 */
export function hasFeishuToken(): boolean {
  return !!getFeishuAccessToken()
}
