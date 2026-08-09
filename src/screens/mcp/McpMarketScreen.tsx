import type { RouteProp } from '@react-navigation/native'
import { useNavigation, useRoute } from '@react-navigation/native'
import { cn, Tabs } from 'heroui-native'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InteractionManager } from 'react-native'

import { Container, HeaderBar, ListSkeleton, SafeAreaContainer, SearchInput } from '@/componentsV2'
import { McpMarketContent } from '@/componentsV2/features/MCP/McpMarketContent'
import { McpMarketplaceContent } from '@/componentsV2/features/MCP/McpMarketplaceContent'
import { presentMcpServerItemSheet } from '@/componentsV2/features/MCP/McpServerItemSheet'
import XStack from '@/componentsV2/layout/XStack'
import { initBuiltinMcp } from '@/config/mcp'
import { useSearch } from '@/hooks/useSearch'
import type { McpStackParamList } from '@/navigators/McpStackNavigator'
import type { McpMarketplaceInstallResult } from '@/services/mcp/McpMarketplaceInstallService'
import type { MCPServer } from '@/types/mcp'
import type { McpNavigationProps } from '@/types/naviagate'

type McpMarketTab = 'builtin' | 'modelscope' | 'registry'

const MARKET_TABS: { value: McpMarketTab; labelKey: string }[] = [
  { value: 'builtin', labelKey: 'mcp.market.builtin' },
  { value: 'modelscope', labelKey: 'mcp.market.modelscope.tab' },
  { value: 'registry', labelKey: 'mcp.market.registry.tab' }
]

export function McpMarketScreen() {
  const { t } = useTranslation()
  const navigation = useNavigation<McpNavigationProps>()
  const route = useRoute<RouteProp<McpStackParamList, 'McpMarketScreen'>>()
  const assistantId = route.params?.assistantId
  const [isReady, setIsReady] = useState(false)
  const [activeTab, setActiveTab] = useState<McpMarketTab>('builtin')
  const mcpServers = useMemo(() => initBuiltinMcp(), [])
  const {
    searchText,
    setSearchText,
    filteredItems: filteredMcps
  } = useSearch(
    mcpServers,
    useCallback((mcp: MCPServer) => [mcp.name || '', mcp.id || ''], [])
  )

  useEffect(() => {
    const interaction = InteractionManager.runAfterInteractions(() => {
      setIsReady(true)
    })
    return () => interaction.cancel()
  }, [])

  const handleMcpServerItemPress = (mcp: MCPServer) => {
    presentMcpServerItemSheet(mcp, { mode: 'preview' })
  }

  const handleMarketplaceInstalled = useCallback(
    async (result: McpMarketplaceInstallResult) => {
      navigation.navigate('McpDetailScreen', { mcpId: result.server.id })
    },
    [navigation]
  )

  return (
    <SafeAreaContainer className="pb-0">
      <HeaderBar title={t('mcp.market.title')} />
      <Container className="gap-2.5 py-0">
        <Tabs value={activeTab} onValueChange={value => setActiveTab(value as McpMarketTab)}>
          <Tabs.ScrollView>
            <Tabs.List aria-label={t('mcp.market.title')} className="bg-transparent px-0">
              <Tabs.Indicator className="primary-container rounded-xl border" />
              <XStack className="gap-1">
                {MARKET_TABS.map(tab => (
                  <Tabs.Trigger key={tab.value} value={tab.value}>
                    <Tabs.Label className={cn(activeTab === tab.value ? 'primary-text' : undefined)}>
                      {t(tab.labelKey)}
                    </Tabs.Label>
                  </Tabs.Trigger>
                ))}
              </XStack>
            </Tabs.List>
          </Tabs.ScrollView>
        </Tabs>

        {!isReady ? (
          <ListSkeleton variant="mcp" />
        ) : activeTab === 'builtin' ? (
          <>
            <SearchInput placeholder={t('common.search_placeholder')} value={searchText} onChangeText={setSearchText} />
            <McpMarketContent mcps={filteredMcps} handleMcpServerItemPress={handleMcpServerItemPress} mode="add" />
          </>
        ) : (
          <McpMarketplaceContent
            key={activeTab}
            marketplace={activeTab}
            assistantId={assistantId}
            onInstalled={handleMarketplaceInstalled}
          />
        )}
      </Container>
    </SafeAreaContainer>
  )
}
