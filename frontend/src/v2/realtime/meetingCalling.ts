import type { WalletInterface } from '@bsv/sdk'
import { randomId } from '../domain/crypto'
import type { ConversationEpoch } from '../domain/types'
import { AuthenticatedRtcPeer, defaultIceServers } from './calling'
import type { CallMedia, CallSignal, MeetingCallSignal } from './messaging'

const AUTH_CHANNEL = 'convo-brc103-auth-v1'
const MEETING_INVITE_TIMEOUT_MS = 60_000
const DISCONNECT_GRACE_MS = 10_000
export const MAX_MEETING_PARTICIPANTS = 8

export type CallStatus = 'idle' | 'outgoing' | 'ringing' | 'incoming' | 'connecting' | 'authenticating' | 'active' | 'ended' | 'error'
export type CallParticipantStatus = 'invited' | 'ringing' | 'connecting' | 'authenticating' | 'active' | 'declined' | 'unavailable'

export interface CallParticipantSnapshot {
  identityKey: string
  status: CallParticipantStatus
  stream?: MediaStream
  authenticated: boolean
  audioEnabled: boolean
  videoEnabled: boolean
}

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
  isGroup: boolean
  participants: CallParticipantSnapshot[]
}

export const idleCallSnapshot = (): CallSnapshot => ({
  status: 'idle',
  audioEnabled: true,
  videoEnabled: true,
  authenticated: false,
  isGroup: false,
  participants: [],
})

interface MeetingParticipant {
  identityKey: string
  status: CallParticipantStatus
  audioEnabled: boolean
  videoEnabled: boolean
}

interface PeerLink {
  identityKey: string
  role: 'offerer' | 'answerer'
  pc: RTCPeerConnection
  remoteStream: MediaStream
  outboundTracks: MediaStreamTrack[]
  outboundSenders: RTCRtpSender[]
  auth?: AuthenticatedRtcPeer
  remoteCandidates: RTCIceCandidateInit[]
  localCandidates: RTCIceCandidateInit[]
  signalingReady: boolean
  authenticated: boolean
  restartCount: number
  disconnectTimer?: ReturnType<typeof setTimeout>
}

interface ActiveMeeting {
  callId: string
  inviterIdentityKey: string
  memberIdentityKeys: string[]
  media: CallMedia
  direction: 'incoming' | 'outgoing'
  participants: Map<string, MeetingParticipant>
  links: Map<string, PeerLink>
  pendingCandidates: Map<string, RTCIceCandidateInit[]>
  localStream?: MediaStream
  audioEnabled: boolean
  videoEnabled: boolean
  inviteTimer?: ReturnType<typeof setTimeout>
  startedAt?: number
  iceServers?: RTCIceServer[]
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

/**
 * A small-group WebRTC mesh coordinated through the conversation's padded,
 * group-encrypted MessageBox channel. Every DTLS association is independently
 * bound to the meeting and conversation and authenticated with BRC-103 before
 * its private track clones are enabled.
 */
export class AuthenticatedCallManager {
  private call: ActiveMeeting | null = null
  private snapshot: CallSnapshot = idleCallSnapshot()
  private stopped = false

  constructor(private readonly options: CallManagerOptions) {}

  current(): CallSnapshot { return this.snapshot }

  async startCall(peerIdentityKeys: string | string[], media: CallMedia): Promise<void> {
    if (this.stopped) throw new Error('The realtime meeting session is closed')
    if (this.call) throw new Error('Another meeting is already in progress')
    const recipients = [...new Set(Array.isArray(peerIdentityKeys) ? peerIdentityKeys : [peerIdentityKeys])]
    for (const identityKey of recipients) this.assertPeer(identityKey)
    if (recipients.length === 0) throw new Error('At least one online conversation member is required to start a meeting')
    if (recipients.length + 1 > MAX_MEETING_PARTICIPANTS) {
      throw new Error(`Convo meetings currently support up to ${MAX_MEETING_PARTICIPANTS} participants`)
    }

    const memberIdentityKeys = [this.options.identityKey, ...recipients]
    const call: ActiveMeeting = {
      callId: randomId(),
      inviterIdentityKey: this.options.identityKey,
      memberIdentityKeys,
      media,
      direction: 'outgoing',
      participants: new Map(),
      links: new Map(),
      pendingCandidates: new Map(),
      audioEnabled: true,
      videoEnabled: media === 'video',
    }
    for (const identityKey of recipients) call.participants.set(identityKey, this.participant(identityKey, 'invited', media))
    this.call = call

    try {
      call.localStream = await this.acquireMedia(media)
      if (this.call !== call) return
      this.applyLocalPreviewState(call)
      this.emit(call, 'outgoing', recipients.length > 1 ? 'Opening private meeting…' : 'Calling securely…')
      const expiresAt = Date.now() + MEETING_INVITE_TIMEOUT_MS
      const deliveries = await Promise.all(recipients.map(async (recipient) => await this.sendTo(call, recipient, {
        v: 2,
        type: 'invite',
        callId: call.callId,
        to: recipient,
        media,
        participants: memberIdentityKeys,
        expiresAt,
      })))
      if (!deliveries.some(Boolean)) throw new Error('No participant is reachable over realtime signaling')
      call.startedAt = Date.now()
      this.emit(call, 'active', recipients.length > 1 ? 'Waiting for people to join' : 'Ringing…')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not start the meeting'
      await this.finish(message, 'error', false)
      throw reason
    }
  }

  async accept(): Promise<void> {
    const call = this.call
    if (!call || this.snapshot.status !== 'incoming') throw new Error('There is no incoming meeting to join')
    try {
      call.localStream = await this.acquireMedia(call.media)
      if (this.call !== call) return
      if (call.inviteTimer) clearTimeout(call.inviteTimer)
      call.inviteTimer = undefined
      call.startedAt = Date.now()
      this.applyLocalPreviewState(call)
      this.emit(call, 'connecting', 'Joining the encrypted meeting…')
      const deliveries = await Promise.all(this.otherMembers(call).map(async (recipient) => await this.sendTo(call, recipient, {
        v: 2,
        type: 'join',
        callId: call.callId,
        to: recipient,
        media: call.media,
      })))
      if (!deliveries.some(Boolean)) throw new Error('The meeting is no longer reachable')
      this.emit(call, 'active', 'Waiting for authenticated participants')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not join the meeting'
      await this.finish(message, 'error', true)
      throw reason
    }
  }

  async decline(): Promise<void> {
    const call = this.call
    if (!call) return
    await this.sendTo(call, call.inviterIdentityKey, {
      v: 2,
      type: 'decline',
      callId: call.callId,
      to: call.inviterIdentityKey,
      reason: 'Meeting declined',
    }).catch(() => false)
    await this.finish('Meeting declined', 'ended', false)
  }

  async hangup(): Promise<void> {
    const call = this.call
    await this.finish(call && this.isGroup(call) ? 'You left the meeting' : 'Call ended', 'ended', true)
  }

  dismiss(): void {
    if (this.snapshot.status !== 'ended' && this.snapshot.status !== 'error') return
    this.snapshot = idleCallSnapshot()
    this.options.onChange(this.snapshot)
  }

  toggleAudio(): void {
    const call = this.call
    if (!call) return
    call.audioEnabled = !call.audioEnabled
    this.applyLocalPreviewState(call)
    this.applyAllOutboundTrackStates(call)
    void this.publishMediaState(call)
    this.emit(call, this.snapshot.status, this.snapshot.message)
  }

  toggleVideo(): void {
    const call = this.call
    if (!call || call.media !== 'video') return
    call.videoEnabled = !call.videoEnabled
    this.applyLocalPreviewState(call)
    this.applyAllOutboundTrackStates(call)
    void this.publishMediaState(call)
    this.emit(call, this.snapshot.status, this.snapshot.message)
  }

  async handleSignal(sender: string, signal: CallSignal): Promise<void> {
    if (signal.v !== 2) return
    try {
      if (this.stopped || !this.options.epoch.members.includes(sender) || sender === this.options.identityKey) return
      if (signal.type === 'invite') {
        await this.handleInvite(sender, signal)
        return
      }
      const call = this.call
      if (!call || call.callId !== signal.callId || !call.memberIdentityKeys.includes(sender)) return
      if (signal.type === 'join') await this.handleParticipantReady(call, sender, true, signal.media)
      else if (signal.type === 'ready') await this.handleParticipantReady(call, sender, false, signal.media)
      else if (signal.type === 'offer') await this.handleOffer(call, sender, signal)
      else if (signal.type === 'answer') await this.handleAnswer(call, sender, signal)
      else if (signal.type === 'ice') await this.handleIce(call, sender, signal.candidate)
      else if (signal.type === 'ringing') this.updateParticipant(call, sender, 'ringing')
      else if (signal.type === 'media-state') {
        const participant = this.ensureParticipant(call, sender)
        participant.audioEnabled = signal.audioEnabled
        participant.videoEnabled = call.media === 'video' && signal.videoEnabled
        this.emit(call, this.snapshot.status, this.snapshot.message)
      } else if (signal.type === 'decline' || signal.type === 'busy') {
        this.updateParticipant(call, sender, signal.type === 'decline' ? 'declined' : 'unavailable')
        if (!this.isGroup(call)) {
          await this.finish(signal.reason || (signal.type === 'busy' ? 'User is already in another meeting' : 'Call declined'), 'ended', false)
        }
      } else if (signal.type === 'leave') await this.handleParticipantLeave(call, sender, signal.reason)
    } catch (reason) {
      const call = this.call
      if (call?.callId === signal.callId) {
        await this.handlePeerFailure(call, sender, reason instanceof Error ? reason.message : 'Invalid realtime meeting signal')
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.call) await this.finish('Meeting ended', 'ended', true)
    this.snapshot = idleCallSnapshot()
  }

  private async handleInvite(sender: string, invite: MeetingCallSignal & { type: 'invite' }): Promise<void> {
    if (invite.expiresAt <= Date.now()
      || !invite.participants.includes(sender)
      || !invite.participants.includes(this.options.identityKey)
      || invite.participants.some((identityKey) => !this.options.epoch.members.includes(identityKey))) return

    const current = this.call
    if (current?.callId === invite.callId) return
    if (current) {
      const simultaneousDirectCall = !this.isGroup(current)
        && invite.participants.length === 2
        && invite.participants.includes(current.memberIdentityKeys.find((identityKey) => identityKey !== this.options.identityKey) ?? '')
      if (simultaneousDirectCall && current.direction === 'outgoing' && invite.callId < current.callId) {
        this.cleanup(current)
        this.call = null
      } else {
        await this.options.sendSignal(sender, {
          v: 2,
          type: 'busy',
          callId: invite.callId,
          to: sender,
          reason: 'Already in another meeting',
        })
        return
      }
    }

    const call: ActiveMeeting = {
      callId: invite.callId,
      inviterIdentityKey: sender,
      memberIdentityKeys: invite.participants,
      media: invite.media,
      direction: 'incoming',
      participants: new Map(),
      links: new Map(),
      pendingCandidates: new Map(),
      audioEnabled: true,
      videoEnabled: invite.media === 'video',
    }
    for (const identityKey of invite.participants) {
      if (identityKey !== this.options.identityKey) {
        call.participants.set(identityKey, this.participant(identityKey, identityKey === sender ? 'ringing' : 'invited', invite.media))
      }
    }
    this.call = call
    this.emit(call, 'incoming', this.isGroup(call) ? `Incoming group ${invite.media} meeting` : `Incoming ${invite.media} call`)
    await this.sendTo(call, sender, { v: 2, type: 'ringing', callId: call.callId, to: sender })
    call.inviteTimer = setTimeout(() => {
      if (this.call === call && this.snapshot.status === 'incoming') void this.finish('Missed meeting', 'ended', false)
    }, Math.max(1_000, invite.expiresAt - Date.now()))
  }

  private async handleParticipantReady(call: ActiveMeeting, sender: string, acknowledge: boolean, media: CallMedia): Promise<void> {
    if (!call.localStream || media !== call.media) return
    const participant = this.ensureParticipant(call, sender)
    if (participant.status !== 'active' && participant.status !== 'authenticating') participant.status = 'connecting'
    if (acknowledge) {
      await this.sendTo(call, sender, { v: 2, type: 'ready', callId: call.callId, to: sender, media: call.media })
    }
    this.emit(call, 'active', 'Connecting authenticated participants…')
    if (this.options.identityKey.localeCompare(sender) < 0 && !call.links.has(sender)) await this.offerTo(call, sender)
  }

  private async offerTo(call: ActiveMeeting, recipient: string): Promise<void> {
    const link = await this.prepareConnection(call, recipient, 'offerer')
    const offer = await link.pc.createOffer()
    await link.pc.setLocalDescription(offer)
    const delivered = await this.sendTo(call, recipient, {
      v: 2,
      type: 'offer',
      callId: call.callId,
      to: recipient,
      media: call.media,
      sdp: offer.sdp ?? '',
    })
    if (!delivered) throw new Error('A meeting participant became unreachable')
    link.signalingReady = true
    await this.flushLocalCandidates(call, link)
  }

  private async handleOffer(call: ActiveMeeting, sender: string, offer: MeetingCallSignal & { type: 'offer' }): Promise<void> {
    if (!call.localStream || offer.media !== call.media || sender.localeCompare(this.options.identityKey) >= 0) return
    const link = call.links.get(sender) ?? await this.prepareConnection(call, sender, 'answerer')
    await link.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    await this.flushRemoteCandidates(link)
    const answer = await link.pc.createAnswer()
    await link.pc.setLocalDescription(answer)
    const delivered = await this.sendTo(call, sender, {
      v: 2,
      type: 'answer',
      callId: call.callId,
      to: sender,
      sdp: answer.sdp ?? '',
    })
    if (!delivered) throw new Error('A meeting answer could not be delivered')
    link.signalingReady = true
    await this.flushLocalCandidates(call, link)
  }

  private async handleAnswer(call: ActiveMeeting, sender: string, answer: MeetingCallSignal & { type: 'answer' }): Promise<void> {
    const link = call.links.get(sender)
    if (!link || link.role !== 'offerer') return
    await link.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    await this.flushRemoteCandidates(link)
    this.updateParticipant(call, sender, 'authenticating')
  }

  private async handleIce(call: ActiveMeeting, sender: string, candidate: RTCIceCandidateInit): Promise<void> {
    const link = call.links.get(sender)
    if (!link) {
      const pending = call.pendingCandidates.get(sender) ?? []
      if (pending.length < 128) pending.push(candidate)
      call.pendingCandidates.set(sender, pending)
      return
    }
    if (link.pc.remoteDescription) await link.pc.addIceCandidate(candidate)
    else if (link.remoteCandidates.length < 128) link.remoteCandidates.push(candidate)
  }

  private async prepareConnection(call: ActiveMeeting, identityKey: string, role: PeerLink['role']): Promise<PeerLink> {
    const existing = call.links.get(identityKey)
    if (existing) return existing
    const createPeerConnection = this.options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration))
    const createMediaStream = this.options.createMediaStream ?? (() => new MediaStream())
    call.iceServers ??= this.options.getIceServers ? await this.options.getIceServers() : (this.options.iceServers ?? defaultIceServers())
    const pc = createPeerConnection({
      iceServers: call.iceServers,
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 4,
    })
    const link: PeerLink = {
      identityKey,
      role,
      pc,
      remoteStream: createMediaStream(),
      outboundTracks: [],
      outboundSenders: [],
      remoteCandidates: call.pendingCandidates.get(identityKey) ?? [],
      localCandidates: [],
      signalingReady: false,
      authenticated: false,
      restartCount: 0,
    }
    call.pendingCandidates.delete(identityKey)
    call.links.set(identityKey, link)

    for (const track of call.localStream?.getTracks() ?? []) {
      const outboundTrack = track.clone()
      outboundTrack.enabled = false
      link.outboundTracks.push(outboundTrack)
      const sender = pc.addTrack(outboundTrack, call.localStream!)
      link.outboundSenders.push(sender)
      await this.configureOutboundSender(sender, outboundTrack.kind, call.memberIdentityKeys.length)
    }
    pc.ontrack = (event) => {
      const tracks = event.streams[0]?.getTracks() ?? [event.track]
      for (const track of tracks) {
        if (!link.remoteStream.getTracks().some((candidate) => candidate.id === track.id)) link.remoteStream.addTrack(track)
      }
      this.emit(call, this.snapshot.status, this.snapshot.message)
    }
    pc.onicecandidate = (event) => {
      if (!event.candidate || this.call !== call || call.links.get(identityKey) !== link) return
      const candidate = event.candidate.toJSON()
      if (!link.signalingReady) link.localCandidates.push(candidate)
      else void this.sendTo(call, identityKey, { v: 2, type: 'ice', callId: call.callId, to: identityKey, candidate }).catch(() => undefined)
    }
    pc.onconnectionstatechange = () => { void this.handleConnectionState(call, link) }
    if (role === 'offerer') this.installAuthenticatedChannel(call, link, pc.createDataChannel(AUTH_CHANNEL, { ordered: true }), true)
    else {
      pc.ondatachannel = (event) => {
        if (event.channel.label !== AUTH_CHANNEL) { event.channel.close(); return }
        this.installAuthenticatedChannel(call, link, event.channel, false)
      }
    }
    this.updateParticipant(call, identityKey, 'connecting')
    return link
  }

  private installAuthenticatedChannel(call: ActiveMeeting, link: PeerLink, channel: RTCDataChannel, initiator: boolean): void {
    if (link.auth) { channel.close(); return }
    const auth = new AuthenticatedRtcPeer(
      this.options.wallet,
      channel,
      link.identityKey,
      { callId: call.callId, conversationId: this.options.conversationId },
      () => {
        if (this.call !== call || call.links.get(link.identityKey) !== link) return
        link.authenticated = true
        call.startedAt ??= Date.now()
        this.applyOutboundTrackState(call, link)
        this.updateParticipant(call, link.identityKey, 'active')
        void this.sendTo(call, link.identityKey, {
          v: 2,
          type: 'media-state',
          callId: call.callId,
          to: link.identityKey,
          audioEnabled: call.audioEnabled,
          videoEnabled: call.videoEnabled,
        }).catch(() => false)
        this.emit(call, 'active', this.isGroup(call) ? 'Private authenticated meeting' : 'Wallet-authenticated peer-to-peer call')
      },
    )
    link.auth = auth
    this.updateParticipant(call, link.identityKey, 'authenticating')
    void auth.start(initiator).catch((reason: unknown) => {
      if (this.call === call && call.links.get(link.identityKey) === link) {
        void this.handlePeerFailure(call, link.identityKey, reason instanceof Error ? reason.message : 'Peer authentication failed')
      }
    })
  }

  private async handleConnectionState(call: ActiveMeeting, link: PeerLink): Promise<void> {
    if (this.call !== call || call.links.get(link.identityKey) !== link) return
    const state = link.pc.connectionState
    if (state === 'connected') {
      if (link.disconnectTimer) clearTimeout(link.disconnectTimer)
      link.disconnectTimer = undefined
    } else if (state === 'disconnected') {
      if (!link.disconnectTimer) {
        link.disconnectTimer = setTimeout(() => {
          if (this.call === call && link.pc.connectionState === 'disconnected') void this.restartOrFail(call, link)
        }, DISCONNECT_GRACE_MS)
      }
    } else if (state === 'failed') await this.restartOrFail(call, link)
  }

  private async restartOrFail(call: ActiveMeeting, link: PeerLink): Promise<void> {
    if (this.call !== call || call.links.get(link.identityKey) !== link) return
    if (link.role === 'offerer' && link.restartCount < 1) {
      link.restartCount += 1
      if (this.options.getIceServers) {
        call.iceServers = await this.options.getIceServers()
        link.pc.setConfiguration({ iceServers: call.iceServers })
      }
      link.pc.restartIce()
      const offer = await link.pc.createOffer({ iceRestart: true })
      await link.pc.setLocalDescription(offer)
      await this.sendTo(call, link.identityKey, {
        v: 2,
        type: 'offer',
        callId: call.callId,
        to: link.identityKey,
        media: call.media,
        sdp: offer.sdp ?? '',
      })
      return
    }
    await this.handlePeerFailure(call, link.identityKey, 'Peer-to-peer connection failed')
  }

  private async acquireMedia(media: CallMedia): Promise<MediaStream> {
    const getUserMedia = this.options.getUserMedia ?? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices)
    if (!getUserMedia) throw new Error('This browser does not provide camera or microphone access')
    return await getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: media === 'video'
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
        : false,
    })
  }

  private async flushRemoteCandidates(link: PeerLink): Promise<void> {
    if (!link.pc.remoteDescription) return
    for (const candidate of link.remoteCandidates.splice(0)) await link.pc.addIceCandidate(candidate)
  }

  private async flushLocalCandidates(call: ActiveMeeting, link: PeerLink): Promise<void> {
    for (const candidate of link.localCandidates.splice(0)) {
      await this.sendTo(call, link.identityKey, {
        v: 2,
        type: 'ice',
        callId: call.callId,
        to: link.identityKey,
        candidate,
      })
    }
  }

  private async sendTo(call: ActiveMeeting, recipient: string, signal: MeetingCallSignal): Promise<boolean> {
    if (this.call !== call) return false
    return await this.options.sendSignal(recipient, signal)
  }

  private applyLocalPreviewState(call: ActiveMeeting): void {
    for (const track of call.localStream?.getAudioTracks() ?? []) track.enabled = call.audioEnabled
    for (const track of call.localStream?.getVideoTracks() ?? []) track.enabled = call.videoEnabled
  }

  private applyOutboundTrackState(call: ActiveMeeting, link: PeerLink): void {
    for (const track of link.outboundTracks) {
      track.enabled = link.authenticated && (track.kind === 'audio' ? call.audioEnabled : call.videoEnabled)
    }
  }

  private async configureOutboundSender(sender: RTCRtpSender, kind: string, participantCount: number): Promise<void> {
    if (!sender?.getParameters || !sender.setParameters) return
    try {
      const parameters = sender.getParameters()
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]
      const encoding = parameters.encodings[0]
      if (kind === 'video') {
        encoding.maxBitrate = participantCount >= 6 ? 400_000 : participantCount >= 4 ? 700_000 : 1_200_000
        encoding.maxFramerate = participantCount >= 6 ? 20 : 30
        if (participantCount >= 6) encoding.scaleResolutionDownBy = 2
      } else encoding.maxBitrate = 48_000
      await sender.setParameters(parameters)
    } catch {
      // Browser codec implementations can reject pre-negotiation tuning; WebRTC defaults remain safe.
    }
  }

  private applyAllOutboundTrackStates(call: ActiveMeeting): void {
    for (const link of call.links.values()) this.applyOutboundTrackState(call, link)
  }

  private async publishMediaState(call: ActiveMeeting): Promise<void> {
    await Promise.all([...call.links.keys()].map(async (recipient) => await this.sendTo(call, recipient, {
      v: 2,
      type: 'media-state',
      callId: call.callId,
      to: recipient,
      audioEnabled: call.audioEnabled,
      videoEnabled: call.videoEnabled,
    }).catch(() => false)))
  }

  private emit(call: ActiveMeeting, status: CallStatus, message?: string): void {
    if (this.call !== call) return
    const participants = this.snapshotParticipants(call)
    this.snapshot = {
      status,
      callId: call.callId,
      peerIdentityKey: call.inviterIdentityKey === this.options.identityKey
        ? call.memberIdentityKeys.find((identityKey) => identityKey !== this.options.identityKey)
        : call.inviterIdentityKey,
      media: call.media,
      direction: call.direction,
      localStream: call.localStream,
      remoteStream: participants.find((participant) => participant.stream)?.stream,
      audioEnabled: call.audioEnabled,
      videoEnabled: call.videoEnabled,
      authenticated: participants.some((participant) => participant.authenticated),
      startedAt: call.startedAt,
      message,
      isGroup: this.isGroup(call),
      participants,
    }
    this.options.onChange(this.snapshot)
  }

  private async finish(message: string, status: 'ended' | 'error', notify: boolean): Promise<void> {
    const call = this.call
    if (!call) return
    if (notify) {
      await Promise.all(this.otherMembers(call).map(async (recipient) => {
        await this.options.sendSignal(recipient, {
          v: 2,
          type: 'leave',
          callId: call.callId,
          to: recipient,
          reason: message,
        }).catch(() => false)
      }))
    }
    const participants = this.snapshotParticipants(call)
    const peerIdentityKey = call.inviterIdentityKey === this.options.identityKey
      ? call.memberIdentityKeys.find((identityKey) => identityKey !== this.options.identityKey)
      : call.inviterIdentityKey
    this.call = null
    this.cleanup(call)
    this.snapshot = {
      status,
      callId: call.callId,
      peerIdentityKey,
      media: call.media,
      direction: call.direction,
      audioEnabled: false,
      videoEnabled: false,
      authenticated: participants.some((participant) => participant.authenticated),
      startedAt: call.startedAt,
      message,
      isGroup: this.isGroup(call),
      participants,
    }
    this.options.onChange(this.snapshot)
  }

  private async handleParticipantLeave(call: ActiveMeeting, sender: string, reason?: string): Promise<void> {
    this.removeLink(call, sender)
    call.participants.delete(sender)
    if (!this.isGroup(call)) await this.finish(reason || 'Call ended', 'ended', false)
    else {
      const count = this.activeParticipantCount(call)
      this.emit(call, 'active', `${count} participant${count === 1 ? '' : 's'} in the meeting`)
    }
  }

  private async handlePeerFailure(call: ActiveMeeting, identityKey: string, message: string): Promise<void> {
    this.removeLink(call, identityKey)
    this.updateParticipant(call, identityKey, 'unavailable')
    if (!this.isGroup(call)) await this.finish(message, 'error', false)
    else this.emit(call, 'active', `${this.shortIdentity(identityKey)} could not connect`)
  }

  private removeLink(call: ActiveMeeting, identityKey: string): void {
    const link = call.links.get(identityKey)
    if (!link) return
    call.links.delete(identityKey)
    if (link.disconnectTimer) clearTimeout(link.disconnectTimer)
    link.auth?.stop()
    link.pc.close()
    for (const track of link.outboundTracks) track.stop()
    for (const track of link.remoteStream.getTracks()) track.stop()
  }

  private cleanup(call: ActiveMeeting): void {
    if (call.inviteTimer) clearTimeout(call.inviteTimer)
    for (const identityKey of [...call.links.keys()]) this.removeLink(call, identityKey)
    for (const track of call.localStream?.getTracks() ?? []) track.stop()
    call.pendingCandidates.clear()
  }

  private participant(identityKey: string, status: CallParticipantStatus, media: CallMedia): MeetingParticipant {
    return { identityKey, status, audioEnabled: true, videoEnabled: media === 'video' }
  }

  private ensureParticipant(call: ActiveMeeting, identityKey: string): MeetingParticipant {
    let participant = call.participants.get(identityKey)
    if (!participant) {
      participant = this.participant(identityKey, 'connecting', call.media)
      call.participants.set(identityKey, participant)
    }
    return participant
  }

  private updateParticipant(call: ActiveMeeting, identityKey: string, status: CallParticipantStatus): void {
    this.ensureParticipant(call, identityKey).status = status
    this.emit(call, this.snapshot.status === 'incoming' ? 'incoming' : 'active', this.snapshot.message)
  }

  private snapshotParticipants(call: ActiveMeeting): CallParticipantSnapshot[] {
    return [...call.participants.values()].map((participant) => {
      const link = call.links.get(participant.identityKey)
      return {
        identityKey: participant.identityKey,
        status: participant.status,
        stream: link?.authenticated ? link.remoteStream : undefined,
        authenticated: link?.authenticated ?? false,
        audioEnabled: participant.audioEnabled,
        videoEnabled: participant.videoEnabled,
      }
    })
  }

  private activeParticipantCount(call: ActiveMeeting): number {
    return 1 + [...call.participants.values()].filter((participant) => (
      participant.status === 'active' || participant.status === 'authenticating' || participant.status === 'connecting'
    )).length
  }

  private otherMembers(call: ActiveMeeting): string[] {
    return call.memberIdentityKeys.filter((identityKey) => identityKey !== this.options.identityKey)
  }

  private isGroup(call: ActiveMeeting): boolean {
    return call.memberIdentityKeys.length > 2
  }

  private shortIdentity(identityKey: string): string {
    return `${identityKey.slice(0, 8)}…${identityKey.slice(-6)}`
  }

  private assertPeer(identityKey: string): void {
    if (identityKey === this.options.identityKey || !this.options.epoch.members.includes(identityKey)) {
      throw new Error('Meetings can only include current conversation members')
    }
  }
}
