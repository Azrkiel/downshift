export type RouteStatus = 'running' | 'done' | 'escalated' | 'failed' | 'redone'

export type Route = {
  /** The subagent's id, or the Agent call's when the spawn answered none. */
  id: string
  agent: string
  description: string
  model: string
  reason: string
  status: RouteStatus
  tokens: number
  /** Dollars the run cost on `model`, by the price table. */
  cost: number
  /** Dollars against the same tokens on the parent's model; negative for a run that had to be escalated or was sent again. */
  saved: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': { routes: Route[]; isPaused: boolean }
  }
}
