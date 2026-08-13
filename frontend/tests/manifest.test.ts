import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ProtocolPermission {
  protocolID: [number, string]
  counterparty?: string
}

interface ConvoManifest {
  babbage?: unknown
  metanet?: {
    schemaVersion?: number
    groupPermissions?: {
      spendingAuthorization?: { amount?: number; duration?: unknown }
      protocolPermissions?: ProtocolPermission[]
      basketAccess?: Array<{ basket?: string }>
    }
    counterpartyPermissions?: {
      protocols?: Array<{ protocolName?: string }>
    }
  }
}

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/manifest.json'), 'utf8'),
) as ConvoManifest

describe('BRC-116 manifest permissions', () => {
  it('declares the least-privilege wallet capabilities used by Convo', () => {
    expect(manifest.babbage).toBeUndefined()
    expect(manifest.metanet?.schemaVersion).toBe(1)
    expect(manifest.metanet?.groupPermissions?.spendingAuthorization).toEqual({
      amount: 600000,
      description: 'Store encrypted chats and attachments',
    })
    expect(manifest.metanet?.groupPermissions?.spendingAuthorization?.duration).toBeUndefined()
    expect(manifest.metanet?.groupPermissions?.basketAccess?.map(({ basket }) => basket)).toEqual([
      'convo private v2',
    ])
    expect(manifest.metanet?.groupPermissions?.protocolPermissions?.map(({ protocolID, counterparty }) => ({
      protocolID,
      ...(counterparty === undefined ? {} : { counterparty }),
    }))).toEqual([
      { protocolID: [1, 'kvstore'] },
      { protocolID: [1, 'messagebox'] },
      { protocolID: [2, 'convo private v2'], counterparty: 'self' },
      { protocolID: [2, 'server hmac'], counterparty: 'self' },
    ])
    expect(manifest.metanet?.counterpartyPermissions?.protocols?.map(({ protocolName }) => protocolName)).toEqual([
      'Convo Messenger',
      'auth message signature',
      '3241645161d8',
    ])
  })
})
