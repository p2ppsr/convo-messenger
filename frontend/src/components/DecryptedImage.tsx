import React, { useEffect, useState } from 'react'
import { SymmetricKey } from '@bsv/sdk'
import constants from '../utils/constants'

type DecryptedImageProps = {
  fileOrHash: File | string
  threadKey: Uint8Array
  overlayBaseURL?: string
  alt?: string
  maxWidth?: string | number
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
    let revoke: string | null = null
    let aborted = false

    ;(async () => {
      try {
        // If the user just selected a file locally, show it directly.
        if (fileOrHash instanceof File) {
          const url = URL.createObjectURL(fileOrHash)
          revoke = url
          if (!aborted) setImgUrl(url)
          return
        }

        // Otherwise, it's a UHRP hash (or a full URL). Fetch the encrypted bytes.
        const hashOrUrl = fileOrHash.trim()
        if (!hashOrUrl || hashOrUrl === 'NO_IMG') return

        const base = overlayBaseURL ?? constants.uhrpGateway
        const url = /^https?:\/\//i.test(hashOrUrl) ? hashOrUrl : `${base.replace(/\/+$/,'')}/${hashOrUrl}`

        const resp = await fetch(url, { method: 'GET' })
        if (!resp.ok) {
          console.error('[DecryptedImage] fetch failed', resp.status, resp.statusText)
          return
        }

        const encryptedBuf = await resp.arrayBuffer()
        const encrypted = new Uint8Array(encryptedBuf)

        // Decrypt using the per-thread key.
        const sym = new SymmetricKey(Array.from(threadKey))
        const plainArr = sym.decrypt(Array.from(encrypted)) as number[]
        const plain = new Uint8Array(plainArr)

        const mimeType = resp.headers.get('content-type') || 'application/octet-stream'
        const blob = new Blob([plain], { type: mimeType })
        const objectUrl = URL.createObjectURL(blob)
        revoke = objectUrl

        if (!aborted) setImgUrl(objectUrl)
      } catch (e) {
        console.error('[DecryptedImage] error', e)
      }
    })()

    return () => {
      aborted = true
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [fileOrHash, threadKey, overlayBaseURL])

  if (!imgUrl) return null
  return <img style={{ maxWidth }} src={imgUrl} alt={alt} />
}

export default DecryptedImage
