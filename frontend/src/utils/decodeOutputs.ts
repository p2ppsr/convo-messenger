import { Transaction, PushDrop, Utils } from '@bsv/sdk'

/**
 * I support two ciphertext formats at the script level:
 *
 * 1) Legacy AES-256-GCM (7 fields)
 * 2) CurvePoint envelope + ciphertext (6 fields)
 *
 * Downstream code can check `cipher.alg` to decide how to decrypt.
 */

/* ---------- Cipher payloads (discriminated union) ---------- */

// Legacy per-thread symmetric encryption
export type LegacyCipherBlob = {
  alg: 'AES-256-GCM'
  iv: string      // base64
  tag: string     // base64
  payload: string // base64 (ciphertext)
  aad?: string    // base64 (optional)
}

// CurvePoint: header (varint length-prefixed inside bytes) + encrypted message
export type CurvepointBlob = {
  alg: 'CURVEPOINT-1'
  headerB64: string // base64 of header bytes
  cipherB64: string // base64 of encrypted message bytes
}

// One or the other
export type MessageCipher = LegacyCipherBlob | CurvepointBlob

/* ------------------- ServerMessage shape ------------------- */
export type ServerMessage = {
  _type: 'message'
  threadId: string
  messageId: string
  sender: string
  sentAt: number
  cipher: MessageCipher
}

/* ------------------------ Helpers -------------------------- */
function sUtf8(b: number[] | Uint8Array): string {
  return Utils.toUTF8(b as number[])
}

function isB64(s: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0
}

/**
 * I decode a single PushDrop message output from a BEEF transaction.
 * I do not decrypt; I only expose the raw ciphertext fields in a typed way.
 */
export async function decodeOutput(
  beef: number[],
  outputIndex: number
): Promise<ServerMessage> {
  // 1) Pull out the output
  const tx = Transaction.fromBEEF(beef)
  const out = tx.outputs[outputIndex]
  if (!out) throw new Error(`No output at vout ${outputIndex}`)

  // 2) Get fields from PushDrop
  const decoded = PushDrop.decode(out.lockingScript)
  const f = decoded.fields
  if (!Array.isArray(f) || f.length < 6) {
    throw new Error(`Unexpected field count: ${f?.length ?? 0}`)
  }

  // 3) Common fields
  const threadId = sUtf8(f[0])
  const messageId = sUtf8(f[1])
  const sender = sUtf8(f[2])

  const sentAtStr = sUtf8(f[3])
  const sentAtNum = Number(sentAtStr)
  const sentAt = Number.isFinite(sentAtNum) ? sentAtNum : Date.now()

  // 4) Decide which cipher family we have
  let cipher: MessageCipher

  if (f.length === 6) {
    // CurvePoint shape: [ threadId, messageId, sender, sentAt, headerB64, cipherB64 ]
    const headerB64 = sUtf8(f[4])
    const cipherB64 = sUtf8(f[5])

    if (!isB64(headerB64) || !isB64(cipherB64)) {
      throw new Error('CurvePoint fields must be base64')
    }

    cipher = {
      alg: 'CURVEPOINT-1',
      headerB64,
      cipherB64
    }
  } else {
    // Legacy shape (>=7): [ threadId, messageId, sender, sentAt, ivB64, tagB64, ctB64, (optional aad) ]
    const iv = sUtf8(f[4])
    const tag = sUtf8(f[5])
    const payload = sUtf8(f[6])
    const aad = f.length >= 8 ? sUtf8(f[7]) : undefined

    if (!isB64(iv) || !isB64(tag) || !isB64(payload)) {
      throw new Error('Legacy AES fields must be base64')
    }

    cipher = {
      alg: 'AES-256-GCM',
      iv,
      tag,
      payload,
      ...(aad ? { aad } : {})
    }
  }

  return {
    _type: 'message',
    threadId,
    messageId,
    sender,
    sentAt,
    cipher
  }
}

/**
 * Convenience: I decode a list of outputs. Invalid ones are skipped with a warn.
 */
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
