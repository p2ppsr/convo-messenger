import { LookupResolver, Utils, SymmetricKey, Hash, PrivateKey, PublicKey } from '@bsv/sdk'
import { decodeOutputs, type ServerMessage } from './decodeOutputs'
import constants from './constants'

export interface ChatMessage {
  text: string
  authorId: string
  image?: string
}

/** ---------- Tiny utils ---------- */
function b64ToU8(b64: string): Uint8Array {
  return Uint8Array.from(Utils.toArray(b64, 'base64') as number[])
}
function u8ToUtf8(u8: Uint8Array): string {
  return Utils.toUTF8(Array.from(u8))
}
function utf8ToBytes(s: string): number[] {
  return Utils.toArray(s, 'utf8') as number[]
}
function b64ToBytes(b64: string): number[] {
  return Utils.toArray(b64, 'base64') as number[]
}
function concatIvCipherTag(iv: Uint8Array, payload: Uint8Array, tag: Uint8Array): number[] {
  const out = new Uint8Array(iv.length + payload.length + tag.length)
  out.set(iv, 0); out.set(payload, iv.length); out.set(tag, iv.length + payload.length)
  return Array.from(out)
}

export function boxGroupKeyForMember(
  recipientPubHex: string,
  myEphemeralPrivHex: string,
  rawGroupKey: Uint8Array
): string {
  const ephemPriv = new PrivateKey(Utils.toArray(myEphemeralPrivHex, 'hex') as number[])
  const recipPub  = PublicKey.fromString(recipientPubHex)

  const shared  = recipPub.deriveSharedSecret(ephemPriv)
  const wrapKey = Hash.sha256(shared.encode(true))
  const sym     = new SymmetricKey(wrapKey)

  const sealedAny = sym.encrypt(Array.from(rawGroupKey))
  const sealed    = Array.isArray(sealedAny) ? sealedAny : (Utils.toArray(sealedAny, 'hex') as number[])

  const iv   = sealed.slice(0, 32)
  const tail = sealed.slice(32)
  const tag  = tail.slice(-16)
  const ct   = tail.slice(0, -16)

  const box = {
    epk: ephemPriv.toPublicKey().toDER('hex') as string,
    iv:  Utils.toBase64(iv),
    tag: Utils.toBase64(tag),
    payload: Utils.toBase64(ct)
  }
  return Utils.toBase64(utf8ToBytes(JSON.stringify(box)))
}

export function unboxGroupKeyForMe(myPrivHex: string, boxB64: string): Uint8Array {
  const boxJson = Utils.toUTF8(b64ToBytes(boxB64))
  const { epk, iv, tag, payload } = JSON.parse(boxJson) as {
    epk: string; iv: string; tag: string; payload: string
  }

  const myPriv = new PrivateKey(Utils.toArray(myPrivHex, 'hex') as number[])
  const epkPub = PublicKey.fromString(epk)

  const shared  = epkPub.deriveSharedSecret(myPriv)
  const wrapKey = Hash.sha256(shared.encode(true))
  const sym     = new SymmetricKey(wrapKey)

  const packed: number[] = [ ...b64ToBytes(iv), ...b64ToBytes(payload), ...b64ToBytes(tag) ]
  const raw = sym.decrypt(packed) as number[]
  return Uint8Array.from(raw)
}

async function decryptWithSymKey(
  keyBytes: Uint8Array,
  cipher: { iv: string; tag: string; payload: string; aad?: string }
): Promise<Uint8Array> {
  const iv = b64ToU8(cipher.iv)
  const tag = b64ToU8(cipher.tag)
  const ct  = b64ToU8(cipher.payload)
  const packed = concatIvCipherTag(iv, ct, tag)
  const key = new SymmetricKey(Array.from(keyBytes))
  const pt = key.decrypt(packed) as number[]
  return Uint8Array.from(pt)
}

export default async function checkMessages(
  threadIds: string[],
  lastSeen: Record<string, number>,
  groupKeys: Record<string, Uint8Array>,
  limitPerThread = 100
): Promise<Map<string, ChatMessage[]>> {
  const resolver = new LookupResolver({ networkPreset: constants.networkPreset })
  const out = new Map<string, ChatMessage[]>()

  await Promise.all(threadIds.map(async (threadId) => {
    const key = groupKeys[threadId]
    if (!key) return

    let response: any
    try {
      response = await resolver.query({
        service: constants.overlayTopic, // 'ls_convo'
        query: { type: 'findMessages', threadId, limit: limitPerThread }
      })
    } catch (e) {
      console.error('[checkMessages] lookup error', { threadId, e })
      return
    }

    if (!response || response.type !== 'output-list' || !Array.isArray(response.outputs)) {
      console.error('[checkMessages] unexpected response', { threadId, response })
      return
    }

    let decoded: ServerMessage[]
    try {
      const raw = response.outputs.map((o: any) => ({ beef: o.beef, outputIndex: o.outputIndex }))
      decoded = await decodeOutputs(raw)
    } catch (e) {
      console.error('[checkMessages] decode failed', { threadId, e })
      return
    }

    const since = lastSeen[threadId] ?? 0
    const fresh = decoded.filter(m => m.sentAt > since)
    if (fresh.length === 0) return

    const list: ChatMessage[] = []
    for (const m of fresh) {
      try {
        const pt = await decryptWithSymKey(key, m.cipher)
        const body = JSON.parse(u8ToUtf8(pt)) as { text: string; image?: string }
        list.push({ text: body.text, authorId: m.sender, image: body.image })
      } catch (e) {
        console.error('[checkMessages] decrypt/parse failed', { threadId, messageId: m.messageId, e })
      }
    }

    if (list.length) out.set(threadId, list)
  }))

  return out
}
