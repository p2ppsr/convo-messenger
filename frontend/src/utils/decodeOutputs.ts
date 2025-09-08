// src/utils/decodeOutputs.ts
import { Transaction, PushDrop, Utils } from '@bsv/sdk'

export interface DecodedMessage {
  threadId: string
  sender: string
  header: number[]
  encryptedPayload: number[]
  createdAt: number
  txid: string
  vout: number
  beef: number[]
  recipients: string[]
}

export async function decodeOutput(
  beef: number[],
  outputIndex: number,
  timestamp: number
): Promise<DecodedMessage> {
  const decodedTx = Transaction.fromBEEF(beef)
  const output = decodedTx.outputs[outputIndex]
  const decoded = PushDrop.decode(output.lockingScript)
  const fields = decoded.fields

  console.log(`[decodeOutput] Decoding vout ${outputIndex} at timestamp ${timestamp}`)
  console.log('[decodeOutput] PushDrop fields length:', fields.length)

  if (fields.length < 7) {
    throw new Error('Invalid PushDrop message: not enough fields')
  }

  const threadId = Utils.toUTF8(fields[3])
  const sender = Utils.toHex(Array.from(fields[2] as unknown as Uint8Array))

  const recipients = Array.isArray(fields[6])
    ? fields[6]
        .map((r: unknown) => {
          try {
            return Utils.toHex(Array.from(r as unknown as Uint8Array))
          } catch (err) {
            console.warn('[decodeOutput] Failed to decode recipient field:', r, err)
            return ''
          }
        })
        .filter((r) => r.length > 0)
    : []

  console.log('[decodeOutput] Thread ID:', threadId)
  console.log('[decodeOutput] Sender:', sender)
  console.log('[decodeOutput] Recipients:', recipients)

  return {
    threadId,
    sender,
    header: fields[4],
    encryptedPayload: fields[5],
    createdAt: timestamp,
    txid: decodedTx.id('hex'),
    vout: outputIndex,
    beef,
    recipients
  }
}

export async function decodeOutputs(
  outputs: Array<{ beef: number[]; outputIndex: number; timestamp: number }>
): Promise<DecodedMessage[]> {
  return Promise.all(
    outputs.map(({ beef, outputIndex, timestamp }) =>
      decodeOutput(beef, outputIndex, timestamp).catch((err) => {
        console.warn(`[decodeOutputs] Skipping invalid output at vout ${outputIndex}:`, err)
        return null
      })
    )
  ).then((results) => results.filter((m): m is DecodedMessage => m !== null))
}
