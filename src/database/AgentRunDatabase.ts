import {
  createAgentRun,
  deleteAgentArtifact,
  getAgentArtifact,
  getAgentArtifactsForRun,
  getAgentArtifactsForTopic,
  getAgentRunsDueForCleanup,
  interruptRunningAgentRuns,
  publishAgentArtifact,
  recordAgentArtifact,
  updateAgentRun
} from '@db/queries/agentRuns.queries'

export const agentRunDatabase = {
  createRun: createAgentRun,
  updateRun: updateAgentRun,
  interruptRunningRuns: interruptRunningAgentRuns,
  getRunsDueForCleanup: getAgentRunsDueForCleanup,
  recordArtifact: recordAgentArtifact,
  publishArtifact: publishAgentArtifact,
  getArtifact: getAgentArtifact,
  getArtifactsForRun: getAgentArtifactsForRun,
  getArtifactsForTopic: getAgentArtifactsForTopic,
  deleteArtifact: deleteAgentArtifact
}

export { agentRunQueries } from '@db/queries/agentRuns.queries'
