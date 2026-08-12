const DEFAULT_RETRY_DELAYS_MS = [300, 750, 1_500]

interface ReviewActionResult {
  status?: unknown
  competingTxs?: unknown
}

interface ReviewActionsError {
  name?: unknown
  code?: unknown
  isError?: unknown
  message?: unknown
  reviewActionResults?: unknown
}

export interface CurrentKvValue {
  value?: string
  outpoint?: string
}

export class ConversationWriteConflictError extends Error {
  constructor(readonly cause: unknown) {
    super('A competing conversation write could not be reconciled. The encrypted outbox will retry it.')
    this.name = 'ConversationWriteConflictError'
  }
}

function reviewResults(error: unknown): ReviewActionResult[] {
  if (typeof error !== 'object' || error === null) return []
  const results = (error as ReviewActionsError).reviewActionResults
  return Array.isArray(results)
    ? results.filter((result): result is ReviewActionResult => typeof result === 'object' && result !== null)
    : []
}

export function isDoubleSpendReviewError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as ReviewActionsError
  const stableMatch = candidate.name === 'WERR_REVIEW_ACTIONS' || (candidate.code === 5 && candidate.isError === true)
  return stableMatch && reviewResults(error).some((result) => result.status === 'doubleSpend')
}

export function safeWriteError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const candidate = error as ReviewActionsError
  const name = candidate.code === 5 && candidate.isError === true
    ? 'WERR_REVIEW_ACTIONS'
    : typeof candidate.name === 'string' ? candidate.name : 'Error'
  const status = reviewResults(error).map((result) => result.status).filter((value) => typeof value === 'string').join(',')
  return `${name}${status ? ` (${status})` : ''}`
}

export async function recoverGlobalKvWrite(options: {
  write: () => Promise<string>
  readCurrent: () => Promise<CurrentKvValue>
  intendedValue: string
  retryDelaysMs?: number[]
  sleep?: (delayMs: number) => Promise<void>
}): Promise<string> {
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)))
  let lastConflict: unknown
  try {
    return await options.write()
  } catch (error) {
    if (!isDoubleSpendReviewError(error)) throw error
    lastConflict = error
  }

  for (const delay of options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS) {
    await sleep(delay)
    try {
      const current = await options.readCurrent()
      if (current.value === options.intendedValue && current.outpoint) return current.outpoint
    } catch {
      // The fresh write below surfaces actionable failures.
    }
    try {
      return await options.write()
    } catch (error) {
      if (!isDoubleSpendReviewError(error)) throw error
      lastConflict = error
    }
  }
  throw new ConversationWriteConflictError(lastConflict)
}
