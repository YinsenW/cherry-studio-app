import { tool } from 'ai'
import { z } from 'zod'

import { getFeishuAccessToken } from '@/agent/oauth/feishuOAuth'

/**
 * 飞书开放平台 API 工具组（BYOK）。
 *
 * 手机沙盒跑不了 lark-cli（需要 Node/子进程），但飞书开放平台提供 HTTP API。
 * 用户提供自建应用的 App ID + App Secret（在 https://open.feishu.cn/app 创建自建应用，
 * 开启机器人能力 + 申请对应权限后发布版本），agent 用 tenant_access_token 调接口。
 *
 * 鉴权：POST /open-apis/auth/v3/tenant_access_token/internal
 *  - body: { app_id, app_secret }
 *  - 返回: { code, tenant_access_token, expire }
 *  - token 有效期 2 小时，调用前先取（简单实现不做缓存，工具每次调用取一次）
 */

const FEISHU_BASE = 'https://open.feishu.cn/open-apis'

/** 拿 tenant_access_token（应用身份，覆盖机器人能力/通讯录读等场景） */
async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  const resp = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  })
  const data: any = await resp.json()
  if (data.code !== 0) {
    throw new Error(`飞书鉴权失败: code=${data.code} msg=${data.msg}`)
  }
  return data.tenant_access_token
}

/** 通用 GET */
async function feishuGet(path: string, token: string): Promise<any> {
  const resp = await fetch(`${FEISHU_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }
  })
  return resp.json()
}

/** 通用 POST */
async function feishuPost(path: string, token: string, body: any): Promise<any> {
  const resp = await fetch(`${FEISHU_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  })
  return resp.json()
}

/** 解析调用 token：优先 OAuth 授权的 user_access_token，否则用 appId+Secret 换 tenant token */
async function resolveToken(appId: string, appSecret: string): Promise<string> {
  const oauth = getFeishuAccessToken()
  if (oauth) return oauth
  return getTenantToken(appId, appSecret)
}

/** 统一校验飞书响应 code */
function assertFeishuOk(data: any, action: string) {
  if (data.code !== 0) {
    throw new Error(`飞书 ${action}失败: code=${data.code} msg=${data.msg}`)
  }
}

export const feishuSendText = tool({
  description:
    '通过飞书自建应用机器人发送一条文本消息给用户或群。需要 App ID + App Secret。receive_id 是接收者 ID，receive_id_type 决定 ID 类型（open_id/union_id/user_id/email/chat_id）。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID（cli_xxx）'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    receiveId: z.string().describe('接收者 ID：用户 open_id/union_id/user_id/email，或群 chat_id'),
    receiveIdType: z
      .enum(['open_id', 'union_id', 'user_id', 'email', 'chat_id'])
      .default('open_id')
      .describe('receiveId 的类型'),
    text: z.string().describe('要发送的文本内容')
  }),
  execute: async ({ appId, appSecret, receiveId, receiveIdType, text }) => {
    const token = await resolveToken(appId, appSecret)
    const content = JSON.stringify({ text })
    const data = await feishuPost(`/im/v1/messages?receive_id_type=${receiveIdType}`, token, {
      receive_id: receiveId,
      msg_type: 'text',
      content
    })
    assertFeishuOk(data, '发送消息')
    return { ok: true, messageId: data.data?.message_id, createTime: data.data?.create_time }
  }
})

export const feishuGetUser = tool({
  description:
    '查询飞书用户信息（名字、邮箱、手机、职位、部门等）。需要 App ID + Secret，且应用有通讯录权限。user_id 默认用 open_id。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    userId: z.string().describe('用户的 open_id/union_id/user_id'),
    userIdType: z.enum(['open_id', 'union_id', 'user_id']).default('open_id').describe('userId 的类型')
  }),
  execute: async ({ appId, appSecret, userId, userIdType }) => {
    const token = await resolveToken(appId, appSecret)
    const data = await feishuGet(`/contact/v3/users/${encodeURIComponent(userId)}?user_id_type=${userIdType}`, token)
    assertFeishuOk(data, '查询用户')
    const u = data.data?.user
    return {
      ok: true,
      name: u?.name,
      email: u?.email,
      mobile: u?.mobile,
      title: u?.job_title,
      departmentIds: u?.department_ids,
      city: u?.city,
      status: u?.status
    }
  }
})

export const feishuGetChat = tool({
  description: '查询飞书群信息（名称、描述、群成员数等）。需要 App ID + Secret。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    chatId: z.string().describe('群 chat_id（oc_xxx）')
  }),
  execute: async ({ appId, appSecret, chatId }) => {
    const token = await resolveToken(appId, appSecret)
    const data = await feishuGet(`/im/v1/chats/${encodeURIComponent(chatId)}`, token)
    assertFeishuOk(data, '查询群')
    const c = data.data
    return {
      ok: true,
      chatId: c?.chat_id,
      name: c?.name,
      description: c?.description,
      ownerId: c?.owner_id,
      memberCount: c?.member_count,
      status: c?.status
    }
  }
})

export const feishuSearchGroup = tool({
  description: '搜索飞书群聊（按群名关键词），返回匹配的群 chat_id 列表。用于先拿到 chat_id 再发消息。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    query: z.string().describe('群名搜索关键词')
  }),
  execute: async ({ appId, appSecret, query }) => {
    const token = await resolveToken(appId, appSecret)
    const data = await feishuGet(`/im/v1/chats/search?query=${encodeURIComponent(query)}`, token)
    assertFeishuOk(data, '搜索群')
    const items = data.data?.items ?? []
    return {
      ok: true,
      chats: items.map((c: any) => ({ chatId: c.chat_id, name: c.name, description: c.description }))
    }
  }
})

export const feishuCreateDocx = tool({
  description: '在飞书创建一篇云文档（新 docx 文档），返回 document_id 和 URL。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    title: z.string().describe('文档标题'),
    folderToken: z.string().optional().describe('父文件夹 token，不传则创建在「我的空间」')
  }),
  execute: async ({ appId, appSecret, title, folderToken }) => {
    const token = await resolveToken(appId, appSecret)
    const data = await feishuPost('/docx/v1/documents', token, {
      title,
      ...(folderToken ? { folder_token: folderToken } : {})
    })
    assertFeishuOk(data, '创建文档')
    const d = data.data?.document
    return {
      ok: true,
      documentId: d?.document_id,
      title: d?.title,
      url: d?.url
    }
  }
})

export const feishuGetDocx = tool({
  description: '读取飞书云文档的标题和内容（docx 文档）。返回纯文本内容。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    documentId: z.string().describe('文档 document_id')
  }),
  execute: async ({ appId, appSecret, documentId }) => {
    const token = await resolveToken(appId, appSecret)
    const doc = await feishuGet(`/docx/v1/documents/${encodeURIComponent(documentId)}`, token)
    assertFeishuOk(doc, '读取文档信息')
    const blocksResp = await feishuGet(
      `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?page_size=200`,
      token
    )
    assertFeishuOk(blocksResp, '读取文档内容')
    const blocks = blocksResp.data?.items ?? []
    const text = blocks
      .map((b: any) => {
        const textEl = b.text?.elements ?? []
        return textEl.map((e: any) => e.text_run?.content ?? '').join('')
      })
      .filter(Boolean)
      .join('\n')
    return { ok: true, title: doc.data?.document?.title, text }
  }
})

export const feishuSearchCalendar = tool({
  description: '搜索用户的飞书日历，返回日历列表（含日历 ID，可配合后续日历事件工具）。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    query: z.string().optional().describe('日历名称关键词，不传返回全部')
  }),
  execute: async ({ appId, appSecret, query }) => {
    const token = await resolveToken(appId, appSecret)
    const suffix = query ? `?query=${encodeURIComponent(query)}` : ''
    const data = await feishuGet(`/calendar/v4/calendars${suffix}`, token)
    assertFeishuOk(data, '搜索日历')
    const items = data.data?.calendar_list ?? []
    return {
      ok: true,
      calendars: items.map((c: any) => ({
        calendarId: c.calendar_id,
        name: c.summary,
        description: c.description,
        timezone: c.timezone,
        permissions: c.role
      }))
    }
  }
})

export const feishuListCalendarEvents = tool({
  description: '查询飞书日历某个时间段内的事件列表（日程）。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    calendarId: z.string().describe('日历 ID'),
    startTime: z.string().describe('开始时间，RFC3339，如 2026-08-01T00:00:00+08:00'),
    endTime: z.string().describe('结束时间，RFC3339，如 2026-08-07T23:59:59+08:00')
  }),
  execute: async ({ appId, appSecret, calendarId, startTime, endTime }) => {
    const token = await resolveToken(appId, appSecret)
    const data = await feishuGet(
      `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`,
      token
    )
    assertFeishuOk(data, '查询日程')
    const items = data.data?.items ?? []
    return {
      ok: true,
      events: items.map((e: any) => ({
        eventId: e.event_id,
        summary: e.summary,
        description: e.description,
        start: e.start_time?.timestamp ? new Date(Number(e.start_time.timestamp) * 1000).toISOString() : undefined,
        end: e.end_time?.timestamp ? new Date(Number(e.end_time.timestamp) * 1000).toISOString() : undefined,
        status: e.status
      }))
    }
  }
})

export const feishuCreateCalendarEvent = tool({
  description: '在飞书日历创建一条日程事件。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    calendarId: z.string().describe('日历 ID'),
    summary: z.string().describe('日程标题'),
    description: z.string().optional().describe('日程描述'),
    startTimestamp: z.number().describe('开始时间 Unix 秒级时间戳'),
    endTimestamp: z.number().describe('结束时间 Unix 秒级时间戳')
  }),
  execute: async ({ appId, appSecret, calendarId, summary, description, startTimestamp, endTimestamp }) => {
    const token = await resolveToken(appId, appSecret)
    const data = await feishuPost(`/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`, token, {
      summary,
      description,
      start_time: { timestamp: String(startTimestamp) },
      end_time: { timestamp: String(endTimestamp) }
    })
    assertFeishuOk(data, '创建日程')
    return { ok: true, eventId: data.data?.event?.event_id }
  }
})

export const feishuGetApprovalInstances = tool({
  description: '查询飞书审批实例（申请记录），支持按申请状态筛选。用于查看待办/已办审批。',
  inputSchema: z.object({
    appId: z.string().describe('飞书自建应用的 App ID'),
    appSecret: z.string().describe('飞书自建应用的 App Secret'),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELED']).optional().describe('审批状态筛选'),
    pageSize: z.number().optional().default(20).describe('每页条数')
  }),
  execute: async ({ appId, appSecret, status, pageSize }) => {
    const token = await resolveToken(appId, appSecret)
    const params = new URLSearchParams({ page_size: String(pageSize ?? 20) })
    if (status) params.set('status', status)
    const data = await feishuGet(`/approval/v4/instances/search?${params}`, token)
    assertFeishuOk(data, '查询审批')
    const instances = data.data?.instances ?? []
    return {
      ok: true,
      instances: instances.map((i: any) => ({
        instanceCode: i.instance_code,
        title: i.title,
        status: i.status,
        startTime: i.start_time ? new Date(Number(i.start_time) * 1000).toISOString() : undefined,
        definitionName: i.approval?.name
      }))
    }
  }
})

export const FeishuTool = {
  SendText: feishuSendText,
  GetUser: feishuGetUser,
  GetChat: feishuGetChat,
  SearchGroup: feishuSearchGroup,
  CreateDocx: feishuCreateDocx,
  GetDocx: feishuGetDocx,
  SearchCalendar: feishuSearchCalendar,
  ListCalendarEvents: feishuListCalendarEvents,
  CreateCalendarEvent: feishuCreateCalendarEvent,
  GetApprovalInstances: feishuGetApprovalInstances
}

export type FeishuToolKeys = keyof typeof FeishuTool
