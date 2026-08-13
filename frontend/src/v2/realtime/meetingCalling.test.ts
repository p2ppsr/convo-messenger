import { CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AuthenticatedCallManager, MAX_MEETING_PARTICIPANTS, type CallManagerOptions, type CallSnapshot, type MeetingRoomSnapshot } from './meetingCalling'
import type { CallSignal } from './messaging'

const aliceKey = PrivateKey.fromRandom()
const bobKey = PrivateKey.fromRandom()
const carolKey = PrivateKey.fromRandom()
const alice = aliceKey.toPublicKey().toString()
const bob = bobKey.toPublicKey().toString()
const carol = carolKey.toPublicKey().toString()

class FakeChannel extends EventTarget {
  label = 'convo-brc103-auth-v1'
  readyState: RTCDataChannelState = 'connecting'
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 'closed' })
}

function fakeTrack(kind: 'audio' | 'video') {
  const clone = {
    kind,
    enabled: true,
    stop: vi.fn(),
    clone: vi.fn(),
  }
  clone.clone.mockImplementation(() => fakeTrack(kind))
  return clone
}

function fakeStream(media: 'audio' | 'video') {
  const audio = fakeTrack('audio')
  const video = media === 'video' ? fakeTrack('video') : null
  const tracks = video ? [audio, video] : [audio]
  return {
    tracks,
    stream: {
      getTracks: () => tracks,
      getAudioTracks: () => [audio],
      getVideoTracks: () => video ? [video] : [],
      addTrack: vi.fn(),
    } as unknown as MediaStream,
  }
}

function fakePeerConnection() {
  const channel = new FakeChannel()
  const senders: Array<{ getParameters: ReturnType<typeof vi.fn>; setParameters: ReturnType<typeof vi.fn> }> = []
  const pc = {
    connectionState: 'new',
    remoteDescription: null as RTCSessionDescription | null,
    ontrack: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    addTrack: vi.fn(() => {
      const sender = { getParameters: vi.fn(() => ({ encodings: [{}] })), setParameters: vi.fn(async () => undefined) }
      senders.push(sender)
      return sender as unknown as RTCRtpSender
    }),
    createDataChannel: vi.fn(() => channel),
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'private-group-offer' })),
    createAnswer: vi.fn(async () => ({ type: 'answer', sdp: 'private-group-answer' })),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      pc.remoteDescription = description as RTCSessionDescription
    }),
    addIceCandidate: vi.fn(async () => undefined),
    setConfiguration: vi.fn(),
    restartIce: vi.fn(),
    close: vi.fn(),
  }
  return { pc: pc as unknown as RTCPeerConnection, channel, senders }
}

function manager(options: {
  identityKey?: string
  privateKey?: PrivateKey
  sendSignal?: (recipient: string, signal: CallSignal) => Promise<boolean>
  snapshots?: CallSnapshot[]
  connections?: ReturnType<typeof fakePeerConnection>[]
  isGroupConversation?: boolean
  onRoomChange?: CallManagerOptions['onRoomChange']
}) {
  const identityKey = options.identityKey ?? alice
  const privateKey = options.privateKey ?? aliceKey
  const media = fakeStream('video')
  return {
    media,
    call: new AuthenticatedCallManager({
      wallet: new CompletedProtoWallet(privateKey),
      identityKey,
      conversationId: 'cc'.repeat(32),
      epoch: {
        epoch: 1,
        rootKey: 'private-root',
        members: [alice, bob, carol],
        admins: [alice],
        activatedAt: 1,
      },
      sendSignal: options.sendSignal ?? vi.fn(async () => true),
      onChange: (snapshot) => { options.snapshots?.push(snapshot) },
      isGroupConversation: options.isGroupConversation ?? true,
      onRoomChange: options.onRoomChange,
      getUserMedia: vi.fn(async (constraints) => {
        const selected = constraints.video ? media : fakeStream('audio')
        return selected.stream
      }),
      createMediaStream: () => fakeStream('video').stream,
      createPeerConnection: () => {
        const connection = fakePeerConnection()
        options.connections?.push(connection)
        return connection.pc
      },
      getIceServers: vi.fn(async () => [{ urls: 'turns:managed.example:443', username: 'temporary', credential: 'secret' }]),
    }),
  }
}

describe('authenticated group meeting mesh', () => {
  it('opens a bounded private room and exposes no SDP before someone joins', async () => {
    const signals: Array<{ recipient: string; signal: CallSignal }> = []
    const snapshots: CallSnapshot[] = []
    const { call } = manager({ snapshots, sendSignal: vi.fn(async (recipient, signal) => {
      signals.push({ recipient, signal })
      return true
    }) })

    await call.startCall([bob, carol], 'video')

    expect(signals).toHaveLength(2)
    expect(signals.every(({ signal }) => signal.v === 2 && signal.type === 'room-open')).toBe(true)
    expect(signals.every(({ signal }) => signal.type !== 'offer')).toBe(true)
    expect(signals[0].signal).toEqual(expect.objectContaining({ participants: [alice, bob, carol] }))
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({ status: 'active', isGroup: true }))
    expect(snapshots.at(-1)?.participants).toHaveLength(2)
    await call.stop()
  })

  it('keeps the host in an empty room and lets a member join from a private room announcement', async () => {
    const hostSnapshots: CallSnapshot[] = []
    const { call: host } = manager({
      snapshots: hostSnapshots,
      sendSignal: vi.fn(async () => false),
    })
    await host.startCall([bob, carol], 'video')
    expect(host.current()).toEqual(expect.objectContaining({
      status: 'active',
      isGroup: true,
      message: 'Meeting room is open · waiting for others to join',
    }))

    const rooms: Array<MeetingRoomSnapshot | null> = []
    const joinSignals: CallSignal[] = []
    const { call: guest } = manager({
      identityKey: bob,
      privateKey: bobKey,
      onRoomChange: (room) => rooms.push(room),
      sendSignal: vi.fn(async (_recipient, signal) => { joinSignals.push(signal); return true }),
    })
    const callId = 'ab'.repeat(32)
    await guest.handleSignal(alice, {
      v: 2,
      type: 'room-open',
      callId,
      to: bob,
      media: 'video',
      participants: [alice, bob, carol],
      expiresAt: Date.now() + 60_000,
    })
    expect(rooms[0]).toEqual(expect.objectContaining({ callId, hostIdentityKey: alice, media: 'video' }))
    expect(guest.current().status).toBe('idle')

    await guest.joinRoom()
    expect(rooms.at(-1)).toBeNull()
    expect(guest.current()).toEqual(expect.objectContaining({ status: 'active', isGroup: true, callId }))
    expect(joinSignals.some((signal) => signal.type === 'join')).toBe(true)
    await guest.stop()
    await host.stop()
  })

  it('uses one deterministic offerer per pair and gates cloned outbound tracks until authentication', async () => {
    const signals: CallSignal[] = []
    const connections: ReturnType<typeof fakePeerConnection>[] = []
    const low = [alice, bob].sort()[0]
    const high = low === alice ? bob : alice
    const privateKey = low === alice ? aliceKey : bobKey
    const { call } = manager({ identityKey: low, privateKey, connections, isGroupConversation: false, sendSignal: vi.fn(async (_recipient, signal) => {
      signals.push(signal)
      return true
    }) })

    await call.startCall([high], 'video')
    const callId = call.current().callId!
    await call.handleSignal(high, { v: 2, type: 'join', callId, to: low, media: 'video' })

    expect(connections).toHaveLength(1)
    expect(signals.filter((signal) => signal.type === 'offer')).toHaveLength(1)
    const outboundTracks = connections[0].pc.addTrack as unknown as ReturnType<typeof vi.fn>
    expect(outboundTracks).toHaveBeenCalledTimes(2)
    expect(outboundTracks.mock.calls.map(([track]) => track.enabled)).toEqual([false, false])
    expect(connections[0].senders[0].setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 48_000 }] })
    expect(connections[0].senders[1].setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 1_200_000, maxFramerate: 30 }] })
    const inbound = fakeStream('video').stream
    connections[0].pc.ontrack?.({ streams: [inbound], track: inbound.getTracks()[0] } as unknown as RTCTrackEvent)
    expect(call.current().participants[0].stream).toBeUndefined()
    await call.stop()
    expect(outboundTracks.mock.calls.every(([track]) => track.stop.mock.calls.length === 1)).toBe(true)
  })

  it('keeps a group meeting alive when one participant leaves', async () => {
    const snapshots: CallSnapshot[] = []
    const { call } = manager({ snapshots })
    await call.startCall([bob, carol], 'audio')
    const callId = call.current().callId!
    await call.handleSignal(bob, { v: 2, type: 'leave', callId, to: alice, reason: 'Left' })

    expect(call.current().status).toBe('active')
    expect(call.current().participants.map((participant) => participant.identityKey)).toEqual([carol])
    await call.stop()
  })

  it('rejects meetings larger than the explicit mesh safety limit', async () => {
    const extraKeys = Array.from({ length: MAX_MEETING_PARTICIPANTS }, () => PrivateKey.fromRandom().toPublicKey().toString())
    const call = new AuthenticatedCallManager({
      wallet: new CompletedProtoWallet(aliceKey),
      identityKey: alice,
      conversationId: 'cc'.repeat(32),
      epoch: { epoch: 1, rootKey: 'root', members: [alice, ...extraKeys], admins: [alice], activatedAt: 1 },
      sendSignal: vi.fn(async () => true),
      onChange: vi.fn(),
    })
    await expect(call.startCall(extraKeys, 'audio')).rejects.toThrow(`up to ${MAX_MEETING_PARTICIPANTS}`)
  })
})
