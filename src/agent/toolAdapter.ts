import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Tool as PiTool } from '@earendil-works/pi-ai'
import { jsonSchema, type Tool } from 'ai'
import type { ZodType } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

/**
 * 把 Cherry 现有的 AI SDK 工具（SystemTools 里的提醒、日历、快捷指令、
 * 时间、网络等）适配为 pi-agent-core 的 AgentTool。
 *
 * AI SDK tool 的 inputSchema 是 zod schema，pi 的 parameters 是
 * JSON Schema 形状（typebox），用 zod-to-json-schema 转换。
 */
export function aiSdkToolToAgentTool(name: string, aiTool: Tool): AgentTool {
  const inputSchema = aiTool.inputSchema as ZodType | object | undefined
  const parameters =
    inputSchema && typeof (inputSchema as ZodType).safeParse === 'function'
      ? zodToJsonSchema(inputSchema as ZodType)
      : (inputSchema as object)

  return {
    name,
    label: name,
    description: aiTool.description ?? name,
    parameters: parameters as AgentTool['parameters'],
    execute: async (callId, args, _signal, _onUpdate) => {
      if (!aiTool.execute) {
        throw new Error(`Tool "${name}" has no execute function`)
      }
      const result = await aiTool.execute(args, undefined as never)
      const text =
        typeof result === 'string'
          ? result
          : typeof result === 'object' && result !== null
            ? JSON.stringify(result, null, 2)
            : String(result)
      return { content: [{ type: 'text', text }], details: { raw: result } }
    }
  }
}

/**
 * 把 pi 的 AgentTool 反向适配为 AI SDK tool，供 streamText 声明工具用。
 *
 * 关键：**不传 execute**。AI SDK 的 streamText 会对带 execute 的工具
 * 自动执行并自动续轮，那样工具调用就绕过了 pi agent（tool_execution
 * 事件永不触发，UI 看不到工具）。去掉 execute 后，AI SDK 只把模型
 * 发出的 tool-call 作为 chunk 声明，由 pi agent 自己执行工具并把结果
 * 通过 toolResult 消息送回下一轮。
 */
export function agentToolToAiSdkTool(agentTool: PiTool): Tool {
  const toolAny = agentTool as unknown as AgentTool
  return {
    description: toolAny.description ?? agentTool.name,
    // AI SDK 需要 Schema 对象（非裸 JSON）。pi 的 parameters 是 JSON Schema 形状（typebox），用 jsonSchema 包装。
    inputSchema: jsonSchema(toolAny.parameters as Record<string, unknown>)
  }
}
