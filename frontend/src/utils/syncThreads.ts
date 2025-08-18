import { LookupResolver, Transaction, PushDrop, Utils } from '@bsv/sdk'
import constants from './constants'
import { listThreads, upsertThread, setThreadKey } from './threadStore'
import { myIdentityKeyHex, unboxKeyFrom } from './wallet'

const resolver = new LookupResolver({ networkPreset: constants.networkPreset })

function toB64(u8: Uint8Array): string {
  return btoa(String.fromCharCode(...u8))
}

export async function syncThreadsFromOverlay() {
  const meHex = (await myIdentityKeyHex()).toLowerCase()

  // 1) Ask the overlay for threads I’m a member of
  const res: any = await resolver.query({
    service: constants.overlayTopic, // 'ls_convo'
    query: { type: 'findThreads', memberId: meHex, limit: 100 }
  })

  const threadIds = new Set<string>()
  const titles = new Map<string, string | undefined>()

  if (res?.type === 'json') {
    const items: any[] = Array.isArray(res?.value?.items) ? res.value.items : []
    for (const t of items) {
      if (t && typeof t.threadId === 'string' && t.threadId) {
        threadIds.add(t.threadId)
        if (typeof t.title === 'string' && t.title) titles.set(t.threadId, t.title)
      }
    }
  } else if (res?.type === 'output-list') {
    const outs: any[] = Array.isArray(res?.outputs) ? res.outputs : []
    for (const out of outs) {
      try {
        const tx = Transaction.fromBEEF(out.beef)
        const script = tx.outputs[out.outputIndex].lockingScript
        const { fields } = PushDrop.decode(script)
        const tid = Utils.toUTF8(fields[0])
        if (tid) threadIds.add(tid)
      } catch {
        // ignore malformed outputs
      }
    }
  } else {
    // Unexpected/unsupported answer shape
    return
  }

  const have = new Set(listThreads().map(t => t.id))

  for (const threadId of threadIds) {
    if (have.has(threadId)) continue

    const ms: any = await resolver.query({
      service: constants.overlayTopic,
      query: { type: 'findMembers', threadId }
    })
    if (ms?.type !== 'json' || !Array.isArray(ms.value)) continue

    type MemberJSON = { memberId: string; groupKeyBox?: string; groupKeyFrom?: string }
    const mine = (ms.value as MemberJSON[]).find(
      (m) => typeof m?.memberId === 'string' && m.memberId.toLowerCase() === meHex
    )
    if (!mine?.groupKeyBox || !mine?.groupKeyFrom) continue

    const raw = await unboxKeyFrom(mine.groupKeyBox, mine.groupKeyFrom)
    upsertThread({ id: threadId, name: titles.get(threadId), keyB64: toB64(raw) })
    setThreadKey(threadId, raw)
  }
}
