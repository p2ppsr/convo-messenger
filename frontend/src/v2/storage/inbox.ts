import { decryptJson, encryptJson, eventDigest, liveBoxName } from '../domain/crypto'
import type { ConversationEvent, ConversationSecret } from '../domain/types'

export interface ConversationActivity {
  unread: number
  body: string
  sender: string
  at: number
}
interface InboxSnapshot {
  events: ConversationEvent[]
  unread: Array<{ id: string; at: number }>
  readAt: number
  latest?: { body: string; sender: string; at: number }
}

/** A recipient's encrypted recovery journal, never a second public archive.
 * Storage failures propagate so MessageBox retains the only forwarded copy.
 * Each conversation is encrypted under a wallet-held epoch key; old keys remain
 * available after rotation. Confirmed events are pruned only by exact digest.
 */
export class EncryptedInbox {
  constructor(private readonly identityKey: string, private readonly storage: Storage = localStorage) {}

  private key(secret: ConversationSecret): string {
    return `convo:v2:received:${liveBoxName(secret.epochs[0].rootKey, this.identityKey)}`
  }

  private read(secret: ConversationSecret): InboxSnapshot {
    const raw = this.storage.getItem(this.key(secret))
    if (!raw) return { events: [], unread: [], readAt: secret.preferences.lastReadAt }
    // Do not silently overwrite a corrupt journal or acknowledge more data.
    return decryptJson<InboxSnapshot>(secret.epochs[0].rootKey, 'received-events', raw)
  }

  private async update(secret: ConversationSecret, operation: (snapshot: InboxSnapshot) => void): Promise<void> {
    const mutate = () => {
      const snapshot = this.read(secret)
      operation(snapshot)
      this.storage.setItem(this.key(secret), encryptJson(secret.epochs[0].rootKey, 'received-events', snapshot, 512))
    }
    if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(this.key(secret), mutate)
    else mutate()
  }

  async receive(secret: ConversationSecret, event: ConversationEvent): Promise<void> {
    const epoch = secret.epochs.find((candidate) => candidate.epoch === event.epoch)
    if (event.conversationId !== secret.conversationId || !epoch?.members.includes(event.sender)) throw new Error('Invalid received event')
    // Closed epochs accept only events committed by the authenticated rotation.
    if (epoch.closure && epoch.closure.eventDigests[event.id] !== eventDigest(event)) return
    await this.update(secret, (snapshot) => {
      const existing = snapshot.events.find((candidate) => candidate.id === event.id)
      if (existing) {
        if (eventDigest(existing) !== eventDigest(event)) throw new Error('Conflicting received event')
        return
      }
      snapshot.events.push(event)
      if (event.type === 'message') {
        if (!snapshot.latest || event.createdAt >= snapshot.latest.at) {
          snapshot.latest = { body: event.body || 'Encrypted attachment', sender: event.sender, at: event.createdAt }
        }
        if (event.sender !== this.identityKey && event.createdAt > snapshot.readAt
          && !snapshot.unread.some((item) => item.id === event.id)) snapshot.unread.push({ id: event.id, at: event.createdAt })
      }
      if (event.type === 'delete' || event.type === 'edit') {
        // Avoid retaining deleted or superseded content in the rail preview.
        snapshot.latest = undefined
      }
    })
  }

  events(secret: ConversationSecret): ConversationEvent[] {
    return this.read(secret).events.filter((event) => {
      const epoch = secret.epochs.find((candidate) => candidate.epoch === event.epoch)
      return epoch && (!epoch.closure || epoch.closure.eventDigests[event.id] === eventDigest(event))
    })
  }

  async reconcile(secret: ConversationSecret, confirmed: ConversationEvent[]): Promise<void> {
    const digests = new Map(confirmed.map((event) => [event.id, eventDigest(event)]))
    if (!this.events(secret).some((event) => digests.get(event.id) === eventDigest(event))) return
    await this.update(secret, (snapshot) => {
      snapshot.events = snapshot.events.filter((event) => digests.get(event.id) !== eventDigest(event))
    })
  }

  async markRead(secret: ConversationSecret, through: number): Promise<void> {
    await this.update(secret, (snapshot) => {
      snapshot.readAt = Math.max(snapshot.readAt, through)
      snapshot.unread = snapshot.unread.filter((item) => item.at > snapshot.readAt)
    })
  }

  activity(secret: ConversationSecret): ConversationActivity {
    const snapshot = this.read(secret)
    return { unread: snapshot.unread.length, body: snapshot.latest?.body ?? '', sender: snapshot.latest?.sender ?? '', at: snapshot.latest?.at ?? secret.updatedAt }
  }
}
