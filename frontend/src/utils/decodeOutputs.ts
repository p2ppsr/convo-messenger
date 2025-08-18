import { Transaction, PushDrop, Utils } from '@bsv/sdk'

export type CipherBlob = {
  alg: 'AES-256-GCM'
  iv: string
  tag: string
  payload: string
  aad?: string
}

export type ServerMessage = {
  _type: 'message'
  threadId: string
  messageId: string
  sender: string
  sentAt: number
  cipher: CipherBlob
}

export async function decodeOutput(
  beef: number[],
  outputIndex: number
): Promise<ServerMessage> {
  // 1) Decode tx/output from BEEF
  const tx = Transaction.fromBEEF(beef)
  const out = tx.outputs[outputIndex]
  if (!out) throw new Error(`No output at vout ${outputIndex}`)

  // 2) Decode PushDrop script -> fields[]
  const decoded = PushDrop.decode(out.lockingScript)
  const f = decoded.fields

  // Basic sanity
  if (!f || f.length < 7) {
    throw new Error(`Unexpected field count: ${f?.length ?? 0}`)
  }

  // 3) Map fields (all strings)
  const threadId = Utils.toUTF8(f[0])
  const messageId = Utils.toUTF8(f[1])
  const sender = Utils.toUTF8(f[2])

  const sentAtStr = Utils.toUTF8(f[3])
  const sentAt = Number.isFinite(+sentAtStr) ? Number(sentAtStr) : Date.now()

  const iv = Utils.toUTF8(f[4])
  const tag = Utils.toUTF8(f[5])
  const payload = Utils.toUTF8(f[6])
  const aad = f.length >= 8 ? Utils.toUTF8(f[7]) : undefined

  const cipher: CipherBlob = { alg: 'AES-256-GCM', iv, tag, payload, ...(aad ? { aad } : {}) }

  const msg: ServerMessage = {
    _type: 'message',
    threadId,
    messageId,
    sender,
    sentAt,
    cipher
  }

  return msg
}

export async function decodeOutputs(
  outputs: Array<{ beef: number[]; outputIndex: number }>
): Promise<ServerMessage[]> {
  const decoded = await Promise.all(
    outputs.map(({ beef, outputIndex }) =>
      decodeOutput(beef, outputIndex).catch((err) => {
        console.warn(`[Convo decodeOutputs] Skipping invalid output @ vout ${outputIndex}:`, err)
        return null
      })
    )
  )
  return decoded.filter((m): m is ServerMessage => m !== null)
}
