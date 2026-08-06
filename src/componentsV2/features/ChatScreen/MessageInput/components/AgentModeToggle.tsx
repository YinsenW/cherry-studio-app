import React from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, View } from 'react-native'

import Text from '@/componentsV2/base/Text'
import XStack from '@/componentsV2/layout/XStack'
import { usePreference } from '@/hooks/usePreference'

/**
 * Agent 模式开关：开启后消息发送走 pi agent 循环（自主多步工具编排）。
 * 状态持久化到偏好（agent.mode_enabled）。
 */
export function AgentModeToggle() {
  const { t } = useTranslation()
  const [agentMode, setAgentMode] = usePreference('agent.mode_enabled')

  return (
    <Pressable
      className="flex-row items-center justify-between rounded-lg px-2 py-1.5 active:bg-slate-100 dark:active:bg-slate-800"
      onPress={() => setAgentMode(!agentMode)}>
      <XStack className="items-center gap-1.5">
        <Text className="text-xs text-slate-500 dark:text-slate-400">{t('agent.mode')}</Text>
        {agentMode && (
          <View className="rounded bg-purple-100 px-1.5 py-0.5 dark:bg-purple-900/40">
            <Text className="text-[10px] font-medium text-purple-700 dark:text-purple-300">{t('agent.modeActive')}</Text>
          </View>
        )}
      </XStack>
      <View
        className={`h-5 w-9 rounded-full px-0.5 ${agentMode ? 'items-end bg-purple-600' : 'items-start bg-slate-300 dark:bg-slate-600'}`}
        style={{ justifyContent: 'center' }}>
        <View className="h-4 w-4 rounded-full bg-white" />
      </View>
    </Pressable>
  )
}
