// Define the structure for the callbacks that the StreamProcessor will invoke
import { loggerService } from '@/services/LoggerService'
import type { ExternalToolResult } from '@/types'
import type { Chunk } from '@/types/chunk'
import { ChunkType } from '@/types/chunk'
import type { GenerateImageResponse } from '@/types/image'
import type { MCPToolResponse, NormalToolResponse } from '@/types/mcp'
import type { Response } from '@/types/message'
import { AssistantMessageStatus } from '@/types/message'
import type { WebSearchResponse } from '@/types/websearch'
const logger = loggerService.withContext('StreamProcessingService')

// Define the structure for the callbacks that the StreamProcessor will invoke
export interface StreamProcessorCallbacks {
  // LLM response created
  onLLMResponseCreated?: () => void | Promise<void>
  // Text content start
  onTextStart?: () => void | Promise<void>
  // Text content chunk received
  onTextChunk?: (text: string) => void | Promise<void>
  // Full text content received
  onTextComplete?: (text: string) => void | Promise<void>
  // thinking content start
  onThinkingStart?: () => void | Promise<void>
  // Thinking/reasoning content chunk received (e.g., from Claude)
  onThinkingChunk?: (text: string, thinking_millsec?: number) => void | Promise<void>
  onThinkingComplete?: (text: string, thinking_millsec?: number) => void | Promise<void>
  // A tool call response chunk (from MCP)
  onToolCallPending?: (toolResponse: MCPToolResponse | NormalToolResponse) => void | Promise<void>
  onToolCallInProgress?: (toolResponse: MCPToolResponse | NormalToolResponse) => void | Promise<void>
  onToolCallComplete?: (toolResponse: MCPToolResponse | NormalToolResponse) => void | Promise<void>
  // External tool call in progress
  onExternalToolInProgress?: () => void | Promise<void>
  // Citation data received (e.g., from Internet and  Knowledge Base)
  onExternalToolComplete?: (externalToolResult: ExternalToolResult) => void | Promise<void>
  // LLM Web search in progress
  onLLMWebSearchInProgress?: () => void | Promise<void>
  // LLM Web search complete
  onLLMWebSearchComplete?: (llmWebSearchResult: WebSearchResponse) => void | Promise<void>
  // Image generation chunk received
  onImageCreated?: () => void | Promise<void>
  onImageDelta?: (imageData: GenerateImageResponse) => void | Promise<void>
  onImageGenerated?: (imageData?: GenerateImageResponse) => void | Promise<void>
  onLLMResponseComplete?: (response?: Response) => void | Promise<void>
  // Called when an error occurs during chunk processing
  onError?: (error: any) => void | Promise<void>
  // Called when the entire stream processing is signaled as complete (success or failure)
  onComplete?: (status: AssistantMessageStatus, response?: Response) => void | Promise<void>
  // Called when a block is created
  onBlockCreated?: () => void | Promise<void>
}

export type StreamProcessor = ((chunk: Chunk) => Promise<void>) & {
  /** Wait until every previously queued chunk has been persisted. */
  drain: () => Promise<void>
  /** Terminal result observed by the processor. Terminal results are immutable. */
  getTerminalStatus: () => AssistantMessageStatus.SUCCESS | AssistantMessageStatus.ERROR | null
}

// Function to create a stream processor instance. Chunks frequently arrive faster
// than SQLite updates complete, so serialise callbacks to preserve block order.
export function createStreamProcessor(callbacks: StreamProcessorCallbacks = {}): StreamProcessor {
  let terminalStatus: AssistantMessageStatus.SUCCESS | AssistantMessageStatus.ERROR | null = null

  const reportError = async (error: unknown) => {
    if (terminalStatus !== null) {
      logger.debug('Ignoring error after stream reached a terminal state', { terminalStatus })
      return
    }

    // Set the terminal state before invoking application code. Even when the
    // error callback itself fails, a later BLOCK_COMPLETE must never turn the
    // failed stream into a successful message.
    terminalStatus = AssistantMessageStatus.ERROR
    try {
      await callbacks.onError?.(error)
    } catch (onErrorFailure) {
      logger.error('Error while reporting stream processing failure:', onErrorFailure)
    }
  }

  const processChunk = async (chunk: Chunk) => {
    try {
      const data = chunk

      if (terminalStatus === AssistantMessageStatus.ERROR) {
        logger.debug('Ignoring chunk after stream error', { type: data.type })
        return
      }

      if (terminalStatus === AssistantMessageStatus.SUCCESS && data.type !== ChunkType.LLM_RESPONSE_COMPLETE) {
        logger.debug('Ignoring chunk after successful stream completion', { type: data.type })
        return
      }

      switch (data.type) {
        case ChunkType.BLOCK_COMPLETE:
          await callbacks.onComplete?.(AssistantMessageStatus.SUCCESS, data.response)
          terminalStatus = AssistantMessageStatus.SUCCESS
          break

        case ChunkType.LLM_RESPONSE_CREATED:
          await callbacks.onLLMResponseCreated?.()
          break

        case ChunkType.TEXT_START:
          await callbacks.onTextStart?.()
          break

        case ChunkType.TEXT_DELTA:
          await callbacks.onTextChunk?.(data.text)
          break

        case ChunkType.TEXT_COMPLETE:
          await callbacks.onTextComplete?.(data.text)
          break

        case ChunkType.THINKING_START:
          await callbacks.onThinkingStart?.()
          break

        case ChunkType.THINKING_DELTA:
          await callbacks.onThinkingChunk?.(data.text, data.thinking_millsec)
          break

        case ChunkType.THINKING_COMPLETE:
          await callbacks.onThinkingComplete?.(data.text, data.thinking_millsec)
          break

        case ChunkType.MCP_TOOL_PENDING:
          for (const toolResponse of data.responses) {
            await callbacks.onToolCallPending?.(toolResponse)
          }
          break

        case ChunkType.MCP_TOOL_IN_PROGRESS:
          for (const toolResponse of data.responses) {
            await callbacks.onToolCallInProgress?.(toolResponse)
          }
          break

        case ChunkType.MCP_TOOL_COMPLETE:
          for (const toolResponse of data.responses) {
            await callbacks.onToolCallComplete?.(toolResponse)
          }
          break

        case ChunkType.EXTERNEL_TOOL_IN_PROGRESS:
          await callbacks.onExternalToolInProgress?.()
          break

        case ChunkType.EXTERNEL_TOOL_COMPLETE:
          await callbacks.onExternalToolComplete?.(data.external_tool)
          break

        case ChunkType.LLM_WEB_SEARCH_IN_PROGRESS:
          await callbacks.onLLMWebSearchInProgress?.()
          break

        case ChunkType.LLM_WEB_SEARCH_COMPLETE:
          await callbacks.onLLMWebSearchComplete?.(data.llm_web_search)
          break

        case ChunkType.IMAGE_CREATED:
          await callbacks.onImageCreated?.()
          break

        case ChunkType.IMAGE_DELTA:
          await callbacks.onImageDelta?.(data.image)
          break

        case ChunkType.IMAGE_COMPLETE:
          await callbacks.onImageGenerated?.(data.image)
          break

        case ChunkType.LLM_RESPONSE_COMPLETE:
          await callbacks.onLLMResponseComplete?.(data.response)
          break

        case ChunkType.ERROR:
          await reportError(data.error)
          break

        case ChunkType.BLOCK_CREATED:
          await callbacks.onBlockCreated?.()
          break

        default:
          break
      }
    } catch (error) {
      logger.error('Error processing stream chunk:', error)
      await reportError(error)
    }
  }

  let processing = Promise.resolve()
  const recoverProcessingChain = async (error: unknown) => {
    // processChunk catches expected failures itself. This is a last-resort
    // guard so an unforeseen rejected promise cannot poison the serial queue
    // and cause every later streamed chunk to be skipped.
    logger.error('Unexpected stream processing queue failure:', error)
    await reportError(error)
  }

  const streamProcessor = ((chunk: Chunk) => {
    processing = processing
      .then(() => processChunk(chunk))
      .catch(recoverProcessingChain)
      // Keep the queue healthy even if the recovery path itself fails.
      .catch(() => undefined)
    return processing
  }) as StreamProcessor

  streamProcessor.drain = () => processing
  streamProcessor.getTerminalStatus = () => terminalStatus
  return streamProcessor
}
