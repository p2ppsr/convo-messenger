import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateRootKey, randomId } from '../domain/crypto'
import type { ConversationEpoch, ConversationSecret, MessageEvent } from '../domain/types'
import { ConversationTransport, listWorkspaceRoomUpdates, type CallSignal, type RealtimePeer, type TypingPeer } from './messaging'

interface LiveOptions {
  messageBox: string
  onMessage: (message: { messageId: string; sender: string; body: unknown }) => void
}

class FakeMessageBox {
  static rooms = new Map<string, LiveOptions['onMessage']>()
  static bodies: unknown[] = []
  static sends: Array<{ body: unknown; skipEncryption?: boolean }> = []
  static inboxes = new Map<string, Array<{ messageId: string; sender: string; body: unknown }>>()
  static nextMessage = 0
  ownRoom: string | null = null
  disconnectHandler: (() => void) | null = null
  testSocket = { on: (_event: string, callback: () => void) => { this.disconnectHandler = callback } }

  constructor(readonly identityKey: string) {}

  async listenForLiveMessages(options: LiveOptions) {
    this.ownRoom = options.messageBox
    FakeMessageBox.rooms.set(options.messageBox, options.onMessage)
  }

  async sendLiveMessage(request: { messageBox: string; body: unknown; skipEncryption?: boolean }) {
    FakeMessageBox.bodies.push(request.body)
    FakeMessageBox.sends.push({ body: request.body, skipEncryption: request.skipEncryption })
    FakeMessageBox.nextMessage += 1
    const message = {
      messageId: `message-${FakeMessageBox.nextMessage}`,
      sender: this.identityKey,
      body: request.body,
    }
    const inbox = FakeMessageBox.inboxes.get(request.messageBox) ?? []
    inbox.push(message)
    FakeMessageBox.inboxes.set(request.messageBox, inbox)
    FakeMessageBox.rooms.get(request.messageBox)?.(message)
  }

  async listMessages(request: { messageBox: string }) { return [...(FakeMessageBox.inboxes.get(request.messageBox) ?? [])] }
  async acknowledgeMessage(request: { messageIds: string[] }) {
    for (const [room, messages] of FakeMessageBox.inboxes) {
      FakeMessageBox.inboxes.set(room, messages.filter((message) => !request.messageIds.includes(message.messageId)))
    }
  }
  async leaveRoom(room: string) { if (this.ownRoom === room) FakeMessageBox.rooms.delete(room) }
  async disconnectWebSocket() {}
}

const alice = `02${'11'.repeat(32)}`
const bob = `03${'22'.repeat(32)}`
const conversationId = 'ab'.repeat(32)

function epoch(): ConversationEpoch {
  return {
    epoch: 1,
    rootKey: generateRootKey(),
    members: [alice, bob],
    admins: [alice],
    activatedAt: Date.now(),
  }
}

function createTransport(
  identityKey: string,
  sharedEpoch: ConversationEpoch,
  callbacks: {
    onEvent?: (event: MessageEvent) => void
    onPeersChange?: (peers: RealtimePeer[]) => void
    onTypingChange?: (peers: TypingPeer[]) => void
    onCallSignal?: (sender: string, signal: CallSignal) => void
    onState?: (state: 'connecting' | 'live' | 'fallback') => void
  } = {},
) {
  return new ConversationTransport({
    clientFactory: () => new FakeMessageBox(identityKey) as never,
    identityKey,
    conversationId,
    epoch: sharedEpoch,
    onEvent: (event) => callbacks.onEvent?.(event as MessageEvent),
    onSyncRequested: vi.fn(async () => undefined),
    onState: callbacks.onState ?? vi.fn(),
    onPeersChange: callbacks.onPeersChange,
    onTypingChange: callbacks.onTypingChange,
    onCallSignal: callbacks.onCallSignal,
  })
}

afterEach(() => {
  FakeMessageBox.rooms.clear()
  FakeMessageBox.bodies = []
  FakeMessageBox.sends = []
  FakeMessageBox.inboxes.clear()
  FakeMessageBox.nextMessage = 0
  vi.useRealTimers()
})

describe('private realtime conversation transport', () => {
  it('renders an encrypted live event before durable reconciliation without leaking its contents', async () => {
    const sharedEpoch = epoch()
    const received = vi.fn()
    const aliceTransport = createTransport(alice, sharedEpoch)
    const bobTransport = createTransport(bob, sharedEpoch, { onEvent: received })
    await bobTransport.start()
    await aliceTransport.start()
    FakeMessageBox.bodies = []

    const event: MessageEvent = {
      v: 2,
      id: randomId(),
      conversationId,
      epoch: 1,
      sender: alice,
      createdAt: Date.now(),
      type: 'message',
      body: 'instant secret message',
    }
    await expect(aliceTransport.publishEvent(event)).resolves.toBe(1)
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(event), { timeout: 5_000 })

    const wire = JSON.stringify(FakeMessageBox.bodies.at(-1))
    expect(wire).toContain('convo-v2-live')
    expect(wire).not.toContain(event.body)
    expect(wire).not.toContain(conversationId)
    expect(wire).not.toContain(alice)
    expect(wire).not.toContain(bob)
    expect(FakeMessageBox.sends.at(-1)?.skipEncryption).toBe(true)

    await aliceTransport.publishEvent(event)
    await Promise.resolve()
    expect(received).toHaveBeenCalledTimes(1)
    await aliceTransport.stop()
    await bobTransport.stop()
  })

  it('shares encrypted presence and typing state and expires typing automatically', async () => {
    vi.useFakeTimers()
    const sharedEpoch = epoch()
    const peersChanged = vi.fn()
    const typingChanged = vi.fn()
    const aliceTransport = createTransport(alice, sharedEpoch)
    const bobTransport = createTransport(bob, sharedEpoch, {
      onPeersChange: peersChanged,
      onTypingChange: typingChanged,
    })
    await bobTransport.start()
    await aliceTransport.start()

    aliceTransport.publishTyping(true)
    await vi.waitFor(() => {
      expect(peersChanged).toHaveBeenCalledWith([expect.objectContaining({ identityKey: alice })])
      expect(typingChanged).toHaveBeenCalledWith([expect.objectContaining({ identityKey: alice })])
    }, { timeout: 1_000 })

    await vi.advanceTimersByTimeAsync(2_500)
    expect(typingChanged).toHaveBeenLastCalledWith([])
    const wire = JSON.stringify(FakeMessageBox.bodies)
    expect(wire).not.toContain('typing')
    expect(wire).not.toContain(conversationId)

    await aliceTransport.stop()
    await bobTransport.stop()
  })

  it('targets call signaling without exposing identities, call metadata, or SDP on the wire', async () => {
    const sharedEpoch = epoch()
    const received = vi.fn()
    const aliceTransport = createTransport(alice, sharedEpoch)
    const bobTransport = createTransport(bob, sharedEpoch, { onCallSignal: received })
    await bobTransport.start()
    await aliceTransport.start()
    FakeMessageBox.bodies = []
    const signal: CallSignal = {
      v: 2,
      type: 'invite',
      callId: 'cd'.repeat(32),
      to: bob,
      media: 'video',
      participants: [alice, bob],
      expiresAt: Date.now() + 45_000,
    }

    await expect(aliceTransport.publishCallSignal(bob, signal)).resolves.toBe(true)
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(alice, signal), { timeout: 5_000 })

    const wire = JSON.stringify(FakeMessageBox.bodies.at(-1))
    expect(wire).toContain('convo-v2-live')
    expect(wire).not.toContain(signal.callId)
    expect(wire).not.toContain('participants')
    expect(wire).not.toContain('video')
    expect(wire).not.toContain(conversationId)
    expect(wire).not.toContain(alice)
    expect(wire).not.toContain(bob)
    await aliceTransport.stop()
    await bobTransport.stop()
  })

  it('discovers an encrypted group room without opening that conversation', async () => {
    const sharedEpoch = epoch()
    const aliceTransport = createTransport(alice, sharedEpoch)
    await aliceTransport.start()
    FakeMessageBox.bodies = []
    const callId = 'ef'.repeat(32)
    await aliceTransport.publishCallSignal(bob, {
      v: 2,
      type: 'room-open',
      callId,
      to: bob,
      media: 'video',
      participants: [alice, bob],
      expiresAt: Date.now() + 60_000,
    })
    const secret: ConversationSecret = {
      v: 2,
      conversationId,
      kind: 'group',
      title: 'Private room',
      currentEpoch: 1,
      epochs: [sharedEpoch],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
    }

    const roomClient = new FakeMessageBox(bob)
    const updates = await listWorkspaceRoomUpdates(roomClient as never, bob, [secret])

    expect(updates).toEqual([expect.objectContaining({
      conversationId,
      sender: alice,
      room: expect.objectContaining({ callId, hostIdentityKey: alice, media: 'video' }),
    })])
    const wire = JSON.stringify(FakeMessageBox.bodies.at(-1))
    expect(wire).not.toContain(conversationId)
    expect(wire).not.toContain(callId)
    expect(wire).not.toContain(alice)
    expect(wire).not.toContain(bob)

    const listMessages = vi.spyOn(roomClient, 'listMessages')
    expect(await listWorkspaceRoomUpdates(roomClient as never, bob, [secret], conversationId)).toEqual([])
    expect(listMessages).not.toHaveBeenCalled()
    await aliceTransport.stop()
  })

  it('recreates and rejoins a fresh socket after disconnect', async () => {
    vi.useFakeTimers()
    const sharedEpoch = epoch()
    const states = vi.fn()
    const clients: FakeMessageBox[] = []
    const transport = new ConversationTransport({
      clientFactory: () => {
        const client = new FakeMessageBox(alice)
        clients.push(client)
        return client as never
      },
      identityKey: alice,
      conversationId,
      epoch: sharedEpoch,
      onEvent: vi.fn(),
      onSyncRequested: vi.fn(async () => undefined),
      onState: states,
    })
    await transport.start()
    clients[0].disconnectHandler?.()
    expect(states).toHaveBeenLastCalledWith('fallback')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(clients).toHaveLength(2)
    expect(states).toHaveBeenLastCalledWith('live')
    await transport.stop()
  })
})
