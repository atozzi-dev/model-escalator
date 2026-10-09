// State contract: the named values this plugin keeps in `$.state`, checked by `claude plugin validate`.
// Self-contained on purpose (a contract may not import); hooks/state.ts must stay assignable to it.
declare module 'claude-code' {
  interface PluginState {
    'model-escalator': {
      session: {
        agents: {
          id: string
          category: string
          task: string
          startTier: 'haiku' | 'sonnet' | 'opus'
          tier: 'haiku' | 'sonnet' | 'opus'
          score: number
          level: number
          stepsSinceAction: number
          stepsSinceProgress: number
          errorCounts: Record<string, number>
          editCounts: Record<string, number>
          lastFailing?: number
          log: string[]
          tokens: number
          lastEventAt?: number
          inFlight?: number
          running?: boolean
          stalled?: boolean
          recentErrors?: string[]
          consults?: number
          paused?: boolean
          progressSignals?: number
          deescalated?: boolean
        }[]
        ledger: {
          actual: number
          baselineHigh: number
          baselineLow: number
          agentSteps: number
          byTier: Partial<Record<'haiku' | 'sonnet' | 'opus', { steps: number; cost: number }>>
          consults: number
          consultCost: number
          interventions: Record<string, number>
        }
        seenModels: Partial<Record<'haiku' | 'sonnet' | 'opus', string>>
        sessionTag: string
        mode: 'active' | 'observe' | 'baseline' | 'off'
        baseline: 'haiku' | 'sonnet' | 'opus'
        baselinePinned: boolean
        blockedTiers?: ('haiku' | 'sonnet' | 'opus')[]
        refusedSeniors?: ('haiku' | 'sonnet' | 'opus')[]
      }
    }
  }
}
