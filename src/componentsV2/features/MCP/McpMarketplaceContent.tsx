import { Button, Spinner } from 'heroui-native'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ListSkeleton, SearchInput } from '@/componentsV2'
import Text from '@/componentsV2/base/Text'
import { ChevronRight, ShieldCheck } from '@/componentsV2/icons/LucideIcon'
import PressableRow from '@/componentsV2/layout/PressableRow'
import XStack from '@/componentsV2/layout/XStack'
import YStack from '@/componentsV2/layout/YStack'
import { useTheme } from '@/hooks/useTheme'
import type { McpMarketplaceInstallResult } from '@/services/mcp/McpMarketplaceInstallService'
import {
  isMcpMarketplaceError,
  type McpMarketplaceId,
  type McpMarketplaceServer,
  mcpMarketplaceService
} from '@/services/mcp/McpMarketplaceService'

import { presentMcpMarketplaceServerSheet } from './McpMarketplaceServerSheet'

interface McpMarketplaceContentProps {
  marketplace: McpMarketplaceId
  assistantId?: string
  onInstalled?: (result: McpMarketplaceInstallResult) => void | Promise<void>
}

const PAGE_SIZE = 20

function getErrorKey(error: unknown): string {
  return isMcpMarketplaceError(error) ? error.code : 'UNKNOWN'
}

/**
 * Remote marketplaces shown inside the app. Each result opens a detail sheet
 * first so its transport, deployment requirements, and security status are
 * checked before anything is written to the MCP database.
 */
export const McpMarketplaceContent: React.FC<McpMarketplaceContentProps> = ({
  marketplace,
  assistantId,
  onInstalled
}) => {
  const { t } = useTranslation()
  const { bottom } = useSafeAreaInsets()
  const { isDark } = useTheme()
  const [query, setQuery] = useState('')
  const [servers, setServers] = useState<McpMarketplaceServer[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState<number | undefined>()
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const requestId = useRef(0)
  const activeRequestController = useRef<AbortController | null>(null)

  const loadPage = useCallback(
    async (nextPage: number, append = false, cursor?: string) => {
      if (!append) {
        activeRequestController.current?.abort()
      }
      const controller = new AbortController()
      activeRequestController.current = controller
      const currentRequest = ++requestId.current
      setErrorKey(null)
      if (append) {
        setIsLoadingMore(true)
      } else {
        setIsLoading(true)
      }

      try {
        const result =
          marketplace === 'modelscope'
            ? await mcpMarketplaceService.searchModelScope({
                query,
                page: nextPage,
                pageSize: PAGE_SIZE,
                signal: controller.signal
              })
            : await mcpMarketplaceService.searchOfficialRegistry({
                query,
                page: nextPage,
                pageSize: PAGE_SIZE,
                cursor,
                signal: controller.signal
              })

        if (currentRequest !== requestId.current) return
        setServers(current => {
          if (!append) return result.servers
          const known = new Set(current.map(server => `${server.marketplace}:${server.id}`))
          return [...current, ...result.servers.filter(server => !known.has(`${server.marketplace}:${server.id}`))]
        })
        setTotalCount(current =>
          append && marketplace === 'registry' ? current + result.servers.length : result.totalCount
        )
        setPage(result.page)
        setTotalPages(result.totalPages)
        setNextCursor(result.nextCursor)
      } catch (error) {
        if (currentRequest !== requestId.current || getErrorKey(error) === 'REQUEST_ABORTED') return
        setErrorKey(getErrorKey(error))
        if (!append) {
          setServers([])
          setTotalCount(0)
          setTotalPages(undefined)
          setNextCursor(undefined)
        }
      } finally {
        if (currentRequest === requestId.current) {
          if (activeRequestController.current === controller) {
            activeRequestController.current = null
          }
          setIsLoading(false)
          setIsLoadingMore(false)
        }
      }
    },
    [marketplace, query]
  )

  useEffect(() => {
    const timer = setTimeout(
      () => {
        void loadPage(1)
      },
      query.trim() ? 350 : 0
    )
    return () => clearTimeout(timer)
  }, [loadPage, query])

  useEffect(() => {
    return () => {
      // Make any late response from an unmounted tab stale.
      requestId.current += 1
      activeRequestController.current?.abort()
      activeRequestController.current = null
    }
  }, [])

  const handleOpenServer = (server: McpMarketplaceServer) => {
    presentMcpMarketplaceServerSheet({ server, assistantId, onInstalled })
  }

  const hasMore =
    marketplace === 'registry'
      ? Boolean(nextCursor)
      : totalPages !== undefined
        ? page < totalPages
        : servers.length < totalCount
  const marketplaceKey = marketplace === 'modelscope' ? 'modelscope' : 'registry'

  return (
    <YStack className="flex-1 gap-2.5">
      <YStack className="bg-card gap-2 rounded-2xl p-3">
        <Text className="text-base font-semibold">{t(`mcp.market.${marketplaceKey}.name`)}</Text>
        <Text className="text-foreground-secondary text-sm">{t(`mcp.market.${marketplaceKey}.description`)}</Text>
      </YStack>

      <SearchInput placeholder={t('mcp.market.search_placeholder')} value={query} onChangeText={setQuery} />

      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottom + 12 }}>
        {isLoading ? (
          <ListSkeleton variant="mcp" count={5} />
        ) : errorKey ? (
          <YStack className="gap-3 rounded-2xl bg-red-500/10 p-4">
            <Text className="text-sm text-red-500">{t(`mcp.market.errors.${errorKey}`)}</Text>
            <Button size="sm" variant="ghost" className="self-start rounded-xl" onPress={() => void loadPage(1)}>
              <Button.Label>{t('mcp.market.retry')}</Button.Label>
            </Button>
          </YStack>
        ) : servers.length === 0 ? (
          <YStack className="items-center gap-2 px-6 py-12">
            <Text className="text-foreground-secondary text-center text-sm">{t('mcp.market.empty')}</Text>
            {hasMore && (
              <Button
                variant="ghost"
                className="mt-2 rounded-xl"
                onPress={() => void loadPage(page + 1, true, marketplace === 'registry' ? nextCursor : undefined)}
                isDisabled={isLoadingMore}>
                <Button.Label>{isLoadingMore ? <Spinner size="sm" /> : t('mcp.market.load_more')}</Button.Label>
              </Button>
            )}
          </YStack>
        ) : (
          <YStack className="gap-2">
            {servers.map(server => (
              <PressableRow
                key={`${server.marketplace}:${server.id}`}
                onPress={() => handleOpenServer(server)}
                className="bg-card gap-3 rounded-2xl px-3 py-3">
                <YStack className="min-w-0 flex-1 gap-1">
                  <XStack className="items-center gap-1.5">
                    <Text className="flex-shrink text-base font-medium" numberOfLines={1}>
                      {server.name}
                    </Text>
                    {server.isVerified && <ShieldCheck size={14} className="text-emerald-500" />}
                  </XStack>
                  {server.description ? (
                    <Text className="text-foreground-secondary text-sm" numberOfLines={2} ellipsizeMode="tail">
                      {server.description}
                    </Text>
                  ) : null}
                  {server.tags.length > 0 ? (
                    <Text className="text-foreground-secondary text-xs" numberOfLines={1}>
                      {server.tags.slice(0, 3).join(' · ')}
                    </Text>
                  ) : null}
                </YStack>
                <YStack accessibilityLabel={t('mcp.market.open_details', { name: server.name })}>
                  <ChevronRight size={20} className={isDark ? 'text-zinc-400' : 'text-zinc-500'} />
                </YStack>
              </PressableRow>
            ))}

            {hasMore && (
              <Button
                variant="ghost"
                className="mt-2 self-center rounded-xl"
                onPress={() => void loadPage(page + 1, true, marketplace === 'registry' ? nextCursor : undefined)}
                isDisabled={isLoadingMore}>
                <Button.Label>{isLoadingMore ? <Spinner size="sm" /> : t('mcp.market.load_more')}</Button.Label>
              </Button>
            )}
          </YStack>
        )}
      </ScrollView>
    </YStack>
  )
}
