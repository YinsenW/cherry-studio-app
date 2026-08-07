import { tool } from 'ai'
import { z } from 'zod'

import { authorizeFeishu as runFeishuAuth, getFeishuAccessToken, hasFeishuToken } from './feishuOAuth'
import {
  getGithubAccessToken,
  hasGithubToken,
  pollGitHubToken,
  saveGithubToken,
  startGitHubDeviceFlow
} from './githubOAuth'
import { clearOAuthToken } from './tokenStore'

/**
 * OAuth 授权工具组。
 *
 * 手机沙盒跑不了 lark-cli / gh，但可以通过 OAuth 让用户"登录" GitHub 和飞书：
 * - GitHub：Device Flow（无 redirect URI，gh 官方方式）
 * - 飞书：授权码流程（复用 cherry-studio://oauth/callback + PKCE）
 * 授权成功后 token 存 MMKV，后续 API 工具直接用。
 */

export const authorizeGithub = tool({
  description:
    '触发 GitHub OAuth Device Flow 授权（gh CLI 同款方式，无需配置回调地址）。需要用户提供 GitHub OAuth App 的 Client ID（在 github.com/settings/developers 创建 OAuth App，Authorization callback URL 随便填）。返回一个设备码和授权网址，请把网址和码告诉用户，让用户在浏览器打开网址并输入码完成授权，然后调用 pollGithubAuth 确认。',
  inputSchema: z.object({
    clientId: z.string().describe('GitHub OAuth App 的 Client ID'),
    scope: z.string().optional().describe('OAuth scope，默认 repo，可传 "repo gist user" 等')
  }),
  execute: async ({ clientId, scope }) => {
    const flow = await startGitHubDeviceFlow(clientId, scope)
    // 存临时 device_code（用固定键覆盖，避免多次授权混用）
    const { saveOAuthToken } = await import('./tokenStore')
    saveOAuthToken('github_pending', { access_token: '', device_code: flow.device_code })
    return {
      ok: true,
      userCode: flow.user_code,
      verificationUri: flow.verification_uri,
      message: `请在浏览器打开 ${flow.verification_uri} 并输入代码 ${flow.user_code}，完成后告诉我。`,
      expiresIn: flow.expires_in
    }
  }
})

export const pollGithubAuth = tool({
  description:
    '轮询 GitHub 授权结果。用户完成 authorizeGithub 里给出的设备码授权后调用此工具确认，成功后会保存 token，之后 GitHub 工具无需再传 token。',
  inputSchema: z.object({
    clientId: z.string().describe('GitHub OAuth App 的 Client ID（与 authorizeGithub 一致）')
  }),
  execute: async ({ clientId }) => {
    const { getOAuthToken } = await import('./tokenStore')
    const pending = getOAuthToken('github_pending')
    if (!pending?.device_code) {
      return { ok: false, message: '未找到待确认的授权，请先调用 authorizeGithub' }
    }
    const token = await pollGitHubToken(clientId, pending.device_code as string)
    if (!token) {
      return { ok: false, pending: true, message: '用户还未完成授权，请稍后再试或让用户先在浏览器输入码' }
    }
    saveGithubToken(token)
    clearOAuthToken('github_pending')
    return { ok: true, message: 'GitHub 授权成功，token 已保存，可以开始使用 GitHub 工具了' }
  }
})

export const githubAuthStatus = tool({
  description: '检查 GitHub 是否已授权（是否有有效 token）。',
  inputSchema: z.object({}),
  execute: async () => {
    if (hasGithubToken()) {
      return { ok: true, authorized: true, message: 'GitHub 已授权' }
    }
    return { ok: true, authorized: false, message: 'GitHub 未授权，请调用 authorizeGithub' }
  }
})

export const authorizeFeishu = tool({
  description:
    '触发飞书 OAuth 授权（授权码流程 + PKCE）。需要用户提供飞书自建应用的 App ID 和 App Secret，且在飞书后台「安全设置 → 重定向 URL」注册 cherry-studio://oauth/callback。调用后会打开浏览器让用户授权。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID（cli_xxx）'),
    appSecret: z.string().describe('飞书自建应用的 App Secret')
  }),
  execute: async ({ appId, appSecret }) => {
    const result = await runFeishuAuth(appId, appSecret)
    if (!result) {
      return { ok: false, message: '飞书授权被取消或未完成，请重试' }
    }
    return { ok: true, message: '飞书授权成功，token 已保存，可以开始使用飞书工具了' }
  }
})

export const feishuAuthStatus = tool({
  description: '检查飞书是否已授权（是否有有效 token）。',
  inputSchema: z.object({}),
  execute: async () => {
    if (hasFeishuToken()) {
      return { ok: true, authorized: true, message: '飞书已授权' }
    }
    return { ok: true, authorized: false, message: '飞书未授权，请调用 authorizeFeishu' }
  }
})

export const logoutGithub = tool({
  description: '注销 GitHub 授权（清除已保存的 token）。',
  inputSchema: z.object({}),
  execute: async () => {
    clearOAuthToken('github')
    clearOAuthToken('github_pending')
    return { ok: true, message: 'GitHub 已注销' }
  }
})

export const logoutFeishu = tool({
  description: '注销飞书授权（清除已保存的 token）。',
  inputSchema: z.object({}),
  execute: async () => {
    clearOAuthToken('feishu')
    return { ok: true, message: '飞书已注销' }
  }
})

/** 供 API 工具检查：返回 access_token，未授权返回 null */
export function requireGithubToken(): { authorized: boolean; token?: string; hint: string } {
  const token = getGithubAccessToken()
  if (!token) {
    return { authorized: false, hint: 'GitHub 未授权，请先调用 authorizeGithub 完成授权' }
  }
  return { authorized: true, token, hint: '' }
}

/** 供 API 工具检查：返回 access_token，未授权返回 null */
export function requireFeishuToken(): { authorized: boolean; token?: string; hint: string } {
  const token = getFeishuAccessToken()
  if (!token) {
    return { authorized: false, hint: '飞书未授权，请先调用 authorizeFeishu 完成授权' }
  }
  return { authorized: true, token, hint: '' }
}

export const OAuthTool = {
  AuthorizeGithub: authorizeGithub,
  PollGithubAuth: pollGithubAuth,
  GithubAuthStatus: githubAuthStatus,
  AuthorizeFeishu: authorizeFeishu,
  FeishuAuthStatus: feishuAuthStatus,
  LogoutGithub: logoutGithub,
  LogoutFeishu: logoutFeishu
}

export type OAuthToolKeys = keyof typeof OAuthTool
