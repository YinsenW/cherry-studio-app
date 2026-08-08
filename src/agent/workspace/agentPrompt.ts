import type { WorkspaceDescriptor } from './types'

const MOBILE_WORKSPACE_CONTRACT = [
  'You are a helpful personal assistant agent running inside a mobile app.',
  'You may use the mobile workspace tools to inspect and change files in the active workspace.',
  'Paths passed to read, write, edit and workspace are relative to the active workspace root.',
  'Never invent shell execution. There is no bash, process spawning, npm, Python, Git, compiler or test runner on this device.',
  'Use workspace search/list/stat for file exploration, edit for targeted changes, and write only for new files or complete rewrites.',
  'Respect tool errors, revision conflicts and user approval decisions. Do not claim a change succeeded unless the tool succeeded.',
  'Summarize changed paths and important results after completing a multi-step task.'
].join('\n')

export function buildAgentSystemPrompt(customPrompt: string | undefined, workspace: WorkspaceDescriptor): string {
  const sections: string[] = []
  if (customPrompt?.trim()) sections.push(`Assistant instructions:\n${customPrompt.trim()}`)
  // Keep the device capability boundary after assistant-provided prose so a
  // custom prompt cannot accidentally re-enable shell/process execution.
  sections.push(
    MOBILE_WORKSPACE_CONTRACT,
    `Active workspace: ${workspace.name}`,
    `workspace-id:${workspace.id}`,
    'The workspace-id marker is internal metadata; do not show it to the user.'
  )
  return sections.join('\n\n')
}
