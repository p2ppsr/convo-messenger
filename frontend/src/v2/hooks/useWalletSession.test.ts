import { describe, expect, it, vi } from 'vitest'
import { connectWithSdkAuto, createAutoWalletClient } from './useWalletSession'

describe('wallet substrate discovery', () => {
  it('delegates substrate discovery to the SDK auto mode', () => {
    const client = createAutoWalletClient()

    expect(client.substrate).toBe('auto')
  })

  it('returns the client selected by SDK discovery', async () => {
    const client = { getVersion: vi.fn(async () => ({ version: 'auto' })) }
    const createClient = vi.fn(() => client)

    const connected = await connectWithSdkAuto(createClient, 50)

    expect(connected).toBe(client)
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(client.getVersion).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable when SDK discovery cannot connect', async () => {
    const client = { getVersion: vi.fn(async () => { throw new Error('no wallet') }) }

    await expect(connectWithSdkAuto(() => client, 50)).rejects.toThrow('WALLET_UNAVAILABLE')
    expect(client.getVersion).toHaveBeenCalledTimes(1)
  })
})
