import { CompletedProtoWallet, PrivateKey, type AuthMessage } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AuthenticatedRtcPeer, RtcDataChannelTransport } from './calling'

class PairedDataChannel extends EventTarget {
  readonly label = 'convo-brc103-auth-v1'
  readyState: RTCDataChannelState = 'open'
  peer?: PairedDataChannel
  sent: string[] = []

  send(data: string): void {
    this.sent.push(data)
    queueMicrotask(() => this.peer?.dispatchEvent(new MessageEvent('message', { data })))
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
}

function pairedChannels(): [PairedDataChannel, PairedDataChannel] {
  const left = new PairedDataChannel()
  const right = new PairedDataChannel()
  left.peer = right
  right.peer = left
  return [left, right]
}

function identity(privateKey: PrivateKey): string {
  return privateKey.toPublicKey().toString()
}

describe('authenticated WebRTC substrate', () => {
  it('carries ordered BRC-103 frames and ignores malformed channel data', async () => {
    const [left, right] = pairedChannels()
    const transport = new RtcDataChannelTransport(right as unknown as RTCDataChannel)
    const received: AuthMessage[] = []
    await transport.onData(async (message) => { received.push(message) })

    left.send('{not-json')
    left.send(JSON.stringify({ version: '0.1', messageType: 'general', identityKey: `02${'11'.repeat(32)}` }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(received).toHaveLength(1)
    expect(received[0].messageType).toBe('general')
    transport.close()
  })

  it('authenticates the expected Metanet identities and exact call binding', async () => {
    const aliceKey = PrivateKey.fromRandom()
    const bobKey = PrivateKey.fromRandom()
    const alice = new CompletedProtoWallet(aliceKey)
    const bob = new CompletedProtoWallet(bobKey)
    const [aliceChannel, bobChannel] = pairedChannels()
    const binding = { callId: 'aa'.repeat(32), conversationId: 'bb'.repeat(32) }
    const aliceAuthenticated = vi.fn()
    const bobAuthenticated = vi.fn()
    const alicePeer = new AuthenticatedRtcPeer(
      alice,
      aliceChannel as unknown as RTCDataChannel,
      identity(bobKey),
      binding,
      aliceAuthenticated,
    )
    const bobPeer = new AuthenticatedRtcPeer(
      bob,
      bobChannel as unknown as RTCDataChannel,
      identity(aliceKey),
      binding,
      bobAuthenticated,
    )

    await Promise.all([bobPeer.start(false), alicePeer.start(true)])

    expect(aliceAuthenticated).toHaveBeenCalledOnce()
    expect(bobAuthenticated).toHaveBeenCalledOnce()
    alicePeer.stop()
    bobPeer.stop()
  })

})
