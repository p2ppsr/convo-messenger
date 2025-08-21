// src/utils/syncThreads.ts
import {
  LookupResolver,
  Transaction,
  PushDrop,
  Utils,
  WalletClient
} from '@bsv/sdk'
import { CurvePoint } from 'curvepoint'
import constants from './constants'
import { listThreads, upsertThread, setThreadKey } from './threadStore'
import { myIdentityKeyHex, unboxKeyFrom } from './wallet'

/**
 * Optional: allow overriding lookup hosts (like LARS/CARS endpoints)
 * via constants.lookupHosts: string[]
 */
const resolver = new LookupResolver({
  networkPreset: constants.networkPreset,
  // @ts-ignore optional override
  hosts: (constants as any)?.lookupHosts
})

/* --------------------- Types & guards for Lookup --------------------- */
type ThreadsJson = {
  items?: Array<{ threadId: string; title?: string }>
  nextAfter?: number
}
type JsonAnswer<T> = { type: 'json'; value: T }
type OutputListAnswer = {
  type: 'output-list'
  outputs: Array<{ beef: number[]; outputIndex: number }>
}
type LookupAnswer = JsonAnswer<unknown> | OutputListAnswer | { type: string }

function isJson<T>(a: unknown): a is JsonAnswer<T> {
  return typeof a === 'object' && a != null && (a as any).type === 'json'
}
function isOutputList(a: unknown): a is OutputListAnswer {
  return typeof a === 'object' && a != null && (a as any).type === 'output-list'
}

/* ------------------------------ Utils -------------------------------- */
function toB64(u8: Uint8Array): string {
  return btoa(String.fromCharCode(...u8))
}

/** Never throw on lookup; log and return null so UI keeps working. */
async function safeQuery(q: {
  service: string
  query: Record<string, unknown>
}): Promise<LookupAnswer | null> {
  try {
    const res = (await resolver.query(q)) as any
    return res
  } catch (err: any) {
    console.warn('[syncThreads] lookup failed', {
      service: q.service,
      query: q.query,
      message: err?.message ?? String(err)
    })
    // surfaces engine payload if present
    const resp = (err as any)?.response
    if (resp) {
      console.warn('[syncThreads] lookup failed (response)', {
        status: resp.status,
        statusText: resp.statusText,
        data: resp.data
      })
    }
    return null
  }
}

/* --------------------------- Main sync flow --------------------------- */
export async function syncThreadsFromOverlay(): Promise<void> {
  // My identity (lowercased for comparisons)
  let me = ''
  try {
    me = (await myIdentityKeyHex()).toLowerCase()
  } catch {
    console.warn('[syncThreads] could not load my identity; skipping sync.')
    return
  }

  // 1) Which threads am I in? (Prefer JSON shape from lookup service)
  const threadsRes = await safeQuery({
    service: constants.overlayTopic, // must be 'ls_convo'
    query: { type: 'findThreads', memberId: me, limit: 100 }
  })
  if (!threadsRes) return

  const threadIds = new Set<string>()
  const titles = new Map<string, string | undefined>()

  if (isJson<ThreadsJson>(threadsRes)) {
    const items = Array.isArray(threadsRes.value?.items)
      ? (threadsRes.value.items as ThreadsJson['items'])!
      : []
    console.log('[syncThreads] findThreads: received json', {
      items: items.length,
      nextAfter: (threadsRes.value as any)?.nextAfter ?? null
    })
    for (const t of items) {
      if (t?.threadId) {
        threadIds.add(t.threadId)
        if (t.title) titles.set(t.threadId, t.title)
      }
    }
  } else if (isOutputList(threadsRes)) {
    // Fallback only: decode threadId from outputs (not expected for findThreads)
    console.log('[syncThreads] findThreads: got output-list (fallback path)', {
      outputs: threadsRes.outputs.length
    })
    for (const out of threadsRes.outputs) {
      try {
        const tx = Transaction.fromBEEF(out.beef)
        const script = tx.outputs[out.outputIndex].lockingScript
        const { fields } = PushDrop.decode(script)
        const tid = Utils.toUTF8(fields[0])
        if (tid) threadIds.add(tid)
      } catch {
        /* ignore malformed */
      }
    }
  } else {
    console.warn('[syncThreads] findThreads: unexpected answer shape', threadsRes)
    return
  }

  const have = new Set(listThreads().map(t => t.id))

  // Prepare CurvePoint for decrypting group key envelopes
  let curve: CurvePoint | null = null
  try {
    const wallet = new WalletClient('auto', constants.walletHost)
    curve = new CurvePoint(wallet)
  } catch (e) {
    console.warn('[syncThreads] could not init CurvePoint wallet client', e)
  }

  // 2) For each new thread, fetch memberships; decrypt group key; persist with participants
  for (const threadId of threadIds) {
    if (have.has(threadId)) continue

    const membersRes = await safeQuery({
      service: constants.overlayTopic,
      query: { type: 'findMembers', threadId }
    })
    if (!membersRes || !isJson<any[]>(membersRes) || !Array.isArray(membersRes.value)) {
      console.warn('[syncThreads] findMembers: unexpected shape or null', membersRes)
      continue
    }

    console.log('[syncThreads] findMembers: received json', {
      threadId,
      members: membersRes.value.length
    })

    // Gather all participants (lowercased, unique)
    const participants: string[] = Array.from(
      new Set(
        membersRes.value
          .map((m: any) => (typeof m?.memberId === 'string' ? m.memberId.toLowerCase() : ''))
          .filter(Boolean)
      )
    )

    // Find my membership row
    const mine = membersRes.value.find(
      (m: any) => typeof m?.memberId === 'string' && m.memberId.toLowerCase() === me
    )
    if (!mine) {
      console.warn('[syncThreads] no membership for me in thread', { threadId, me })
      continue
    }

    let rawKey: Uint8Array | null = null

    // Preferred: CurvePoint envelope (new format)
    if (typeof mine.groupKeyEnvelopeB64 === 'string' && mine.groupKeyEnvelopeB64) {
      if (!curve) {
        console.warn('[syncThreads] cannot decrypt envelope: CurvePoint not initialized')
      } else {
        try {
          const envelope = Utils.toArray(mine.groupKeyEnvelopeB64, 'base64') as number[]
          const decrypted = await curve.decrypt(envelope, [1, 'ConvoGroupKey'], '1')
          rawKey = Uint8Array.from(decrypted)
        } catch (err) {
          console.warn('[syncThreads] CurvePoint decrypt failed', { threadId, err })
        }
      }
    }

    // Legacy fallback: per-member ECDH box
    if (!rawKey && typeof mine.groupKeyBox === 'string' && typeof mine.groupKeyFrom === 'string') {
      try {
        rawKey = await unboxKeyFrom(mine.groupKeyBox, mine.groupKeyFrom)
      } catch (err) {
        console.warn('[syncThreads] legacy unbox failed', { threadId, err })
      }
    }

    if (!rawKey || rawKey.length !== 32) {
      console.warn('[syncThreads] could not recover 32-byte thread key', { threadId })
      continue
    }

    // Store locally so UI can render + send immediately (recipients are crucial!)
    upsertThread({
      id: threadId,
      name: titles.get(threadId),
      keyB64: toB64(rawKey),
      participants
    })
    setThreadKey(threadId, rawKey)

    console.log('[syncThreads] thread stored', {
      threadId,
      participants: participants.length,
      hasTitle: titles.has(threadId)
    })
  }
}
