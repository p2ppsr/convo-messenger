import { getFromCache, updateCacheWithPreviews } from './messageCache'
import { downloadAndDecryptFile } from './fileEncryptor'
import type { WalletClient, WalletProtocol } from '@bsv/sdk'

export async function getPreviewForMessage(
  client: WalletClient,
  protocolID: WalletProtocol,
  keyID: string,
  msg: any,
  file: any
) {
  const uniqueID = msg.uniqueID ?? `${msg.txid}:${msg.vout}`
  const handle = file.handle

  // 1. check cache
  const cached = getFromCache(uniqueID)?.filePreviews?.[handle]
  if (cached) {
    console.log(`[Preview][CACHE HIT] ${uniqueID} → ${handle}`)
    return cached
  }

  // 2. download + decrypt only if needed
  console.log(`[Preview][FETCH] ${uniqueID} → ${handle}`)
  const blob = await downloadAndDecryptFile(
    client,
    protocolID,
    keyID,
    handle,
    file.header,
    file.mimetype
  )

  let preview: any
  if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
    preview = URL.createObjectURL(blob)
  } else if (file.mimetype.startsWith('text/')) {
    preview = await blob.text()
  } else if (file.mimetype.startsWith('audio/')) {
    preview = { type: 'audio', audioUrl: URL.createObjectURL(blob) }
  } else if (file.mimetype.startsWith('video/')) {
    preview = { type: 'video', videoUrl: URL.createObjectURL(blob) }
  } else {
    preview = null
  }

  // 3. write to **global** cache (now future loads are instant)
  updateCacheWithPreviews(uniqueID, { [handle]: preview })

  return preview
}
