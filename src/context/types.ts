export type DecayTier = 'full' | 'summary' | 'stub'

export type DecayedMessage = {
  originalTokens: number
  currentTokens: number
  tier: DecayTier
  turnCreated: number
}

export type ContextBudget = {
  maxTokens: number
  currentTokens: number
  tokensSavedByDecay: number
  decayActions: number
}

export type ContextAction = {
  type: 'decay_to_summary' | 'decay_to_stub' | 'compact'
  messageIndex: number
  tokensSaved: number
  tier: DecayTier
}
