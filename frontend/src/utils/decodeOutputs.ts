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

  if (fields.length < 7) {
    throw new Error('Invalid PushDrop message: not enough fields')
  }

  return {
    threadId: Utils.toUTF8(fields[3]),
    sender: Utils.toUTF8(fields[2]),
    header: fields[4],
    encryptedPayload: fields[5],
    createdAt: timestamp,
    txid: decodedTx.id('hex'),
    vout: outputIndex,
    beef
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
