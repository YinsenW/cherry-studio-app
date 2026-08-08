import { TrueSheet } from '@lodev09/react-native-true-sheet'
import { Directory } from 'expo-file-system'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard, Platform, View } from 'react-native'

import type { WorkspaceDescriptor } from '@/agent/workspace/types'
import { workspaceService } from '@/agent/workspace/WorkspaceService'
import { presentDialog } from '@/componentsV2/base/Dialog'
import type { SelectionSheetItem } from '@/componentsV2/base/SelectionSheet'
import SelectionSheet from '@/componentsV2/base/SelectionSheet'
import { Folder, HardDrive, Plus } from '@/componentsV2/icons'

const SHEET_NAME = 'global-agent-workspace-sheet'

type AgentWorkspaceSheetData = {
  topicId: string | null
}

const defaultSheetData: AgentWorkspaceSheetData = { topicId: null }
let currentSheetData = defaultSheetData
let updateSheetDataCallback: ((data: AgentWorkspaceSheetData) => void) | null = null

export const presentAgentWorkspaceSheet = (topicId: string) => {
  currentSheetData = { topicId }
  updateSheetDataCallback?.(currentSheetData)
  Keyboard.dismiss()
  return TrueSheet.present(SHEET_NAME)
}

export const dismissAgentWorkspaceSheet = () => TrueSheet.dismiss(SHEET_NAME)

const isPickerCancellation = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /cancel|dismiss|abort/i.test(message)
}

const showWorkspaceError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  presentDialog('error', {
    title: 'Workspace unavailable',
    content: message || 'The workspace could not be opened.'
  })
}

export const AgentWorkspaceSheet: React.FC = () => {
  const { t } = useTranslation()
  const [sheetData, setSheetData] = useState<AgentWorkspaceSheetData>(currentSheetData)
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)

  useEffect(() => {
    updateSheetDataCallback = setSheetData
    return () => {
      updateSheetDataCallback = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!sheetData.topicId) return
      try {
        const [available, active] = await Promise.all([
          workspaceService.listWorkspaces(),
          workspaceService.getWorkspaceForTopic(sheetData.topicId)
        ])
        if (!cancelled) {
          setWorkspaces(available)
          setActiveWorkspaceId(active.id)
        }
      } catch (error) {
        if (!cancelled) showWorkspaceError(error)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [sheetData.topicId])

  const bindWorkspace = useCallback(
    async (workspace: WorkspaceDescriptor) => {
      if (!sheetData.topicId) return
      try {
        await workspaceService.bindTopic(sheetData.topicId, workspace.id)
        setActiveWorkspaceId(workspace.id)
        dismissAgentWorkspaceSheet()
      } catch (error) {
        showWorkspaceError(error)
      }
    },
    [sheetData.topicId]
  )

  const pickExternalWorkspace = useCallback(async () => {
    try {
      const directory = await Directory.pickDirectoryAsync()
      const kind = Platform.OS === 'android' ? 'android_saf' : 'ios_session'
      const name = Platform.OS === 'android' ? t('agent.workspace.androidFolder') : t('agent.workspace.iosFolder')
      const workspace = await workspaceService.createPickedWorkspace(name, directory, kind)
      if (sheetData.topicId) await workspaceService.bindTopic(sheetData.topicId, workspace.id)
      setWorkspaces(previous => [...previous, workspace])
      setActiveWorkspaceId(workspace.id)
      dismissAgentWorkspaceSheet()
    } catch (error) {
      if (!isPickerCancellation(error)) showWorkspaceError(error)
    }
  }, [sheetData.topicId, t])

  const items = useMemo<SelectionSheetItem[]>(() => {
    const workspaceItems = workspaces.map(workspace => ({
      key: workspace.id,
      label: workspace.name,
      description:
        workspace.kind === 'app_sandbox'
          ? t('agent.workspace.privateDescription')
          : workspace.kind === 'android_saf'
            ? t('agent.workspace.androidDescription')
            : t('agent.workspace.iosDescription'),
      icon: <Folder size={20} />,
      isSelected: workspace.id === activeWorkspaceId,
      onSelect: () => void bindWorkspace(workspace)
    }))

    if (Platform.OS === 'web') return workspaceItems
    return [
      ...workspaceItems,
      {
        key: 'pick-external-workspace',
        label: t('agent.workspace.pickFolder'),
        description: t('agent.workspace.pickFolderDescription'),
        icon: Platform.OS === 'android' ? <HardDrive size={20} /> : <Plus size={20} />,
        onSelect: () => void pickExternalWorkspace()
      }
    ]
  }, [activeWorkspaceId, bindWorkspace, pickExternalWorkspace, t, workspaces])

  return (
    <SelectionSheet
      name={SHEET_NAME}
      detents={['auto', 0.65]}
      items={items}
      placeholder={t('agent.workspace.title')}
      emptyContent={<View />}
    />
  )
}
