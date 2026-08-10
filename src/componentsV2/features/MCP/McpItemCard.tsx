import { Button, Spinner, Switch } from 'heroui-native'
import type { FC } from 'react'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import Text from '@/componentsV2/base/Text'
import { Plus } from '@/componentsV2/icons/LucideIcon'
import PressableRow from '@/componentsV2/layout/PressableRow'
import YStack from '@/componentsV2/layout/YStack'
import { useToast } from '@/hooks/useToast'
import { loggerService } from '@/services/LoggerService'
import { mcpMarketplaceInstallService } from '@/services/mcp/McpMarketplaceInstallService'
import type { MCPServer } from '@/types/mcp'

const logger = loggerService.withContext('McpItemCard')

interface McpItemCardProps {
  mcp: MCPServer
  handleMcpServerItemPress: (mcp: MCPServer) => void
  mode?: 'add' | 'toggle'
  onToggle?: (mcp: MCPServer, isActive: boolean) => void
  assistantId?: string
}

export const McpItemCard: FC<McpItemCardProps> = ({
  mcp,
  handleMcpServerItemPress,
  mode = 'toggle',
  onToggle,
  assistantId
}) => {
  const { t } = useTranslation()
  const toast = useToast()
  const [isAdding, setIsAdding] = useState(false)

  const handlePress = () => {
    handleMcpServerItemPress(mcp)
  }

  const handleAddMcp = async () => {
    if (isAdding) return

    try {
      setIsAdding(true)
      const result = await mcpMarketplaceInstallService.install(mcp, { assistantId })

      if (result.assistantAttachmentRequested && !result.attachedToAssistant) {
        toast.show(t('mcp.market.add.assistant_attach_failed', { mcp_name: result.server.name }), {
          color: 'orange',
          duration: 4000
        })
      } else if (result.toolDiscoveryFailed || result.tools.length === 0) {
        toast.show(t('mcp.market.add.no_tools', { mcp_name: result.server.name }), {
          color: 'orange',
          duration: 4000
        })
      } else if (result.attachedToAssistant) {
        toast.show(
          t('mcp.market.add.success_agent', {
            mcp_name: result.server.name,
            count: result.tools.length
          }),
          { duration: 3000 }
        )
      } else {
        toast.show(t('mcp.market.add.success', { mcp_name: result.server.name }))
      }
    } catch (error) {
      logger.error(`Failed to add MCP preset ${mcp.id}`, error as Error)
      toast.show(t('mcp.server.add_failed'), { color: 'red', duration: 3000 })
    } finally {
      setIsAdding(false)
    }
  }

  const handleSwitchChange = (value: boolean) => {
    onToggle?.(mcp, value)
  }

  return (
    <PressableRow
      onPress={handlePress}
      className="bg-card items-center justify-between gap-2 rounded-2xl px-2.5 py-2.5">
      <YStack className="h-full flex-1 gap-2">
        <Text className="text-lg">{mcp.name}</Text>
        <Text className="text-foreground-secondary text-sm" numberOfLines={1} ellipsizeMode="tail">
          {mcp.description}
        </Text>
      </YStack>
      <YStack className="items-end justify-between gap-2">
        {mode === 'add' ? (
          <Button size="sm" variant="ghost" isIconOnly onPress={handleAddMcp} isDisabled={isAdding}>
            <Button.Label>{isAdding ? <Spinner size="sm" /> : <Plus size={24} />}</Button.Label>
          </Button>
        ) : (
          <Switch isSelected={mcp.isActive} onSelectedChange={handleSwitchChange} />
        )}
        <Text className="primary-badge rounded-lg border-[0.5px] px-2 py-0.5 text-sm">{t(`mcp.type.${mcp.type}`)}</Text>
      </YStack>
    </PressableRow>
  )
}
