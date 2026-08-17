import { describe, expect, it, vi } from 'vitest'
import { connectFirstAvailableWallet, createLocalNetworkFetch } from './useWalletSession'

describe('wallet substrate discovery', () => {
  it('stops after the first working substrate instead of probing lower-priority localhost fallbacks', async () => {
    const bridge = { getVersion: vi.fn(async () => ({ version: 'bridge' })) }
    const localCreate = vi.fn(() => ({ getVersion: vi.fn(async () => ({ version: 'local' })) }))

    const connected = await connectFirstAvailableWallet([
      { create: () => bridge, timeoutMs: 50 },
      { create: localCreate, timeoutMs: 50 },
    ])

    expect(connected).toBe(bridge)
    expect(bridge.getVersion).toHaveBeenCalledTimes(1)
    expect(localCreate).not.toHaveBeenCalled()
  })

  it('tries substrates in priority order until one responds', async () => {
    const attempts: string[] = []
    const connected = await connectFirstAvailableWallet([
      { create: () => ({ getVersion: async () => { attempts.push('window.CWI'); throw new Error('missing') } }), timeoutMs: 50 },
      { create: () => ({ getVersion: async () => { attempts.push('XDM'); return { version: 'xdm' } } }), timeoutMs: 50 },
      { create: () => ({ getVersion: async () => { attempts.push('localhost'); return { version: 'local' } } }), timeoutMs: 50 },
    ])

    expect(attempts).toEqual(['window.CWI', 'XDM'])
    expect(await connected.getVersion()).toEqual({ version: 'xdm' })
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
