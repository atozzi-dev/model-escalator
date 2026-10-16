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
          retryEdits?: Record<string, number>
          editMarks?: Record<string, number>
          lastFailing?: number
          requests?: number
          messageCalls?: number
          messageTools?: number
          message?: number
          messageSigs?: string[]
          outputs?: Record<string, { c: string; e: number }>
          log: string[]
          tokens: number
          lastEventAt?: number
          inFlight?: number
          running?: boolean
          stalled?: boolean
          recentErrors?: string[]
          consults?: number
          runCost?: number
          escCounted?: boolean
          paused?: boolean
          progressSignals?: number
          deescalated?: boolean
          effortSeen?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number | null
          effortBoosted?: boolean
          name?: string
          taskTitle?: string
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
          byCategory?: Record<string, { steps: number; actual: number; baselineHigh: number; baselineLow: number; agents: number; escalated: number }>
        }
        seenModels: Partial<Record<'haiku' | 'sonnet' | 'opus', string>>
        sessionTag: string
        mode: 'active' | 'observe' | 'baseline' | 'off'
        baseline: 'haiku' | 'sonnet' | 'opus'
        baselinePinned: boolean
        blockedTiers?: ('haiku' | 'sonnet' | 'opus')[]
        refusedSeniors?: ('haiku' | 'sonnet' | 'opus')[]
        graph?: {
          readonly nodes: readonly {
            readonly id: string
            readonly kind: 'lead' | 'worker' | 'senior'
            readonly label: string
            readonly model: string
            readonly tier: 'haiku' | 'sonnet' | 'opus'
            readonly status: 'active' | 'waiting' | 'done' | 'stuck' | 'paused'
            readonly action: string
            readonly level: number
            readonly score: number
            readonly cost: number
            readonly interventions: number
            readonly consults: number
            readonly since: number
          }[]
          readonly edges: readonly {
            readonly id: string
            readonly kind: 'spawn' | 'message' | 'consult' | 'notice'
            readonly from: string
            readonly to: string
            readonly count: number
            readonly at: number
          }[]
          readonly events: readonly {
            readonly seq: number
            readonly kind: 'spawn' | 'message' | 'consult' | 'swap' | 'nudge' | 'effort' | 'human' | 'notice' | 'stall' | 'pause' | 'resume' | 'done'
            readonly at: number
            readonly nodes: readonly string[]
            readonly fromTier?: 'haiku' | 'sonnet' | 'opus'
            readonly toTier?: 'haiku' | 'sonnet' | 'opus'
          }[]
          readonly seq: number
          readonly collapsed: number
          readonly dropped: number
        }
        layout?: {
          readonly slots?: Readonly<Record<string, number>>
          readonly retired?: readonly string[]
        }
        drawnSeq?: number
      }
    }
  }
}
