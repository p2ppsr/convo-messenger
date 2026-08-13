import { describe, expect, it, vi } from 'vitest'
import { ConversationWriteConflictError, isDoubleSpendReviewError, recoverGlobalKvWrite, safeWriteError } from './kvWriteRecovery'

const conflict = {
  name: 'WERR_REVIEW_ACTIONS',
  reviewActionResults: [{ status: 'doubleSpend', competingTxs: ['secret-transaction-data'] }],
}

describe('GlobalKVStore write recovery', () => {
  it('recognizes stable double-spend review failures without logging transaction detail', () => {
    expect(isDoubleSpendReviewError(conflict)).toBe(true)
    expect(safeWriteError(conflict)).toBe('WERR_REVIEW_ACTIONS (doubleSpend)')
    expect(safeWriteError(conflict)).not.toContain('secret-transaction-data')
  })

  it('recognizes a minified wallet review class by stable wire fields', () => {
    expect(isDoubleSpendReviewError({ ...conflict, name: 'tv', code: 5, isError: true })).toBe(true)
  })

  it('accepts a competing write when readback already equals the encrypted intended value', async () => {
    const write = vi.fn().mockRejectedValue(conflict)
    const result = await recoverGlobalKvWrite({
      write,
      intendedValue: 'ciphertext',
      readCurrent: async () => ({ value: 'ciphertext', outpoint: 'txid.0' }),
      retryDelaysMs: [0],
      sleep: async () => undefined,
    })
    expect(result).toBe('txid.0')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('accepts a semantically identical randomized ciphertext without another spend', async () => {
    const write = vi.fn().mockRejectedValue(conflict)
    const result = await recoverGlobalKvWrite({
      write,
      intendedValue: 'randomized-ciphertext-b',
      acceptCurrent: (current) => current.value === 'randomized-ciphertext-a',
      readCurrent: async () => ({ value: 'randomized-ciphertext-a', outpoint: 'winner.0' }),
      retryDelaysMs: [0],
      sleep: async () => undefined,
    })
    expect(result).toBe('winner.0')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('fails safely after bounded conflicts so the encrypted outbox can retry', async () => {
    await expect(recoverGlobalKvWrite({
      write: async () => { throw conflict },
      intendedValue: 'ciphertext',
      readCurrent: async () => ({}),
      retryDelaysMs: [0, 0],
      finalVerificationDelayMs: 0,
      sleep: async () => undefined,
    })).rejects.toBeInstanceOf(ConversationWriteConflictError)
  })

  it('performs a final index verification after retries are exhausted', async () => {
    let reads = 0
    await expect(recoverGlobalKvWrite({
      write: async () => { throw conflict },
      intendedValue: 'ciphertext',
      readCurrent: async () => (++reads === 2 ? { value: 'ciphertext', outpoint: 'winner.0' } : {}),
      retryDelaysMs: [0],
      finalVerificationDelayMs: 0,
      sleep: async () => undefined,
    })).resolves.toBe('winner.0')
  })
})
