export type AgentId = string

export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

export type AgentState = {
  id: AgentId
  name: string
  status: AgentStatus
  purpose: string
  startedAt: number
  completedAt?: number
  toolUseCount: number
  totalTokens: number
  result?: string
  error?: string
}

export type TaskNotification = {
  taskId: AgentId
  name: string
  status: 'completed' | 'failed'
  summary: string
  result?: string
  usage: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
}
