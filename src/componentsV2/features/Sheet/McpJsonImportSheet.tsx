import { TrueSheet } from '@lodev09/react-native-true-sheet'
import { Button, Spinner } from 'heroui-native'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BackHandler, Keyboard, Platform, Pressable, TouchableWithoutFeedback, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import Text from '@/componentsV2/base/Text'
import TextField from '@/componentsV2/base/TextField'
import { X } from '@/componentsV2/icons'
import XStack from '@/componentsV2/layout/XStack'
import YStack from '@/componentsV2/layout/YStack'
import { useTheme } from '@/hooks/useTheme'
import {
  type McpJsonImportError,
  type McpJsonImportResult,
  parseMcpJsonConfig
} from '@/services/mcp/McpConfigImportService'
import type { MCPServer } from '@/types/mcp'
import { isIOS26 } from '@/utils/device'

const SHEET_NAME = 'mcp-json-import-sheet'

let onImportCallback: ((servers: MCPServer[]) => Promise<void>) | null = null
let updateContentCallback: ((jsonText: string) => void) | null = null

export const presentMcpJsonImportSheet = (onImport: (servers: MCPServer[]) => Promise<void>) => {
  onImportCallback = onImport
  updateContentCallback?.('')
  return TrueSheet.present(SHEET_NAME)
}

export const dismissMcpJsonImportSheet = () => TrueSheet.dismiss(SHEET_NAME)

function getImportErrorText(t: (key: string, options?: Record<string, unknown>) => string, error: McpJsonImportError) {
  return t(`mcp.server.import.errors.${error.code}`, error.name ? { name: error.name } : undefined)
}

export const McpJsonImportSheet: React.FC = () => {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const insets = useSafeAreaInsets()
  const [isVisible, setIsVisible] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [validation, setValidation] = useState<McpJsonImportResult | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  useEffect(() => {
    updateContentCallback = text => {
      setJsonText(text)
      setValidation(null)
      setSaveFailed(false)
      setIsImporting(false)
    }
    return () => {
      updateContentCallback = null
    }
  }, [])

  useEffect(() => {
    if (!isVisible) return

    const backAction = () => {
      if (!isImporting) {
        dismissMcpJsonImportSheet()
      }
      return true
    }

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction)
    return () => backHandler.remove()
  }, [isImporting, isVisible])

  const handleTextChange = (text: string) => {
    setJsonText(text)
    setValidation(null)
    setSaveFailed(false)
  }

  const validate = () => {
    const result = parseMcpJsonConfig(jsonText)
    setValidation(result)
    setSaveFailed(false)
    return result
  }

  const handleImport = async () => {
    const result = validate()
    if (!result.success || !onImportCallback) {
      return
    }

    const importServers = result.servers
    const onImport = onImportCallback
    setIsImporting(true)
    try {
      await onImport(importServers)
      dismissMcpJsonImportSheet()
    } catch {
      setSaveFailed(true)
    } finally {
      setIsImporting(false)
    }
  }

  const handleDismiss = () => {
    setIsVisible(false)
    setValidation(null)
    setSaveFailed(false)
    setIsImporting(false)
    onImportCallback = null
  }

  const error = !validation?.success ? validation?.errors[0] : null
  const previewServers = validation?.success ? validation.servers : []

  const header = (
    <XStack className="border-foreground/10 items-center justify-between border-b px-4 pb-4 pt-5">
      <Text className="text-foreground text-base font-bold">{t('mcp.server.import.title')}</Text>
      <Pressable
        style={({ pressed }) => ({
          padding: 4,
          backgroundColor: isDark ? '#333333' : '#dddddd',
          borderRadius: 16,
          opacity: pressed ? 0.7 : 1
        })}
        onPress={() => {
          if (!isImporting) dismissMcpJsonImportSheet()
        }}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <X size={16} />
      </Pressable>
    </XStack>
  )

  return (
    <TrueSheet
      name={SHEET_NAME}
      detents={[0.78]}
      cornerRadius={30}
      grabber={Platform.OS === 'ios'}
      dismissible={!isImporting}
      dimmed
      backgroundColor={isIOS26 ? undefined : isDark ? '#19191c' : '#ffffff'}
      header={header}
      onDidDismiss={handleDismiss}
      onDidPresent={() => setIsVisible(true)}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View className="h-[520px]" style={{ paddingBottom: insets.bottom + 10 }}>
          <YStack className="flex-1 gap-3 px-4 pb-4">
            <Text className="text-sm opacity-60">{t('mcp.server.import.description')}</Text>
            <TextField className="flex-1 rounded-2xl">
              <TextField.Input
                className="flex-1 border-none p-4 font-mono text-sm"
                placeholder={t('mcp.server.import.placeholder')}
                value={jsonText}
                onChangeText={handleTextChange}
                multiline
                textAlignVertical="top"
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                selectionColor="#2563eb"
                animation={{
                  backgroundColor: {
                    value: {
                      blur: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                      focus: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
                      error: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'
                    }
                  },
                  borderColor: {
                    value: {
                      blur: error || saveFailed ? '#ef4444' : 'transparent',
                      focus: error || saveFailed ? '#ef4444' : 'transparent',
                      error: '#ef4444'
                    }
                  }
                }}
              />
            </TextField>
            {error && <Text className="text-sm text-red-500">{getImportErrorText(t, error)}</Text>}
            {saveFailed && <Text className="text-sm text-red-500">{t('mcp.server.import.errors.SAVE_FAILED')}</Text>}
            {previewServers.length > 0 && (
              <Text className="text-sm text-emerald-500">
                {t('mcp.server.import.preview', {
                  count: previewServers.length,
                  names: previewServers
                    .slice(0, 3)
                    .map(server => server.name)
                    .join('、')
                })}
              </Text>
            )}
            <XStack className="items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="rounded-xl"
                pressableFeedbackVariant="ripple"
                isDisabled={isImporting || !jsonText.trim()}
                onPress={validate}>
                <Button.Label>{t('mcp.server.import.validate')}</Button.Label>
              </Button>
              <Button
                size="sm"
                className="primary-container rounded-xl border"
                pressableFeedbackVariant="ripple"
                isDisabled={isImporting || !jsonText.trim()}
                onPress={() => void handleImport()}>
                <Button.Label className="primary-text">
                  {isImporting ? <Spinner size="sm" /> : t('mcp.server.import.submit')}
                </Button.Label>
              </Button>
            </XStack>
          </YStack>
        </View>
      </TouchableWithoutFeedback>
    </TrueSheet>
  )
}

McpJsonImportSheet.displayName = 'McpJsonImportSheet'
