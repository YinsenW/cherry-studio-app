import { TrueSheet } from '@lodev09/react-native-true-sheet'
import { Button, cn, Divider, Spinner } from 'heroui-native'
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BackHandler, Keyboard, Platform, Pressable, ScrollView, TouchableWithoutFeedback, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { presentDialog } from '@/componentsV2/base/Dialog/useDialogManager'
import { ExternalLink } from '@/componentsV2/base/ExternalLink'
import Text from '@/componentsV2/base/Text'
import TextField from '@/componentsV2/base/TextField'
import { ShieldCheck, TriangleAlert, X } from '@/componentsV2/icons/LucideIcon'
import XStack from '@/componentsV2/layout/XStack'
import YStack from '@/componentsV2/layout/YStack'
import { useTheme } from '@/hooks/useTheme'
import { useToast } from '@/hooks/useToast'
import { loggerService } from '@/services/LoggerService'
import {
  type McpMarketplaceInstallResult,
  mcpMarketplaceInstallService
} from '@/services/mcp/McpMarketplaceInstallService'
import {
  isMarketplaceConfigurationSatisfied,
  McpMarketplaceError,
  type McpMarketplaceServer,
  type McpMarketplaceServerDetail,
  mcpMarketplaceService
} from '@/services/mcp/McpMarketplaceService'
import { isIOS, isIOS26 } from '@/utils/device'

const SHEET_NAME = 'mcp-marketplace-server-sheet'
const logger = loggerService.withContext('McpMarketplaceServerSheet')

interface McpMarketplaceServerSheetData {
  server: McpMarketplaceServer | null
  assistantId?: string
  onInstalled?: (result: McpMarketplaceInstallResult) => void | Promise<void>
}

const emptySheetData: McpMarketplaceServerSheetData = { server: null }
let currentSheetData: McpMarketplaceServerSheetData = emptySheetData
let updateSheetDataCallback: ((data: McpMarketplaceServerSheetData) => void) | null = null

export const presentMcpMarketplaceServerSheet = (data: McpMarketplaceServerSheetData) => {
  currentSheetData = data
  updateSheetDataCallback?.(data)
  return TrueSheet.present(SHEET_NAME)
}

export const dismissMcpMarketplaceServerSheet = () => TrueSheet.dismiss(SHEET_NAME)

function getMarketplaceErrorKey(error: unknown): string {
  return error instanceof McpMarketplaceError ? error.code : 'UNKNOWN'
}

export const McpMarketplaceServerSheet: React.FC = () => {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const toast = useToast()
  const { bottom } = useSafeAreaInsets()
  const [sheetData, setSheetData] = useState<McpMarketplaceServerSheetData>(currentSheetData)
  const [isVisible, setIsVisible] = useState(false)
  const [detail, setDetail] = useState<McpMarketplaceServerDetail | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [detailRequestNonce, setDetailRequestNonce] = useState(0)
  const [modelScopeToken, setModelScopeToken] = useState('')
  const [configuration, setConfiguration] = useState<Record<string, string>>({})
  const [isInstalling, setIsInstalling] = useState(false)

  const server = sheetData.server
  const serverId = server?.id
  const serverMarketplace = server?.marketplace
  const isModelScope = server?.marketplace === 'modelscope'
  const missingConfiguration = useMemo(
    () =>
      detail?.configuration.filter(
        field => field.required && !isMarketplaceConfigurationSatisfied(field, configuration)
      ) ?? [],
    [configuration, detail?.configuration]
  )

  useEffect(() => {
    updateSheetDataCallback = setSheetData
    return () => {
      updateSheetDataCallback = null
    }
  }, [])

  useEffect(() => {
    setDetail(null)
    setErrorKey(null)
    setConfiguration({})
    setModelScopeToken('')

    if (!serverId || !serverMarketplace) return

    const controller = new AbortController()
    let cancelled = false
    setIsLoading(true)

    const load = async () => {
      try {
        const nextDetail =
          serverMarketplace === 'modelscope'
            ? await mcpMarketplaceService.getModelScopeServer(serverId, controller.signal)
            : await mcpMarketplaceService.getOfficialRegistryServer(serverId, controller.signal)

        if (!cancelled) {
          setDetail(nextDetail)
        }
      } catch (error) {
        if (!cancelled && getMarketplaceErrorKey(error) !== 'REQUEST_ABORTED') {
          setErrorKey(getMarketplaceErrorKey(error))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [detailRequestNonce, serverId, serverMarketplace])

  useEffect(() => {
    if (!isVisible) return

    const backAction = () => {
      if (!isInstalling) dismissMcpMarketplaceServerSheet()
      return true
    }
    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction)
    return () => backHandler.remove()
  }, [isInstalling, isVisible])

  const installServer = async () => {
    if (!detail || isInstalling) return

    try {
      setIsInstalling(true)
      let connection = detail.endpoint ? { endpoint: detail.endpoint } : undefined

      if (detail.marketplace === 'modelscope') {
        if (!modelScopeToken.trim()) {
          throw new McpMarketplaceError('AUTHENTICATION_REQUIRED')
        }
        if (missingConfiguration.length > 0) {
          throw new McpMarketplaceError('CONFIGURATION_REQUIRED')
        }

        const deployment = await mcpMarketplaceService.deployModelScopeServer(detail.id, modelScopeToken, configuration)
        if (deployment.authRequired) {
          throw new McpMarketplaceError('DEPLOYMENT_AUTH_REQUIRED')
        }
        connection = { endpoint: deployment.endpoint }
      } else {
        connection = mcpMarketplaceService.createRemoteConnection(detail, configuration)
      }

      if (!connection) {
        throw new McpMarketplaceError('NO_REMOTE_ENDPOINT')
      }

      const mcpServer = mcpMarketplaceService.toMcpServer(detail, connection)
      const result = await mcpMarketplaceInstallService.install(mcpServer, { assistantId: sheetData.assistantId })

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
      } else if (result.alreadyInstalled) {
        toast.show(t('mcp.market.already_added'), { color: 'orange', duration: 3000 })
      } else {
        toast.show(t('mcp.market.add.success', { mcp_name: result.server.name }), { duration: 3000 })
      }

      await dismissMcpMarketplaceServerSheet()
      try {
        await sheetData.onInstalled?.(result)
      } catch {
        logger.warn('Marketplace MCP installed but post-install navigation failed', { serverId: result.server.id })
      }
    } catch (error) {
      const key = getMarketplaceErrorKey(error)
      // Never log the original error here: deployment failures can include
      // configuration values supplied by the user.
      logger.warn('Marketplace MCP installation failed', { marketplace: detail.marketplace, code: key })
      toast.show(t(`mcp.market.errors.${key}`), { color: 'red', duration: 4000 })
    } finally {
      setIsInstalling(false)
    }
  }

  const handleInstallPress = () => {
    if (!detail) return

    if (detail.marketplace === 'modelscope' && !detail.canDeploy) {
      toast.show(t('mcp.market.local_only'), { color: 'orange', duration: 4000 })
      return
    }
    if (detail.marketplace === 'modelscope' && !modelScopeToken.trim()) {
      toast.show(t('mcp.market.errors.AUTHENTICATION_REQUIRED'), { color: 'orange', duration: 3000 })
      return
    }
    if (missingConfiguration.length > 0) {
      toast.show(t('mcp.market.configuration_required'), { color: 'orange', duration: 3000 })
      return
    }
    if (!isModelScope && !detail.remote) {
      toast.show(t('mcp.market.errors.NO_REMOTE_ENDPOINT'), { color: 'orange', duration: 4000 })
      return
    }

    presentDialog('warning', {
      title: t('mcp.market.install_confirm_title'),
      content: t(
        isModelScope ? 'mcp.market.modelscope.confirm_description' : 'mcp.market.install_confirm_description',
        { name: detail.name }
      ),
      confirmText: t(isModelScope ? 'mcp.market.deploy_and_add' : 'mcp.market.install'),
      cancelText: t('common.cancel'),
      showCancel: true,
      onConfirm: installServer
    })
  }

  const handleDismiss = () => {
    setIsVisible(false)
    setDetail(null)
    setErrorKey(null)
    setConfiguration({})
    setModelScopeToken('')
    setIsInstalling(false)
    currentSheetData = emptySheetData
    setSheetData(emptySheetData)
  }

  const title = detail?.name ?? server?.name ?? ''
  const showLocalOnly = detail?.marketplace === 'modelscope' && !detail.canDeploy
  const showMissingEndpoint = detail?.marketplace === 'registry' && !detail.remote

  return (
    <TrueSheet
      name={SHEET_NAME}
      detents={[0.82]}
      cornerRadius={30}
      grabber={Platform.OS === 'ios'}
      dismissible={!isInstalling}
      dimmed
      backgroundColor={isIOS26 ? undefined : isDark ? '#19191c' : '#ffffff'}
      onDidDismiss={handleDismiss}
      onDidPresent={() => setIsVisible(true)}>
      {!server ? null : (
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <YStack className={cn('gap-4', isIOS ? 'h-[76vh]' : 'h-full')}>
            <YStack className="relative gap-3 px-4 pb-4 pt-5">
              <XStack className="items-center justify-center px-10">
                <Text className="text-center text-xl font-bold" numberOfLines={2}>
                  {title}
                </Text>
              </XStack>
              <Pressable
                style={({ pressed }) => ({
                  position: 'absolute',
                  top: 16,
                  right: 16,
                  padding: 4,
                  backgroundColor: isDark ? '#333333' : '#dddddd',
                  borderRadius: 16,
                  opacity: pressed ? 0.7 : 1
                })}
                disabled={isInstalling}
                onPress={dismissMcpMarketplaceServerSheet}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <X size={16} />
              </Pressable>
              <Text className="text-foreground-secondary text-center text-sm">
                {isModelScope ? t('mcp.market.modelscope.name') : t('mcp.market.registry.name')}
              </Text>
              <Divider />
            </YStack>

            <ScrollView style={{ flex: 1, paddingHorizontal: 16 }} showsVerticalScrollIndicator={false}>
              {isLoading ? (
                <YStack className="items-center py-10">
                  <Spinner />
                  <Text className="text-foreground-secondary mt-3 text-sm">{t('mcp.market.loading_details')}</Text>
                </YStack>
              ) : errorKey ? (
                <YStack className="gap-3 rounded-2xl bg-red-500/10 p-4">
                  <Text className="text-sm text-red-500">{t(`mcp.market.errors.${errorKey}`)}</Text>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="self-start rounded-xl"
                    onPress={() => setDetailRequestNonce(current => current + 1)}>
                    <Button.Label>{t('mcp.market.retry')}</Button.Label>
                  </Button>
                </YStack>
              ) : detail ? (
                <YStack className="gap-4 pb-5">
                  {detail.description ? (
                    <Text className="text-foreground-secondary text-sm">{detail.description}</Text>
                  ) : null}

                  <XStack className="flex-wrap gap-2">
                    {detail.isVerified && (
                      <XStack className="items-center gap-1 rounded-lg bg-emerald-500/10 px-2 py-1">
                        <ShieldCheck size={14} className="text-emerald-500" />
                        <Text className="text-xs text-emerald-500">{t('mcp.market.verified')}</Text>
                      </XStack>
                    )}
                    {detail.securityScanPassed === true && (
                      <XStack className="items-center gap-1 rounded-lg bg-emerald-500/10 px-2 py-1">
                        <ShieldCheck size={14} className="text-emerald-500" />
                        <Text className="text-xs text-emerald-500">{t('mcp.market.security_checked')}</Text>
                      </XStack>
                    )}
                    {detail.tags.map(tag => (
                      <Text key={tag} className="text-foreground-secondary rounded-lg bg-zinc-500/10 px-2 py-1 text-xs">
                        {tag}
                      </Text>
                    ))}
                  </XStack>

                  {detail.securityScanPassed === false && (
                    <XStack className="items-start gap-2 rounded-2xl bg-orange-400/10 p-3">
                      <TriangleAlert size={18} className="mt-0.5 text-orange-400" />
                      <Text className="flex-1 text-sm text-orange-400">{t('mcp.market.security_not_checked')}</Text>
                    </XStack>
                  )}

                  {showLocalOnly && (
                    <XStack className="items-start gap-2 rounded-2xl bg-orange-400/10 p-3">
                      <TriangleAlert size={18} className="mt-0.5 text-orange-400" />
                      <Text className="flex-1 text-sm text-orange-400">{t('mcp.market.local_only')}</Text>
                    </XStack>
                  )}

                  {showMissingEndpoint && (
                    <XStack className="items-start gap-2 rounded-2xl bg-orange-400/10 p-3">
                      <TriangleAlert size={18} className="mt-0.5 text-orange-400" />
                      <Text className="flex-1 text-sm text-orange-400">
                        {t('mcp.market.errors.NO_REMOTE_ENDPOINT')}
                      </Text>
                    </XStack>
                  )}

                  {((detail.marketplace === 'modelscope' && detail.canDeploy) ||
                    (detail.marketplace === 'registry' && detail.configuration.length > 0)) && (
                    <YStack className="bg-card gap-3 rounded-2xl p-3">
                      <Text className="text-base font-semibold">
                        {t(
                          detail.marketplace === 'modelscope'
                            ? 'mcp.market.modelscope.configuration_title'
                            : 'mcp.market.registry.configuration_title'
                        )}
                      </Text>
                      {detail.configuration.map(field => (
                        <YStack key={field.key} className="gap-1">
                          <Text className="text-sm">
                            {field.label ?? field.key}
                            {field.required ? <Text className="text-red-500"> *</Text> : null}
                          </Text>
                          <TextField className="bg-secondary rounded-xl">
                            <TextField.Input
                              value={configuration[field.key] ?? field.defaultValue ?? ''}
                              onChangeText={value => setConfiguration(current => ({ ...current, [field.key]: value }))}
                              placeholder={field.placeholder ?? field.description ?? field.label ?? field.key}
                              secureTextEntry={field.sensitive}
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                          </TextField>
                          {field.description ? (
                            <Text className="text-foreground-secondary text-xs">{field.description}</Text>
                          ) : null}
                        </YStack>
                      ))}

                      {detail.marketplace === 'registry' && (
                        <Text className="text-foreground-secondary text-xs">
                          {t('mcp.market.registry.configuration_description')}
                        </Text>
                      )}

                      {detail.marketplace === 'modelscope' && (
                        <YStack className="border-foreground/10 mt-1 gap-1 border-t pt-3">
                          <XStack className="items-center justify-between gap-2">
                            <Text className="text-sm font-medium">{t('mcp.market.modelscope.token_label')}</Text>
                            <ExternalLink
                              href="https://modelscope.cn/my/myaccesstoken"
                              content={t('mcp.market.modelscope.token_link')}
                            />
                          </XStack>
                          <TextField className="bg-secondary rounded-xl">
                            <TextField.Input
                              value={modelScopeToken}
                              onChangeText={setModelScopeToken}
                              placeholder={t('mcp.market.modelscope.token_placeholder')}
                              secureTextEntry
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                          </TextField>
                          <Text className="text-foreground-secondary text-xs">
                            {t('mcp.market.modelscope.token_description')}
                          </Text>
                        </YStack>
                      )}
                    </YStack>
                  )}
                </YStack>
              ) : null}
            </ScrollView>

            {detail && !showLocalOnly && !showMissingEndpoint && (
              <View className="shrink-0 px-6" style={{ paddingBottom: bottom }}>
                <Button
                  pressableFeedbackVariant="ripple"
                  className="primary-container rounded-[30px] border px-5 py-2.5"
                  onPress={handleInstallPress}
                  isDisabled={isInstalling}>
                  <Button.Label>
                    {isInstalling ? (
                      <Spinner size="sm" />
                    ) : (
                      <Text className="primary-text text-[17px] font-bold">
                        {t(isModelScope ? 'mcp.market.deploy_and_add' : 'mcp.market.install')}
                      </Text>
                    )}
                  </Button.Label>
                </Button>
              </View>
            )}
          </YStack>
        </TouchableWithoutFeedback>
      )}
    </TrueSheet>
  )
}

McpMarketplaceServerSheet.displayName = 'McpMarketplaceServerSheet'

export default McpMarketplaceServerSheet
