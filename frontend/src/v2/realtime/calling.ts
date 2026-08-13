import { Peer, Utils, type AuthMessage, type Transport, type WalletInterface } from '@bsv/sdk'

const AUTH_TIMEOUT_MS = 15_000
const MAX_AUTH_FRAME_BYTES = 256_000

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

/** Binds one WebRTC DTLS association to an expected Metanet identity via BRC-103. */
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
        this.fail(new Error('WebRTC peer identity or meeting binding is invalid'))
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

export function defaultIceServers(): RTCIceServer[] {
  return [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ]
}
