import { describe, expect, it, vi } from 'vitest'
import { connectFirstAvailableWallet, createLocalNetworkFetch } from './useWalletSession'

describe('wallet substrate discovery', () => {
  it('stops after the preferred Cicada substrate responds', async () => {
    const cicada = { getVersion: vi.fn(async () => ({ version: 'cicada' })) }
    const fallbackCreate = vi.fn(() => ({ getVersion: vi.fn(async () => ({ version: 'fallback' })) }))

    const connected = await connectFirstAvailableWallet([
      { create: () => cicada, timeoutMs: 50 },
      { create: fallbackCreate, timeoutMs: 50 },
    ])

    expect(connected).toBe(cicada)
    expect(cicada.getVersion).toHaveBeenCalledTimes(1)
    expect(fallbackCreate).not.toHaveBeenCalled()
  })

  it('tries substrates in priority order until one responds', async () => {
    const attempts: string[] = []
    const connected = await connectFirstAvailableWallet([
      { create: () => ({ getVersion: async () => { attempts.push('Cicada'); throw new Error('missing') } }), timeoutMs: 50 },
      { create: () => ({ getVersion: async () => { attempts.push('window.CWI'); return { version: 'cwi' } } }), timeoutMs: 50 },
      { create: () => ({ getVersion: async () => { attempts.push('secure-json-api'); return { version: 'json' } } }), timeoutMs: 50 },
    ])

    expect(attempts).toEqual(['Cicada', 'window.CWI'])
    expect(await connected.getVersion()).toEqual({ version: 'cwi' })
  })

  it('marks intentional loopback fetches as local-network requests', async () => {
    const response = new Response(null, { status: 204 })
    const baseFetch = vi.fn(async () => response) as unknown as typeof fetch
    const localFetch = createLocalNetworkFetch(baseFetch)

    await localFetch('http://localhost:3301/getVersion', { method: 'POST' })

    expect(baseFetch).toHaveBeenCalledWith('http://localhost:3301/getVersion', {
      method: 'POST',
      targetAddressSpace: 'local',
    })
  })
})
