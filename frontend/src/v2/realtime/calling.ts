import { Peer, Utils, type AuthMessage, type Transport, type WalletInterface } from '@bsv/sdk'
import { randomId } from '../domain/crypto'
import type { ConversationEpoch } from '../domain/types'
import type { CallMedia, CallSignal } from './messaging'

const AUTH_CHANNEL = 'convo-brc103-auth-v1'
const AUTH_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 45_000
const DISCONNECT_GRACE_MS = 10_000
const MAX_AUTH_FRAME_BYTES = 256_000

export type CallStatus = 'idle' | 'outgoing' | 'ringing' | 'incoming' | 'connecting' | 'authenticating' | 'active' | 'ended' | 'error'

export interface CallSnapshot {
  status: CallStatus
  callId?: string
  peerIdentityKey?: string
  media?: CallMedia
  direction?: 'incoming' | 'outgoing'
  localStream?: MediaStream
  remoteStream?: MediaStream
  audioEnabled: boolean
  videoEnabled: boolean
  authenticated: boolean
  startedAt?: number
  message?: string
}

export const idleCallSnapshot = (): CallSnapshot => ({
  status: 'idle',
  audioEnabled: true,
  videoEnabled: true,
  authenticated: false,
})

function isAuthMessage(value: unknown): value is AuthMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const message = value as Partial<AuthMessage>
  return message.version === '0.1'
    && (message.messageType === 'initialRequest'
      || message.messageType === 'initialResponse'
      || message.messageType === 'certificateRequest'
      || message.messageType === 'certificateResponse'
      || message.messageType === 'general')
    && typeof message.identityKey === 'string'
    && /^(02|03)[0-9a-f]{64}$/i.test(message.identityKey)
}

/**
 * BRC-103 transport over one ordered WebRTC data channel. This is the browser
 * analogue of AuthSocket's SocketClientTransport: Peer owns authentication;
 * the substrate only frames, bounds, orders, and relays AuthMessages.
 */
export class RtcDataChannelTransport implements Transport {
  private callback?: (message: AuthMessage) => Promise<void>
  private readonly queued: AuthMessage[] = []
  private processTail: Promise<void> = Promise.resolve()
  private closed = false
  private readonly messageHandler = (event: MessageEvent) => { this.receive(event.data) }

  constructor(private readonly channel: RTCDataChannel) {
    channel.addEventListener('message', this.messageHandler)
  }

  async send(message: AuthMessage): Promise<void> {
    if (this.closed) throw new Error('Authenticated WebRTC transport is closed')
    const frame = JSON.stringify(message)
    if (new TextEncoder().encode(frame).byteLength > MAX_AUTH_FRAME_BYTES) {
      throw new Error('Authenticated WebRTC frame is too large')
    }
    await this.waitUntilOpen()
    this.channel.send(frame)
  }

  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.callback = callback
    for (const message of this.queued.splice(0)) this.dispatch(message)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.channel.removeEventListener('message', this.messageHandler)
    if (this.channel.readyState !== 'closed') this.channel.close()
    this.queued.length = 0
  }

  private receive(raw: unknown): void {
    if (this.closed || typeof raw !== 'string' || raw.length > MAX_AUTH_FRAME_BYTES) return
    let message: unknown
    try { message = JSON.parse(raw) } catch { return }
    if (!isAuthMessage(message)) return
    if (!this.callback) {
      if (this.queued.length < 32) this.queued.push(message)
      return
    }
    this.dispatch(message)
  }

  private dispatch(message: AuthMessage): void {
    this.processTail = this.processTail.then(async () => await this.callback?.(message)).catch(() => {
      this.close()
    })
  }

  private async waitUntilOpen(): Promise<void> {
    if (this.channel.readyState === 'open') return
    if (this.channel.readyState === 'closing' || this.channel.readyState === 'closed') {
      throw new Error('Authenticated WebRTC channel is unavailable')
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Authenticated WebRTC channel timed out')), AUTH_TIMEOUT_MS)
      const open = () => finish()
      const close = () => finish(new Error('Authenticated WebRTC channel closed before opening'))
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        this.channel.removeEventListener('open', open)
        this.channel.removeEventListener('close', close)
        if (error) reject(error); else resolve()
      }
      this.channel.addEventListener('open', open)
      this.channel.addEventListener('close', close)
    })
  }
}

interface AuthBinding {
  callId: string
  conversationId: string
}

interface AuthControl extends AuthBinding {
  type: 'convo-call-auth' | 'convo-call-auth-ack'
  v: 1
}

function decodeAuthControl(payload: number[]): AuthControl | null {
  try {
    const value = JSON.parse(Utils.toUTF8(payload)) as Partial<AuthControl>
    if (value.v !== 1
      || (value.type !== 'convo-call-auth' && value.type !== 'convo-call-auth-ack')
      || typeof value.callId !== 'string' || !/^[0-9a-f]{64}$/.test(value.callId)
      || typeof value.conversationId !== 'string' || !/^[0-9a-f]{64}$/.test(value.conversationId)) return null
    return value as AuthControl
  } catch { return null }
}

/** Binds the WebRTC DTLS association to an expected Metanet identity via BRC-103. */
export class AuthenticatedRtcPeer {
  private readonly transport: RtcDataChannelTransport
  private readonly peer: Peer
  private readonly listenerId: number
  private authenticated = false
  private settled = false
  private stopped = false
  private resolveAuthenticated!: () => void
  private rejectAuthenticated!: (error: Error) => void
  private readonly authenticatedPromise: Promise<void>
  private authTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    wallet: WalletInterface,
    channel: RTCDataChannel,
    private readonly expectedIdentityKey: string,
    private readonly binding: AuthBinding,
    private readonly onAuthenticated: () => void,
  ) {
    this.transport = new RtcDataChannelTransport(channel)
    this.peer = new Peer(wallet, this.transport, undefined, undefined, false, 'convo.metanet.app')
    this.authenticatedPromise = new Promise<void>((resolve, reject) => {
      this.resolveAuthenticated = resolve
      this.rejectAuthenticated = reject
    })
    this.listenerId = this.peer.listenForGeneralMessages(async (sender, payload) => {
      const control = decodeAuthControl(payload)
      if (!control
        || sender !== this.expectedIdentityKey
        || control.callId !== this.binding.callId
        || control.conversationId !== this.binding.conversationId) {
        this.fail(new Error('WebRTC peer identity or call binding is invalid'))
        return
      }
      if (control.type === 'convo-call-auth') {
        this.markAuthenticated()
        await this.peer.toPeer(this.encode('convo-call-auth-ack'), sender)
      } else this.markAuthenticated()
    })
  }

  async start(initiator: boolean): Promise<void> {
    await this.peer.ready
    if (this.stopped) throw new Error('Metanet peer authentication was cancelled')
    this.authTimer = setTimeout(() => this.fail(new Error('Metanet peer authentication timed out')), AUTH_TIMEOUT_MS)
    if (initiator) {
      void this.peer.toPeer(this.encode('convo-call-auth'), this.expectedIdentityKey).catch((reason: unknown) => {
        this.fail(reason instanceof Error ? reason : new Error('Metanet peer authentication failed'))
      })
    }
    return await this.authenticatedPromise
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.authTimer) clearTimeout(this.authTimer)
    this.authTimer = null
    if (!this.settled) {
      this.settled = true
      this.rejectAuthenticated(new Error('Metanet peer authentication was cancelled'))
    }
    this.peer.stopListeningForGeneralMessages(this.listenerId)
    this.transport.close()
  }

  private encode(type: AuthControl['type']): number[] {
    return Utils.toArray(JSON.stringify({ v: 1, type, ...this.binding }), 'utf8')
  }

  private markAuthenticated(): void {
    if (this.authenticated || this.stopped) return
    this.authenticated = true
    this.settled = true
    if (this.authTimer) clearTimeout(this.authTimer)
    this.authTimer = null
    this.onAuthenticated()
    this.resolveAuthenticated()
  }

  private fail(error: Error): void {
    if (this.authenticated || this.stopped) return
    if (this.authTimer) clearTimeout(this.authTimer)
    this.authTimer = null
    this.settled = true
    this.rejectAuthenticated(error)
    this.stop()
  }
}

interface ActiveCall {
  callId: string
  peerIdentityKey: string
  media: CallMedia
  direction: 'incoming' | 'outgoing'
  offer?: CallSignal & { type: 'offer' }
  pc?: RTCPeerConnection
  auth?: AuthenticatedRtcPeer
  localStream?: MediaStream
  remoteStream?: MediaStream
  remoteCandidates: RTCIceCandidateInit[]
  localCandidates: RTCIceCandidateInit[]
  signalingReady: boolean
  authenticated: boolean
  audioEnabled: boolean
  videoEnabled: boolean
  restartCount: number
  timer?: ReturnType<typeof setTimeout>
  disconnectTimer?: ReturnType<typeof setTimeout>
  startedAt?: number
}

export interface CallManagerOptions {
  wallet: WalletInterface
  identityKey: string
  conversationId: string
  epoch: ConversationEpoch
  sendSignal: (recipient: string, signal: CallSignal) => Promise<boolean>
  onChange: (snapshot: CallSnapshot) => void
  iceServers?: RTCIceServer[]
  getIceServers?: () => Promise<RTCIceServer[]>
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createMediaStream?: () => MediaStream
}

export function defaultIceServers(): RTCIceServer[] {
  return [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ]
}

export class AuthenticatedCallManager {
  private call: ActiveCall | null = null
  private snapshot: CallSnapshot = idleCallSnapshot()
  private stopped = false

  constructor(private readonly options: CallManagerOptions) {}

  current(): CallSnapshot { return this.snapshot }

  async startCall(peerIdentityKey: string, media: CallMedia): Promise<void> {
    if (this.stopped) throw new Error('The realtime call session is closed')
    this.assertPeer(peerIdentityKey)
    if (this.call) throw new Error('Another call is already in progress')
    const call: ActiveCall = {
      callId: randomId(), peerIdentityKey, media, direction: 'outgoing',
      remoteCandidates: [], localCandidates: [], signalingReady: false,
      authenticated: false, audioEnabled: true, videoEnabled: media === 'video', restartCount: 0,
    }
    this.call = call
    try {
      call.localStream = await this.acquireMedia(media)
      if (this.call !== call) return
      await this.prepareConnection(call, true)
      const offer = await call.pc!.createOffer()
      await call.pc!.setLocalDescription(offer)
      this.emit(call, 'outgoing', 'Calling securely…')
      const delivered = await this.send(call, {
        v: 1, type: 'offer', callId: call.callId, to: peerIdentityKey,
        media, sdp: offer.sdp ?? '', expiresAt: Date.now() + CALL_TIMEOUT_MS,
      })
      if (!delivered) throw new Error('The peer is not reachable over realtime signaling')
      call.signalingReady = true
      await this.flushLocalCandidates(call)
      call.timer = setTimeout(() => {
        if (this.call === call && !call.authenticated) void this.finish('Call was not answered', 'error', true)
      }, CALL_TIMEOUT_MS)
    } catch (reason) {
      await this.finish(reason instanceof Error ? reason.message : 'Could not start the call', 'error', false)
      throw reason
    }
  }

  async accept(): Promise<void> {
    const call = this.call
    if (!call?.offer || this.snapshot.status !== 'incoming') throw new Error('There is no incoming call to answer')
    try {
      call.localStream = await this.acquireMedia(call.media)
      if (this.call !== call) return
      await this.prepareConnection(call, false)
      await call.pc!.setRemoteDescription({ type: 'offer', sdp: call.offer.sdp })
      await this.flushRemoteCandidates(call)
      const answer = await call.pc!.createAnswer()
      await call.pc!.setLocalDescription(answer)
      this.emit(call, 'connecting', 'Establishing encrypted media…')
      const delivered = await this.send(call, { v: 1, type: 'answer', callId: call.callId, to: call.peerIdentityKey, sdp: answer.sdp ?? '' })
      if (!delivered) throw new Error('The answer could not be delivered over realtime signaling')
      call.signalingReady = true
      await this.flushLocalCandidates(call)
    } catch (reason) {
      await this.finish(reason instanceof Error ? reason.message : 'Could not answer the call', 'error', true)
      throw reason
    }
  }

  async decline(): Promise<void> {
    await this.finish('Call declined', 'ended', true, 'decline')
  }

  async hangup(): Promise<void> {
    await this.finish('Call ended', 'ended', true, 'hangup')
  }

  dismiss(): void {
    if (this.snapshot.status === 'ended' || this.snapshot.status === 'error') {
      this.snapshot = idleCallSnapshot()
      this.options.onChange(this.snapshot)
    }
  }

  toggleAudio(): void {
    const call = this.call
    if (!call) return
    call.audioEnabled = !call.audioEnabled
    this.applyTrackState(call)
    this.emit(call, this.snapshot.status, this.snapshot.message)
  }

  toggleVideo(): void {
    const call = this.call
    if (!call || call.media !== 'video') return
    call.videoEnabled = !call.videoEnabled
    this.applyTrackState(call)
    this.emit(call, this.snapshot.status, this.snapshot.message)
  }

  async handleSignal(sender: string, signal: CallSignal): Promise<void> {
    try {
      if (this.stopped || !this.options.epoch.members.includes(sender) || sender === this.options.identityKey) return
      if (signal.type === 'offer') {
        await this.handleOffer(sender, signal)
        return
      }
      const call = this.call
      if (!call || call.callId !== signal.callId || call.peerIdentityKey !== sender) return
      if (signal.type === 'answer' && call.direction === 'outgoing' && call.pc) {
        await call.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
        await this.flushRemoteCandidates(call)
        this.emit(call, 'authenticating', 'Authenticating Metanet identity…')
      } else if (signal.type === 'ice') {
        if (call.pc?.remoteDescription) await call.pc.addIceCandidate(signal.candidate)
        else call.remoteCandidates.push(signal.candidate)
      } else if (signal.type === 'ringing' && call.direction === 'outgoing') {
        this.emit(call, 'ringing', 'Ringing…')
      } else if (signal.type === 'decline' || signal.type === 'busy' || signal.type === 'hangup') {
        const message = signal.reason || (signal.type === 'busy' ? 'User is already in another call' : signal.type === 'decline' ? 'Call declined' : 'Call ended')
        await this.finish(message, 'ended', false)
      }
    } catch (reason) {
      const call = this.call
      if (call?.callId === signal.callId && call.peerIdentityKey === sender) {
        await this.finish(reason instanceof Error ? reason.message : 'Invalid realtime call signal', 'error', true)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.call) await this.finish('Call ended', 'ended', true, 'hangup')
    this.snapshot = idleCallSnapshot()
  }

  private async handleOffer(sender: string, offer: CallSignal & { type: 'offer' }): Promise<void> {
    if (offer.expiresAt <= Date.now()) return
    const current = this.call
    if (current?.callId === offer.callId && current.peerIdentityKey === sender && current.pc) {
      await current.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      const answer = await current.pc.createAnswer()
      await current.pc.setLocalDescription(answer)
      await this.send(current, { v: 1, type: 'answer', callId: current.callId, to: sender, sdp: answer.sdp ?? '' })
      return
    }
    if (current) {
      if (current.direction === 'outgoing' && current.peerIdentityKey === sender && offer.callId < current.callId) {
        this.cleanup(current)
        this.call = null
      } else {
        await this.options.sendSignal(sender, { v: 1, type: 'busy', callId: offer.callId, to: sender, reason: 'Already in another call' })
        return
      }
    }
    const call: ActiveCall = {
      callId: offer.callId, peerIdentityKey: sender, media: offer.media, direction: 'incoming', offer,
      remoteCandidates: [], localCandidates: [], signalingReady: false,
      authenticated: false, audioEnabled: true, videoEnabled: offer.media === 'video', restartCount: 0,
    }
    this.call = call
    this.emit(call, 'incoming', `Incoming ${offer.media} call`)
    await this.send(call, { v: 1, type: 'ringing', callId: call.callId, to: sender })
    call.timer = setTimeout(() => {
      if (this.call === call && this.snapshot.status === 'incoming') void this.finish('Missed call', 'ended', true, 'decline')
    }, Math.max(1_000, offer.expiresAt - Date.now()))
  }

  private async prepareConnection(call: ActiveCall, initiator: boolean): Promise<void> {
    const createPeerConnection = this.options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration))
    const createMediaStream = this.options.createMediaStream ?? (() => new MediaStream())
    const iceServers = this.options.getIceServers
      ? await this.options.getIceServers()
      : (this.options.iceServers ?? defaultIceServers())
    const pc = createPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 4,
    })
    call.pc = pc
    call.remoteStream = createMediaStream()
    for (const track of call.localStream?.getTracks() ?? []) {
      track.enabled = false
      pc.addTrack(track, call.localStream!)
    }
    pc.ontrack = (event) => {
      const tracks = event.streams[0]?.getTracks() ?? [event.track]
      for (const track of tracks) {
        if (!call.remoteStream!.getTracks().some((candidate) => candidate.id === track.id)) call.remoteStream!.addTrack(track)
      }
      this.emit(call, this.snapshot.status, this.snapshot.message)
    }
    pc.onicecandidate = (event) => {
      if (!event.candidate || this.call !== call) return
      const candidate = event.candidate.toJSON()
      if (!call.signalingReady) call.localCandidates.push(candidate)
      else void this.send(call, { v: 1, type: 'ice', callId: call.callId, to: call.peerIdentityKey, candidate }).catch(() => undefined)
    }
    pc.onconnectionstatechange = () => { void this.handleConnectionState(call) }
    if (initiator) this.installAuthenticatedChannel(call, pc.createDataChannel(AUTH_CHANNEL, { ordered: true }), true)
    else pc.ondatachannel = (event) => {
      if (event.channel.label !== AUTH_CHANNEL) { event.channel.close(); return }
      this.installAuthenticatedChannel(call, event.channel, false)
    }
  }

  private installAuthenticatedChannel(call: ActiveCall, channel: RTCDataChannel, initiator: boolean): void {
    if (call.auth) { channel.close(); return }
    const auth = new AuthenticatedRtcPeer(
      this.options.wallet,
      channel,
      call.peerIdentityKey,
      { callId: call.callId, conversationId: this.options.conversationId },
      () => {
        if (this.call !== call) return
        call.authenticated = true
        call.startedAt ??= Date.now()
        if (call.timer) clearTimeout(call.timer)
        call.timer = undefined
        this.applyTrackState(call)
        this.emit(call, 'active', 'Wallet-authenticated peer-to-peer call')
      },
    )
    call.auth = auth
    this.emit(call, 'authenticating', 'Authenticating Metanet identity…')
    void auth.start(initiator).catch((reason: unknown) => {
      if (this.call === call) void this.finish(reason instanceof Error ? reason.message : 'Peer authentication failed', 'error', true)
    })
  }

  private async handleConnectionState(call: ActiveCall): Promise<void> {
    if (this.call !== call || !call.pc) return
    const state = call.pc.connectionState
    if (state === 'connected') {
      if (call.disconnectTimer) clearTimeout(call.disconnectTimer)
      call.disconnectTimer = undefined
      return
    }
    if (state === 'disconnected') {
      if (!call.disconnectTimer) call.disconnectTimer = setTimeout(() => {
        if (this.call === call && call.pc?.connectionState === 'disconnected') void this.restartOrFail(call)
      }, DISCONNECT_GRACE_MS)
    } else if (state === 'failed') await this.restartOrFail(call)
    else if (state === 'closed' && this.call === call) await this.finish('Call connection closed', 'ended', false)
  }

  private async restartOrFail(call: ActiveCall): Promise<void> {
    if (this.call !== call || !call.pc) return
    if (call.direction === 'outgoing' && call.restartCount < 1) {
      call.restartCount += 1
      if (this.options.getIceServers) {
        call.pc.setConfiguration({ iceServers: await this.options.getIceServers() })
      }
      call.pc.restartIce()
      const offer = await call.pc.createOffer({ iceRestart: true })
      await call.pc.setLocalDescription(offer)
      await this.send(call, {
        v: 1, type: 'offer', callId: call.callId, to: call.peerIdentityKey,
        media: call.media, sdp: offer.sdp ?? '', expiresAt: Date.now() + CALL_TIMEOUT_MS,
      })
      return
    }
    await this.finish('Peer-to-peer connection failed', 'error', true)
  }

  private async acquireMedia(media: CallMedia): Promise<MediaStream> {
    const getUserMedia = this.options.getUserMedia ?? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices)
    if (!getUserMedia) throw new Error('This browser does not provide camera or microphone access')
    return await getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: media === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } : false,
    })
  }

  private async flushRemoteCandidates(call: ActiveCall): Promise<void> {
    if (!call.pc?.remoteDescription) return
    for (const candidate of call.remoteCandidates.splice(0)) await call.pc.addIceCandidate(candidate)
  }

  private async flushLocalCandidates(call: ActiveCall): Promise<void> {
    for (const candidate of call.localCandidates.splice(0)) {
      await this.send(call, { v: 1, type: 'ice', callId: call.callId, to: call.peerIdentityKey, candidate })
    }
  }

  private async send(call: ActiveCall, signal: CallSignal): Promise<boolean> {
    if (this.call !== call) return false
    return await this.options.sendSignal(call.peerIdentityKey, signal)
  }

  private applyTrackState(call: ActiveCall): void {
    for (const track of call.localStream?.getAudioTracks() ?? []) track.enabled = call.authenticated && call.audioEnabled
    for (const track of call.localStream?.getVideoTracks() ?? []) track.enabled = call.authenticated && call.videoEnabled
  }

  private emit(call: ActiveCall, status: CallStatus, message?: string): void {
    if (this.call !== call) return
    this.snapshot = {
      status, callId: call.callId, peerIdentityKey: call.peerIdentityKey,
      media: call.media, direction: call.direction,
      localStream: call.localStream, remoteStream: call.remoteStream,
      audioEnabled: call.audioEnabled, videoEnabled: call.videoEnabled,
      authenticated: call.authenticated, startedAt: call.startedAt, message,
    }
    this.options.onChange(this.snapshot)
  }

  private async finish(
    message: string,
    status: 'ended' | 'error',
    notify: boolean,
    signalType: 'decline' | 'hangup' = 'hangup',
  ): Promise<void> {
    const call = this.call
    if (!call) return
    if (notify) {
      await this.options.sendSignal(call.peerIdentityKey, {
        v: 1, type: signalType, callId: call.callId, to: call.peerIdentityKey, reason: message,
      }).catch(() => false)
    }
    this.call = null
    this.cleanup(call)
    this.snapshot = {
      status, callId: call.callId, peerIdentityKey: call.peerIdentityKey,
      media: call.media, direction: call.direction,
      audioEnabled: false, videoEnabled: false, authenticated: call.authenticated,
      startedAt: call.startedAt, message,
    }
    this.options.onChange(this.snapshot)
  }

  private cleanup(call: ActiveCall): void {
    if (call.timer) clearTimeout(call.timer)
    if (call.disconnectTimer) clearTimeout(call.disconnectTimer)
    call.auth?.stop()
    call.pc?.close()
    for (const track of call.localStream?.getTracks() ?? []) track.stop()
    for (const track of call.remoteStream?.getTracks() ?? []) track.stop()
  }

  private assertPeer(peerIdentityKey: string): void {
    if (peerIdentityKey === this.options.identityKey || !this.options.epoch.members.includes(peerIdentityKey)) {
      throw new Error('Calls can only be placed to another current conversation member')
    }
  }
}
