import { CompletedProtoWallet, PrivateKey, type AuthMessage } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AuthenticatedCallManager, AuthenticatedRtcPeer, RtcDataChannelTransport } from './calling'

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

  it('keeps local media disabled until wallet authentication completes', async () => {
    const selfKey = PrivateKey.fromRandom()
    const peerKey = PrivateKey.fromRandom()
    const channel = new PairedDataChannel()
    channel.readyState = 'connecting'
    const audioTrack = { kind: 'audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack
    const localStream = {
      getTracks: () => [audioTrack],
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream
    const remoteStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
      addTrack: vi.fn(),
    } as unknown as MediaStream
    const pc = {
      connectionState: 'new',
      remoteDescription: null,
      ontrack: null,
      onicecandidate: null,
      onconnectionstatechange: null,
      ondatachannel: null,
      addTrack: vi.fn(),
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'private-offer' })),
      setLocalDescription: vi.fn(async () => undefined),
      setConfiguration: vi.fn(),
      restartIce: vi.fn(),
      close: vi.fn(),
    } as unknown as RTCPeerConnection
    const onChange = vi.fn()
    const getIceServers = vi.fn(async () => [{ urls: 'turn:managed.example:3478', username: 'temporary', credential: 'secret' }])
    const manager = new AuthenticatedCallManager({
      wallet: new CompletedProtoWallet(selfKey),
      identityKey: identity(selfKey),
      conversationId: 'cc'.repeat(32),
      epoch: {
        epoch: 1,
        rootKey: 'root',
        members: [identity(selfKey), identity(peerKey)],
        admins: [identity(selfKey)],
        activatedAt: 1,
      },
      sendSignal: vi.fn(async () => true),
      onChange,
      getUserMedia: vi.fn(async () => localStream),
      createMediaStream: () => remoteStream,
      createPeerConnection: () => pc,
      getIceServers,
    })

    await manager.startCall(identity(peerKey), 'audio')

    expect(audioTrack.enabled).toBe(false)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'outgoing', authenticated: false }))
    Object.defineProperty(pc, 'connectionState', { value: 'failed', configurable: true })
    pc.onconnectionstatechange?.(new Event('connectionstatechange'))
    await vi.waitFor(() => expect(getIceServers).toHaveBeenCalledTimes(2))
    expect(pc.setConfiguration).toHaveBeenCalledWith({ iceServers: await getIceServers.mock.results[1].value })
    expect(pc.restartIce).toHaveBeenCalledOnce()
    await manager.hangup()
    expect(audioTrack.stop).toHaveBeenCalledOnce()
  })
})
