import { useEffect, useRef, useState } from 'react'
import { Download, ImageIcon, Mic2, RefreshCw } from 'lucide-react'
import type { AttachmentReference, MaterializedMessage } from '../domain/types'

interface Props {
  attachment: AttachmentReference
  message: MaterializedMessage
  index: number
  media: 'audio' | 'image'
  onOpen: (message: MaterializedMessage, attachmentIndex: number) => Promise<Blob>
}

export function EncryptedMediaAttachment({ attachment, message, index, media, onOpen }: Props) {
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const container = useRef<HTMLElement>(null)
  const opener = useRef(onOpen)
  const messageRef = useRef(message)

  useEffect(() => { opener.current = onOpen }, [onOpen])
  useEffect(() => { messageRef.current = message }, [message])
  useEffect(() => {
    const element = container.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '480px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    let active = true
    let objectUrl = ''
    setFailed(false)
    void opener.current(messageRef.current, index).then((blob) => {
      if (!active) return
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    }).catch(() => { if (active) setFailed(true) })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setUrl('')
    }
  }, [attachment.id, attempt, index, message.id, visible])

  return (
    <figure className={`encrypted-media ${media}`} ref={container}>
      {url
        ? media === 'image'
          ? <img src={url} alt={attachment.name} loading="lazy" decoding="async" />
          : <audio src={url} controls preload="metadata" aria-label={attachment.name} />
        : <div className={`encrypted-media-state ${failed ? 'failed' : ''}`}>
          {failed ? <RefreshCw size={21} /> : <span className="spinner" />}
          <span>{failed ? `Could not decrypt ${media}` : `Decrypting private ${media}…`}</span>
          {failed && <button onClick={() => setAttempt((value) => value + 1)}>Try again</button>}
        </div>}
      <figcaption>
        <span>{media === 'image' ? <ImageIcon size={15} /> : <Mic2 size={15} />}<strong>{attachment.name}</strong><small>{Math.max(1, Math.round(attachment.size / 1024))} KB · CurvePoint encrypted</small></span>
        {url && <a href={url} download={attachment.name} aria-label={`Download ${attachment.name}`}><Download size={16} /></a>}
      </figcaption>
    </figure>
  )
}
