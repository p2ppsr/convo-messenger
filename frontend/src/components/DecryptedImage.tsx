/**
 * DecryptedImage.tsx
 *
 * Displays an image that may be:
 *  - a local File (just preview with URL.createObjectURL), OR
 *  - a UHRP hash / full URL fetched from an overlay and then decrypted.
 *
 * Decryption strategy (in order):
 *   1) Legacy per-thread AES-256-GCM: if I have a 32-byte `threadKey`, try to
 *      decrypt the downloaded bytes as [IV || CIPHERTEXT || TAG].
 *   2) CurvePoint header+message: if legacy fails (or no thread key), try to
 *      decrypt using wallet identity with protocolID [1, 'ConvoAttachment'].
 *
 * On success, we Blob the plaintext and display it with an object URL.
 * We make sure Blob receives a plain ArrayBuffer (never SharedArrayBuffer) to
 * keep TypeScript happy and to avoid subtle browser differences.
 */

import React, { useEffect, useState } from 'react'
import { SymmetricKey, WalletClient } from '@bsv/sdk'
import { getCurvePoint } from '../utils/curvePointSingleton'
import constants from '../utils/constants'

type DecryptedImageProps = {
  /** Local file OR UHRP hash / full URL */
  fileOrHash: File | string
  /** Optional legacy per-thread key (32 bytes) for AES-GCM path */
  threadKey: Uint8Array
  /** Override the default UHRP gateway host */
  overlayBaseURL?: string
  alt?: string
  maxWidth?: string | number
}

/** Ensure Blob gets a plain ArrayBuffer (avoids SharedArrayBuffer typing issues) */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const bufLike = u8.buffer
  // Reuse buffer if view spans the whole ArrayBuffer
  if (
    bufLike instanceof ArrayBuffer &&
    u8.byteOffset === 0 &&
    u8.byteLength === bufLike.byteLength
  ) {
    return bufLike
  }
  // Otherwise copy into a fresh ArrayBuffer
  const out = new ArrayBuffer(u8.byteLength)
  new Uint8Array(out).set(u8)
  return out
}

const DecryptedImage: React.FC<DecryptedImageProps> = ({
  fileOrHash,
  threadKey,
  overlayBaseURL,
  alt = 'attachment',
  maxWidth = '100%'
}) => {
  const [imgUrl, setImgUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    let revoke: string | null = null // track object URL for cleanup
    let aborted = false              // bail flag if component unmounts

    ;(async () => {
      try {
        // 1) If a local file was passed in, just preview it directly.
        if (fileOrHash instanceof File) {
          const url = URL.createObjectURL(fileOrHash)
          revoke = url
          if (!aborted) setImgUrl(url)
          return
        }

        // 2) Otherwise treat it as a UHRP hash or full URL and fetch.
        const hashOrUrl = fileOrHash.trim()
        if (!hashOrUrl || hashOrUrl === 'NO_IMG') return

        const base = overlayBaseURL ?? constants.uhrpGateway
        const url = /^https?:\/\//i.test(hashOrUrl)
          ? hashOrUrl
          : `${base.replace(/\/+$/, '')}/${hashOrUrl}`

        const resp = await fetch(url, { method: 'GET' })
        if (!resp.ok) {
          // Not fatal; just don’t render anything.
          return
        }

        // Get raw encrypted bytes
        const encBuf = await resp.arrayBuffer()
        const enc = new Uint8Array(encBuf)

        let plain: Uint8Array | null = null

        // 3A) Try legacy per-thread AES-256-GCM if we have a valid 32-byte key.
        if (threadKey && threadKey.length === 32) {
          try {
            const sym = new SymmetricKey(Array.from(threadKey))
            const decArr = sym.decrypt(Array.from(enc)) as number[]
            plain = new Uint8Array(decArr)
          } catch {
            // Legacy failed—fall through to CurvePoint attempt below.
          }
        }

        // 3B) Try CurvePoint header+message decryption (uses wallet identity).
        if (!plain) {
          try {
            const wallet = new WalletClient('auto', constants.walletHost)
            const curve = getCurvePoint(wallet)
            const dec = await curve.decrypt(
              Array.from(enc),
              [1, 'ConvoAttachment'], // protocol namespace for attachments
              '1'                      // keyID
            )
            plain = new Uint8Array(dec)
          } catch {
            // Both decrypt paths failed—nothing to display.
            return
          }
        }

        // 4) Turn plaintext into an object URL so <img> can render it.
        const mime = resp.headers.get('content-type') || 'application/octet-stream'
        const blob = new Blob([toArrayBuffer(plain)], { type: mime })
        const objectUrl = URL.createObjectURL(blob)
        revoke = objectUrl
        if (!aborted) setImgUrl(objectUrl)
      } catch (e) {
        console.error('[DecryptedImage] error', e)
      }
    })()

    // Cleanup object URL on unmount or prop change
    return () => {
      aborted = true
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [fileOrHash, threadKey, overlayBaseURL])

  if (!imgUrl) return null
  return <img style={{ maxWidth }} src={imgUrl} alt={alt} />
}

export default DecryptedImage
