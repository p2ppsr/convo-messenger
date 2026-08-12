import { GlobalKVStore, Utils, type WalletInterface } from '@bsv/sdk'
import { decryptJson, encryptJson, eventDigest, manifestLocator, pageLocator } from '../domain/crypto'
import type {
  ConversationEpoch,
  ConversationEvent,
  ConversationSecret,
  EventPage,
  MemberManifest,
} from '../domain/types'
import { MAX_ATTACHMENT_BYTES } from '../services/attachments'
import { recoverGlobalKvWrite } from './kvWriteRecovery'

const MAX_PAGE_EVENTS = 32
const MAX_PAGE_PLAINTEXT_BYTES = 24_000
const MAX_PAGES_PER_MEMBER = 10_000
const OVERLAY_LOOKUP_HOSTS = ['https://backend.2b63ed8575c49054dd0ac65c61e7e6c6.projects.babbage.systems']

export interface OverlayEntry {
  value: string
  token?: { txid: string; outputIndex: number }
}

export interface ConversationOverlay {
  get(query: { key: string; controller: string }, options?: { includeToken?: boolean }): Promise<OverlayEntry | undefined>
  set(key: string, value: string): Promise<string>
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
    && (candidate.attachments === undefined || (Array.isArray(candidate.attachments)
      && candidate.attachments.length <= 20
      && candidate.attachments.every((attachment) => typeof attachment === 'object' && attachment !== null
        && typeof attachment.id === 'string' && attachment.id.length <= 128
        && typeof attachment.handle === 'string' && attachment.handle.length <= 2_048
        && typeof attachment.name === 'string' && attachment.name.length <= 255
        && typeof attachment.mimeType === 'string' && attachment.mimeType.length <= 255
        && typeof attachment.size === 'number' && Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size <= MAX_ATTACHMENT_BYTES
        && typeof attachment.digest === 'string' && /^[0-9a-f]{64}$/.test(attachment.digest))))
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

async function writeValue(
  overlay: ConversationOverlay,
  key: string,
  controller: string,
  value: string,
): Promise<string> {
  return await recoverGlobalKvWrite({
    intendedValue: value,
    write: async () => await overlay.set(key, value),
    readCurrent: async () => {
      const entry = await overlay.get({ key, controller }, { includeToken: true })
      return {
        value: entry?.value,
        outpoint: entry?.token ? `${entry.token.txid}.${entry.token.outputIndex}` : undefined,
      }
    },
  })
}

export class GlobalConversationStore {
  constructor(private readonly overlay: ConversationOverlay) {}

  async readManifest(epoch: ConversationEpoch, member: string): Promise<MemberManifest | null> {
    const key = manifestLocator(epoch.rootKey, member)
    const entry = await this.overlay.get({ key, controller: member })
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
    const entry = await this.overlay.get({ key, controller: member })
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
      let manifest = await this.readManifest(epoch, identityKey) ?? {
        v: 2,
        epoch: epoch.epoch,
        writer: identityKey,
        currentPage: 0,
        pageCount: 1,
        eventCount: 0,
        updatedAt: 0,
      }
      let page = await this.readPage(epoch, identityKey, manifest.currentPage) ?? {
        v: 2,
        epoch: epoch.epoch,
        writer: identityKey,
        index: manifest.currentPage,
        sealed: false,
        events: [],
      }
      if (page.events.some((existing) => existing.id === event.id)) return 'already-persisted'

      const candidateEvents = [...page.events, event]
      const candidateSize = Utils.toArray(JSON.stringify(candidateEvents), 'utf8').length
      if (page.events.length > 0 && (candidateEvents.length > MAX_PAGE_EVENTS || candidateSize > MAX_PAGE_PLAINTEXT_BYTES)) {
        page = { ...page, sealed: true }
        const sealedValue = encryptJson(epoch.rootKey, pagePurpose(epoch.epoch, identityKey, page.index), page, 1024)
        await writeValue(this.overlay, pageLocator(epoch.rootKey, identityKey, page.index), identityKey, sealedValue)
        page = {
          v: 2,
          epoch: epoch.epoch,
          writer: identityKey,
          index: page.index + 1,
          sealed: false,
          events: [event],
        }
        manifest = { ...manifest, currentPage: page.index, pageCount: page.index + 1 }
      } else {
        page = { ...page, events: candidateEvents }
      }

      const pageValue = encryptJson(epoch.rootKey, pagePurpose(epoch.epoch, identityKey, page.index), page, 1024)
      await writeValue(this.overlay, pageLocator(epoch.rootKey, identityKey, page.index), identityKey, pageValue)
      manifest = { ...manifest, eventCount: manifest.eventCount + 1, updatedAt: event.createdAt }
      const manifestValue = encryptJson(epoch.rootKey, manifestPurpose(epoch.epoch, identityKey), manifest, 512)
      return await writeValue(this.overlay, manifestLocator(epoch.rootKey, identityKey), identityKey, manifestValue)
    })
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

    await Promise.all(secret.epochs.flatMap((epoch) => epoch.members.map(async (member) => {
      try {
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
