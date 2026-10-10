import type { BudgetOverrides, Run } from './domain'

// Resolves configured run limits and records only limits explicitly extended by an operator.

export interface RunBudget {
  readonly maxAttempts: number
  readonly maxTokens: number
  readonly maxMinutes: number
}

export function resolveBudget(run: Run, configured: RunBudget): RunBudget {
  return {
    maxAttempts: run.budgetOverrides?.maxAttempts ?? configured.maxAttempts,
    maxTokens: run.budgetOverrides?.maxTokens ?? configured.maxTokens,
    maxMinutes: run.budgetOverrides?.maxMinutes ?? configured.maxMinutes,
  }
}

export function extendBudget(run: Run, configured: RunBudget, extra: RunBudget): BudgetOverrides {
  const limits = resolveBudget(run, configured)
  return {
    ...run.budgetOverrides,
    ...(extra.maxAttempts > 0 ? { maxAttempts: limits.maxAttempts + extra.maxAttempts } : {}),
    ...(extra.maxTokens > 0 ? { maxTokens: limits.maxTokens + extra.maxTokens } : {}),
    ...(extra.maxMinutes > 0 ? { maxMinutes: limits.maxMinutes + extra.maxMinutes } : {}),
  }
}
