import type { Assistant } from '@/types/assistant'
import type { MCPServer } from '@/types/mcp'

import { attachMcpServersToAssistant } from '../McpAssistantBindingService'

jest.mock('@/services/AssistantService', () => ({
  assistantService: {
    getAssistant: jest.fn(),
    updateAssistant: jest.fn()
  }
}))

jest.mock('@/services/LoggerService', () => ({
  loggerService: {
    withContext: () => ({
      warn: jest.fn()
    })
  }
}))

const existingServer: MCPServer = {
  id: 'existing-server',
  name: 'Existing',
  type: 'streamableHttp',
  baseUrl: 'https://existing.example/mcp',
  isActive: true
}

const manualServer: MCPServer = {
  id: 'manual-server',
  name: 'Manual Search',
  type: 'streamableHttp',
  baseUrl: 'https://manual.example/mcp',
  isActive: true
}

const assistant: Assistant = {
  id: 'assistant-1',
  name: 'Agent',
  prompt: '',
  type: 'system',
  topics: [],
  mcpServers: [existingServer]
}

describe('attachMcpServersToAssistant', () => {
  it('preserves existing bindings and attaches a manually configured server', async () => {
    const service = {
      getAssistant: jest.fn(async () => assistant),
      updateAssistant: jest.fn(async () => undefined)
    }

    await expect(attachMcpServersToAssistant(assistant.id, [manualServer], service)).resolves.toBe(true)

    expect(service.updateAssistant).toHaveBeenCalledWith(assistant.id, {
      mcpServers: [existingServer, manualServer]
    })
  })

  it('replaces a stale binding snapshot instead of creating duplicate IDs', async () => {
    const staleManualServer = { ...manualServer, baseUrl: 'https://old.example/mcp', isActive: false }
    const service = {
      getAssistant: jest.fn(async () => ({ ...assistant, mcpServers: [existingServer, staleManualServer] })),
      updateAssistant: jest.fn(async () => undefined)
    }

    await expect(attachMcpServersToAssistant(assistant.id, [manualServer, manualServer], service)).resolves.toBe(true)

    expect(service.updateAssistant).toHaveBeenCalledWith(assistant.id, {
      mcpServers: [existingServer, manualServer]
    })
  })

  it('keeps global installation successful when no current Assistant can be bound', async () => {
    const service = {
      getAssistant: jest.fn(async () => null),
      updateAssistant: jest.fn(async () => undefined)
    }

    await expect(attachMcpServersToAssistant(assistant.id, [manualServer], service)).resolves.toBe(false)
    expect(service.updateAssistant).not.toHaveBeenCalled()
  })
})
