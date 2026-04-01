import type { AgentId, AgentState, AgentStatus } from './types.js'
import { shortId } from '../utils/format.js'

export function createAgentRegistry() {
  const agents = new Map<AgentId, AgentState>()
  const nameToId = new Map<string, AgentId>()

  return {
    register(name: string, purpose: string): AgentState {
      const id = `agent_${shortId()}`
      const state: AgentState = {
        id,
        name,
        status: 'pending',
        purpose,
        startedAt: Date.now(),
        toolUseCount: 0,
        totalTokens: 0,
      }
      agents.set(id, state)
      nameToId.set(name, id)
      return state
    },

    update(id: AgentId, patch: Partial<AgentState>): void {
      const agent = agents.get(id)
      if (agent) Object.assign(agent, patch)
    },

    get(id: AgentId): AgentState | undefined {
      return agents.get(id)
    },

    getByName(name: string): AgentState | undefined {
      const id = nameToId.get(name)
      return id ? agents.get(id) : undefined
    },

    getAll(): AgentState[] {
      return [...agents.values()]
    },

    getActive(): AgentState[] {
      return [...agents.values()].filter(a => a.status === 'running' || a.status === 'pending')
    },

    getCompleted(): AgentState[] {
      return [...agents.values()].filter(a => a.status === 'completed' || a.status === 'failed')
    },

    kill(id: AgentId): void {
      const agent = agents.get(id)
      if (agent && (agent.status === 'running' || agent.status === 'pending')) {
        agent.status = 'killed'
        agent.completedAt = Date.now()
      }
    },
  }
}

export type AgentRegistry = ReturnType<typeof createAgentRegistry>
