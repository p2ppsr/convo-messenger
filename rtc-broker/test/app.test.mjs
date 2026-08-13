import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { AuthFetch, CompletedProtoWallet, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { createApp, createTwilioIssuer } from '../src/app.mjs'

const servers = []

async function listen(app) {
  const server = await new Promise((resolve) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate))
  })
  servers.push(server)
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise((resolve) => server.close(resolve))))
})

describe('Convo RTC credential broker', () => {
  it('exposes only a minimal unauthenticated health route', async () => {
    const app = createApp({
      wallet: new ProtoWallet(PrivateKey.fromRandom()),
      issueToken: async () => ({ ttlSeconds: 600, iceServers: [{ urls: 'stun:example.com:3478' }] }),
    })
    const baseUrl = await listen(app)
    const response = await fetch(`${baseUrl}/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  })

  it('requires BRC-103 authentication and returns short-lived normalized ICE servers', async () => {
    const serverWallet = new ProtoWallet(PrivateKey.fromRandom())
    const app = createApp({
      wallet: serverWallet,
      issueToken: async () => ({
        ttlSeconds: 600,
        iceServers: [{ url: 'turn:global.turn.twilio.com:3478?transport=udp', username: 'temporary', credential: 'secret' }],
      }),
    })
    const baseUrl = await listen(app)

    const anonymous = await fetch(`${baseUrl}/ice`)
    assert.notEqual(anonymous.status, 200)

    const authFetch = new AuthFetch(new CompletedProtoWallet(PrivateKey.fromRandom()), undefined, undefined, 'convo.metanet.app')
    const response = await authFetch.fetch(`${baseUrl}/ice`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('x-bsv-auth-identity-key'), /^(02|03)[0-9a-f]{64}$/)
    const body = await response.json()
    assert.deepEqual(body.iceServers, [{ urls: 'turn:global.turn.twilio.com:3478?transport=udp', username: 'temporary', credential: 'secret' }])
    assert.ok(body.expiresAt > Date.now())
  })

  it('allows only configured browser origins', async () => {
    const app = createApp({
      wallet: new ProtoWallet(PrivateKey.fromRandom()),
      issueToken: async () => ({ ttlSeconds: 600, iceServers: [{ urls: 'stun:example.com:3478' }] }),
      allowedOrigins: ['https://convo.metanet.app'],
    })
    const baseUrl = await listen(app)
    const allowed = await fetch(`${baseUrl}/ice`, { method: 'OPTIONS', headers: { Origin: 'https://convo.metanet.app' } })
    assert.equal(allowed.status, 204)
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://convo.metanet.app')
    const denied = await fetch(`${baseUrl}/ice`, { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } })
    assert.equal(denied.status, 403)
  })

  it('rejects malformed provider responses without leaking provider details', async () => {
    const issueToken = createTwilioIssuer({
      accountSid: `AC${'11'.repeat(16)}`,
      authToken: 'twilio-test-token-that-is-long-enough',
      fetchImpl: async () => new Response(JSON.stringify({ ice_servers: [{ url: 'https://not-ice.example' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    })
    await assert.rejects(issueToken(), /invalid ICE URLs/)
  })
})
