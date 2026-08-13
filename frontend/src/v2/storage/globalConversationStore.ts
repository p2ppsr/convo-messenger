import { GlobalKVStore, Utils, type WalletInterface } from '@bsv/sdk'
import { decryptJson, encryptJson, eventDigest, eventLocator, eventTag, manifestLocator, pageLocator } from '../domain/crypto'
import type {
  ConversationEpoch,
  ConversationEvent,
  ConversationSecret,
  EventPage,
  MemberManifest,
} from '../domain/types'
import { validAttachmentSet } from '../domain/attachmentValidation'
import { recoverGlobalKvWrite } from './kvWriteRecovery'

const MAX_PAGE_EVENTS = 32
const MAX_PAGE_PLAINTEXT_BYTES = 24_000
const MAX_PAGES_PER_MEMBER = 10_000
const MAX_EVENTS_PER_MEMBER = MAX_PAGES_PER_MEMBER * MAX_PAGE_EVENTS
const EVENT_QUERY_PAGE_SIZE = 100
const OVERLAY_LOOKUP_HOSTS = ['https://backend.2b63ed8575c49054dd0ac65c61e7e6c6.projects.babbage.systems']

export interface OverlayEntry {
  key?: string
  value: string
  tags?: string[]
  token?: { txid: string; outputIndex: number }
}

export interface OverlayQuery {
  key?: string
  controller?: string
  tags?: string[]
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
}

export interface ConversationOverlay {
  get(query: OverlayQuery, options?: { includeToken?: boolean }): Promise<OverlayEntry | OverlayEntry[] | undefined>
  set(key: string, value: string, options?: { tags?: string[] }): Promise<string>
}

interface TaggedBeef {
  beef: number[]
  topics: string[]
}

interface PatchableStore {
  topicBroadcaster: { facilitator: { send: (url: string, taggedBEEF: TaggedBeef) => Promise<unknown> } }
  submitToOverlay: (tx: unknown) => Promise<{ status?: string; code?: string; description?: string }>
}

const overlaysByWallet = new WeakMap<object, ConversationOverlay>()

export function overlayFor(wallet: WalletInterface): ConversationOverlay {
  const key = wallet as object
  const existing = overlaysByWallet.get(key)
  if (existing) return existing
  const store = new GlobalKVStore({ wallet, hostOverrides: { ls_kvstore: OVERLAY_LOOKUP_HOSTS } } as never)
  const patchable = store as unknown as PatchableStore
  patchable.topicBroadcaster.facilitator = {
    send: async (url, taggedBEEF) => {
      const response = await fetch(`${url}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Topics': JSON.stringify(taggedBEEF.topics) },
        body: new Uint8Array(taggedBEEF.beef),
      })
      if (!response.ok) throw new Error(`Overlay submission failed (${response.status})`)
      return await response.json()
    },
  }
  const originalSubmit = patchable.submitToOverlay.bind(store)
  patchable.submitToOverlay = async (tx) => {
    const result = await originalSubmit(tx)
    if (result?.status === 'error') throw new Error(`Overlay rejected write: ${result.code ?? 'unknown'}`)
    return result
  }
  overlaysByWallet.set(key, store as unknown as ConversationOverlay)
  return store as unknown as ConversationOverlay
}

const inMemoryLocks = new Map<string, Promise<void>>()

async function withWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return await navigator.locks.request(`convo-v2:${key}`, operation)
  }
  const previous = inMemoryLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const current = previous.catch(() => undefined).then(() => gate)
  inMemoryLocks.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (inMemoryLocks.get(key) === current) inMemoryLocks.delete(key)
  }
}

function epochFor(secret: ConversationSecret, epochNumber: number): ConversationEpoch {
  const epoch = secret.epochs.find((candidate) => candidate.epoch === epochNumber)
  if (!epoch) throw new Error(`Missing conversation epoch ${epochNumber}`)
  return epoch
}

function pagePurpose(epoch: number, writer: string, index: number): string {
  return `page:${epoch}:${writer}:${index}`
}

function manifestPurpose(epoch: number, writer: string): string {
  return `manifest:${epoch}:${writer}`
}

function eventPurpose(epoch: number, writer: string, key: string): string {
  return `event:${epoch}:${writer}:${key}`
}

function oneEntry(result: OverlayEntry | OverlayEntry[] | undefined): OverlayEntry | undefined {
  return Array.isArray(result) ? result[0] : result
}

function manyEntries(result: OverlayEntry | OverlayEntry[] | undefined): OverlayEntry[] {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

function validEvent(event: unknown, epoch: ConversationEpoch, writer: string): event is ConversationEvent {
  if (typeof event !== 'object' || event === null) return false
  const candidate = event as Partial<ConversationEvent>
  if (candidate.v !== 2
    || typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 128
    || typeof candidate.conversationId !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.conversationId)
    || candidate.epoch !== epoch.epoch || candidate.sender !== writer
    || typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)
    || candidate.createdAt < epoch.activatedAt - 300_000
    || candidate.createdAt > Date.now() + 300_000) return false
  const validTarget = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128
  if (candidate.type === 'message') return typeof candidate.body === 'string'
    && candidate.body.length <= 20_000
    && (candidate.replyTo === undefined || validTarget(candidate.replyTo))
    && validAttachmentSet(candidate.attachments, candidate.attachmentKey, candidate.conversationId, candidate.epoch)
  if (candidate.type === 'edit') return validTarget(candidate.targetId) && typeof candidate.body === 'string' && candidate.body.length <= 20_000
  if (candidate.type === 'delete') return validTarget(candidate.targetId)
  if (candidate.type === 'reaction') return validTarget(candidate.targetId) && typeof candidate.emoji === 'string' && candidate.emoji.length > 0 && candidate.emoji.length <= 32
  if (candidate.type === 'metadata') return candidate.title === undefined || (typeof candidate.title === 'string' && candidate.title.length <= 100)
  if (candidate.type === 'membership') return epoch.admins.includes(writer)
    && candidate.previousEpoch === epoch.epoch - 1
    && Array.isArray(candidate.members) && candidate.members.length === epoch.members.length
    && candidate.members.every((member, index) => member === epoch.members[index])
    && Array.isArray(candidate.admins) && candidate.admins.length === epoch.admins.length
    && candidate.admins.every((admin, index) => admin === epoch.admins[index])
  return false
}

export class GlobalConversationStore {
  constructor(private readonly overlay: ConversationOverlay) {}

  async readManifest(epoch: ConversationEpoch, member: string): Promise<MemberManifest | null> {
    const key = manifestLocator(epoch.rootKey, member)
    const entry = oneEntry(await this.overlay.get({ key, controller: member }))
    if (!entry) return null
    if (entry.value.length > 10_000) throw new Error('Manifest ciphertext is too large')
    const manifest = decryptJson<MemberManifest>(epoch.rootKey, manifestPurpose(epoch.epoch, member), entry.value)
    if (manifest.writer !== member || manifest.epoch !== epoch.epoch
      || !Number.isSafeInteger(manifest.currentPage) || manifest.currentPage < 0 || manifest.currentPage >= MAX_PAGES_PER_MEMBER
      || manifest.pageCount !== manifest.currentPage + 1
      || !Number.isSafeInteger(manifest.eventCount) || manifest.eventCount < 0) throw new Error('Manifest scope mismatch')
    return manifest
  }

  async readPage(epoch: ConversationEpoch, member: string, index: number): Promise<EventPage | null> {
    const key = pageLocator(epoch.rootKey, member, index)
    const entry = oneEntry(await this.overlay.get({ key, controller: member }))
    if (!entry) return null
    if (entry.value.length > 100_000) throw new Error('Page ciphertext is too large')
    const page = decryptJson<EventPage>(epoch.rootKey, pagePurpose(epoch.epoch, member, index), entry.value)
    if (page.writer !== member || page.epoch !== epoch.epoch || page.index !== index || typeof page.sealed !== 'boolean') throw new Error('Page scope mismatch')
    if (!Array.isArray(page.events) || page.events.length > MAX_PAGE_EVENTS || !page.events.every((event) => validEvent(event, epoch, member))) throw new Error('Page contains an invalid event')
    return page
  }

  async append(secret: ConversationSecret, identityKey: string, event: ConversationEvent): Promise<string> {
    const epoch = epochFor(secret, event.epoch)
    if (!epoch.members.includes(identityKey) || event.sender !== identityKey) throw new Error('Writer is not an epoch member')
    if (event.conversationId !== secret.conversationId) throw new Error('Event belongs to another conversation')
    if (Utils.toArray(JSON.stringify(event), 'utf8').length > MAX_PAGE_PLAINTEXT_BYTES) throw new Error('Event is too large for an encrypted page')

    return await withWriteLock(`${secret.conversationId}:${event.epoch}:${identityKey}`, async () => {
      // Every event owns an immutable token. A wallet/overlay retry can therefore
      // only re-submit the exact same ciphertext; it can never replace a sibling
      // event that won a competing spend.
      const key = eventLocator(epoch.rootKey, identityKey, event.id)
      const tag = eventTag(epoch.rootKey, identityKey)
      const matchesEvent = (ciphertext: string | undefined): boolean => {
        if (!ciphertext) return false
        try {
          const stored = decryptJson<ConversationEvent>(epoch.rootKey, eventPurpose(epoch.epoch, identityKey, key), ciphertext)
          return validEvent(stored, epoch, identityKey) && eventDigest(stored) === eventDigest(event)
        } catch {
          return false
        }
      }
      const existing = oneEntry(await this.overlay.get({ key, controller: identityKey }, { includeToken: true }))
      if (existing) {
        if (!matchesEvent(existing.value)) throw new Error('An immutable event locator already contains different data')
        return existing.token ? `${existing.token.txid}.${existing.token.outputIndex}` : 'already-persisted'
      }
      const value = encryptJson(epoch.rootKey, eventPurpose(epoch.epoch, identityKey, key), event, 1024)
      return await recoverGlobalKvWrite({
        intendedValue: value,
        acceptCurrent: (current) => matchesEvent(current.value),
        write: async () => await this.overlay.set(key, value, { tags: [tag] }),
        readCurrent: async () => {
          const entry = oneEntry(await this.overlay.get({ key, controller: identityKey }, { includeToken: true }))
          return {
            value: entry?.value,
            outpoint: entry?.token ? `${entry.token.txid}.${entry.token.outputIndex}` : undefined,
          }
        },
      })
    })
  }

  private async readImmutableEvents(epoch: ConversationEpoch, member: string, eventLimit: number): Promise<{
    events: ConversationEvent[]
    partial: boolean
    loaded: number
  }> {
    const events: ConversationEvent[] = []
    const tag = eventTag(epoch.rootKey, member)
    let skip = 0
    let rejected = false
    while (skip < eventLimit) {
      const limit = Math.min(EVENT_QUERY_PAGE_SIZE, eventLimit - skip)
      const entries = manyEntries(await this.overlay.get({ controller: member, tags: [tag], limit, skip, sortOrder: 'desc' }))
      for (const entry of entries) {
        if (!entry.key || entry.value.length > 100_000) throw new Error('Immutable event entry is invalid')
        const event = decryptJson<ConversationEvent>(epoch.rootKey, eventPurpose(epoch.epoch, member, entry.key), entry.value)
        if (entry.key !== eventLocator(epoch.rootKey, member, event.id) || !validEvent(event, epoch, member)) {
          throw new Error('Immutable event scope mismatch')
        }
        const expectedDigest = epoch.closure?.eventDigests[event.id]
        if (epoch.closure && (!expectedDigest || expectedDigest !== eventDigest(event))) {
          rejected = true
          continue
        }
        events.push(event)
      }
      skip += entries.length
      if (entries.length < limit) return { events, partial: rejected, loaded: entries.length === 0 ? 0 : Math.ceil(skip / EVENT_QUERY_PAGE_SIZE) }
    }
    return { events, partial: true, loaded: Math.ceil(skip / EVENT_QUERY_PAGE_SIZE) }
  }

  async read(secret: ConversationSecret, options: { tailPages?: number } = {}): Promise<{
    events: ConversationEvent[]
    partial: boolean
    loadedPages: number
  }> {
    const events: ConversationEvent[] = []
    let partial = false
    let loadedPages = 0
    const tailPages = Math.max(1, Math.min(MAX_PAGES_PER_MEMBER, Math.floor(options.tailPages ?? 3)))
    const eventLimit = Math.min(MAX_EVENTS_PER_MEMBER, tailPages * MAX_PAGE_EVENTS)

    await Promise.all(secret.epochs.flatMap((epoch) => epoch.members.map(async (member) => {
      try {
        const immutable = await this.readImmutableEvents(epoch, member, eventLimit)
        events.push(...immutable.events)
        loadedPages += immutable.loaded
        if (immutable.partial) partial = true

        // Read the original paged layout as a migration bridge. All new writes
        // use immutable entries, so this path never participates in contention.
        const manifest = await this.readManifest(epoch, member)
        if (!manifest) return
        const start = Math.max(0, manifest.currentPage - tailPages + 1)
        if (start > 0) partial = true
        const pages = await Promise.all(
          Array.from({ length: manifest.currentPage - start + 1 }, (_, offset) => this.readPage(epoch, member, start + offset)),
        )
        for (const page of pages) {
          if (page) {
            loadedPages += 1
            for (const event of page.events) {
              if (event.conversationId !== secret.conversationId) { partial = true; continue }
              const expectedDigest = epoch.closure?.eventDigests[event.id]
              if (epoch.closure && (!expectedDigest || expectedDigest !== eventDigest(event))) { partial = true; continue }
              events.push(event)
            }
          }
        }
      } catch {
        partial = true
      }
    })))
    for (const epoch of secret.epochs) {
      if (!epoch.closure) continue
      const observed = new Set(events.filter((event) => event.epoch === epoch.epoch).map((event) => event.id))
      if (Object.keys(epoch.closure.eventDigests).some((id) => !observed.has(id))) partial = true
    }
    return { events, partial, loadedPages }
  }
}
