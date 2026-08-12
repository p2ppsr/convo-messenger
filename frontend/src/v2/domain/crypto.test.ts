import { describe, expect, it } from 'vitest'
import { decryptJson, deriveLocator, encryptJson, epochHistoryDigest, generateRootKey, liveBoxName, manifestLocator, pageLocator } from './crypto'

describe('private conversation derivation', () => {
  it('round-trips padded ciphertext without exposing plaintext', () => {
    const rootKey = generateRootKey()
    const privateValue = {
      title: 'Highly private planning room',
      members: ['02' + '11'.repeat(32), '03' + '22'.repeat(32)],
      body: 'Meet at the private location',
    }
    const ciphertext = encryptJson(rootKey, 'page:1', privateValue, 512)

    expect(ciphertext).not.toContain(privateValue.title)
    expect(ciphertext).not.toContain(privateValue.members[0])
    expect(ciphertext).not.toContain(privateValue.body)
    expect(decryptJson(rootKey, 'page:1', ciphertext)).toEqual(privateValue)
  })

  it('pads different small payloads to the same observable ciphertext length', () => {
    const rootKey = generateRootKey()
    const short = encryptJson(rootKey, 'short', { body: 'a' }, 512)
    const longer = encryptJson(rootKey, 'longer', { body: 'a'.repeat(220) }, 512)
    expect(short.length).toBe(longer.length)
  })

  it('domain-separates every public locator and recipient inbox', () => {
    const rootKey = generateRootKey()
    const member = '02' + '33'.repeat(32)
    const locations = new Set([
      deriveLocator(rootKey, 'custom'),
      manifestLocator(rootKey, member),
      pageLocator(rootKey, member, 0),
      pageLocator(rootKey, member, 1),
      liveBoxName(rootKey, member),
    ])
    expect(locations.size).toBe(5)
    for (const location of locations) expect(location).not.toContain(member)
  })

  it('creates the same constant-size history commitment regardless of digest insertion order', () => {
    const first = epochHistoryDigest({ b: '22'.repeat(32), a: '11'.repeat(32) })
    const second = epochHistoryDigest({ a: '11'.repeat(32), b: '22'.repeat(32) })
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })
})
