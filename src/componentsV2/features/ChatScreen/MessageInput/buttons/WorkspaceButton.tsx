import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard } from 'react-native'

import { workspaceService } from '@/agent/workspace/WorkspaceService'
import { IconButton } from '@/componentsV2/base/IconButton'
import Text from '@/componentsV2/base/Text'
import { Folder } from '@/componentsV2/icons'
import XStack from '@/componentsV2/layout/XStack'

import { presentAgentWorkspaceSheet } from '../../../Sheet/AgentWorkspaceSheet'
import { useMessageInput } from '../context/MessageInputContext'

export const WorkspaceButton: React.FC = () => {
  const { t } = useTranslation()
  const { topic } = useMessageInput()
  const [workspaceName, setWorkspaceName] = useState(t('agent.workspace.defaultName'))

  useEffect(() => {
    let cancelled = false
    void workspaceService
      .getWorkspaceForTopic(topic.id)
      .then(workspace => {
        if (!cancelled) setWorkspaceName(workspace.name)
      })
      .catch(() => {
        // The picker/sheet presents the detailed error when the workspace is
        // actually opened. Keep the accessory bar usable in the meantime.
      })
    return () => {
      cancelled = true
    }
  }, [topic.id])

  return (
    <IconButton
      onPress={() => {
        Keyboard.dismiss()
        presentAgentWorkspaceSheet(topic.id)
      }}
      icon={
        <XStack className="message-input-container max-w-[150px] items-center gap-1 rounded-xl border-[0.5px] px-2 py-1">
          <Folder size={18} />
          <Text className="max-w-[115px] text-xs" numberOfLines={1} ellipsizeMode="tail">
            {workspaceName || t('agent.workspace.defaultName')}
          </Text>
        </XStack>
      }
    />
  )
}
