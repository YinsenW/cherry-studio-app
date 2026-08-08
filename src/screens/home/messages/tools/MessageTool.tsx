import React from 'react'

import type { MCPToolResponse, NormalToolResponse } from '@/types/mcp'
import type { ToolMessageBlock } from '@/types/message'

import MessageMcpTool from './MessageMcpTool'
import { MessageWebSearchToolTitle } from './MessageWebSearchTool'
// import { MessageKnowledgeSearchToolTitle } from './MessageKnowledgeSearchTool'

interface Props {
  block: ToolMessageBlock
}
const prefix = 'builtin_'

const ChooseTool = (
  toolResponse: MCPToolResponse | NormalToolResponse
): { label: React.ReactNode; body: React.ReactNode } | null => {
  if (!('serverId' in toolResponse.tool)) {
    return null
  }

  const mcpToolResponse = toolResponse as MCPToolResponse
  let toolName = mcpToolResponse.tool.name

  if (toolName.startsWith(prefix)) {
    toolName = toolName.slice(prefix.length)
  }

  switch (toolName) {
    case 'web_search':
    case 'web_search_preview':
      return {
        label: <MessageWebSearchToolTitle toolResponse={mcpToolResponse} />,
        body: null
      }
    default:
      return null
  }
}

export default function MessageTool({ block }: Props) {
  // FIXME: 语义错误，这里已经不是 MCP tool 了,更改rawMcpToolResponse需要改用户数据, 所以暂时保留
  const toolResponse = block.metadata?.rawMcpToolResponse

  if (!toolResponse) return null

  const toolRenderer = ChooseTool(toolResponse)

  if (!toolRenderer) return <MessageMcpTool block={block} />

  return toolRenderer.label
}
