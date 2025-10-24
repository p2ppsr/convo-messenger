import React, { useEffect, useRef, useState } from 'react'
import { loadReplies } from '../utils/loadReplies'
import { sendMessage } from '../utils/sendMessage'
import { uploadEncryptedFile, downloadAndDecryptFile, getFileExpiry, renewFileHosting } from '../utils/fileEncryptor'
import {
  Button,
  Box,
  Typography,
  TextField,
  Paper,
  CircularProgress,
  IconButton,
  Popover,
  Dialog
} from '@mui/material'
import FileUpload from './FileUpload'
import type { WalletClient, WalletProtocol } from '@bsv/sdk'
import type { MessagePayloadWithMetadata } from '../types/types'
import { sendReaction } from '../utils/sendReaction'
import AddReactionIcon from '@mui/icons-material/AddReaction'
import EmojiPicker from './EmojiPicker'
import { POLLING_ENABLED } from '../utils/constants'
import { useGesture } from '@use-gesture/react'

interface ThreadPanelProps {
  open: boolean
  onClose: () => void
  parentMessage: MessagePayloadWithMetadata
  client: WalletClient
  protocolID: WalletProtocol
  keyID: string
  senderPublicKey: string
  recipientPublicKeys: string[]
  threadName?: string
  nameMap?: Map<string, string>
  setNameMap?: React.Dispatch<React.SetStateAction<Map<string, string>>>
}

function normalizeSender(sender: string): string {
  try {
    if (sender.startsWith('02') || sender.startsWith('03')) return sender
    const ascii =
      sender
        .match(/.{1,2}/g)
        ?.map((b) => String.fromCharCode(parseInt(b, 16)))
        .join('') ?? sender
    if (ascii.startsWith('02') || ascii.startsWith('03')) return ascii
    return sender
  } catch {
    return sender
  }
}

export const ThreadPanel: React.FC<ThreadPanelProps> = ({
  onClose,
  parentMessage,
  client,
  protocolID,
  keyID,
  senderPublicKey,
  recipientPublicKeys,
  threadName,
  nameMap = new Map(),
  setNameMap = () => {}
}) => {
  const [messages, setMessages] = useState<MessagePayloadWithMetadata[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [currentRecipients, setCurrentRecipients] = useState<string[]>(recipientPublicKeys)
  const [reactions, setReactions] = useState<Record<string, { reaction: string; sender: string }[]>>({})
  const [emojiAnchor, setEmojiAnchor] = useState<null | HTMLElement>(null)
  const [targetMessage, setTargetMessage] = useState<MessagePayloadWithMetadata | null>(null)
  const [uploading, setUploading] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null)
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [openImage, setOpenImage] = useState<string | null>(null)
  const [openImageFilename, setOpenImageFilename] = useState<string | null>(null)
  const [reactingMsg, setReactingMsg] = useState<string | null>(null)
  const [fileExpirations, setFileExpirations] = useState<
  Record<string, { text: string; expiryTime: number }>
    >({})
  const [renewingFile, setRenewingFile] = useState<string | null>(null)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })

  // ============================= LOAD REPLIES =============================
  useEffect(() => {
  if (!parentMessage) {
    console.warn('[ThreadPanel] ⚠️ No parentMessage provided. Skipping fetchReplies.')
    return
  }

  let interval: NodeJS.Timeout | undefined
  console.log(`[ThreadPanel] ▼ useEffect triggered for parentMessage.txid = ${parentMessage.txid}`)
  console.log('Client:', client)
  console.log('ProtocolID:', protocolID)
  console.log('KeyID:', keyID)
  console.log('Polling enabled:', POLLING_ENABLED)

  setLoading(true)

  const fetchReplies = async () => {
    console.log(`[ThreadPanel] ▶ FetchReplies start for parentMessageId: ${parentMessage.txid}`)
    try {
      const result = await loadReplies({
        client,
        protocolID,
        keyID,
        parentMessageId: parentMessage.txid
      })

      console.log('[ThreadPanel] loadReplies() returned:', {
        messageCount: result.messages?.length ?? 0,
        reactionGroups: Object.keys(result.reactions ?? {}).length,
        nameMapEntries: result.nameMap?.size ?? 0
      })

      if (!result || !('messages' in result)) {
        throw new Error('Invalid loadReplies result structure')
      }

      const {
        messages: loadedMessages,
        reactions: loadedReactions,
        nameMap: resolvedNames
      } = result

      // --- Inspect first few replies ---
      if (loadedMessages.length) {
        console.log('[ThreadPanel] Loaded messages preview:')
        loadedMessages.slice(0, 5).forEach((m, i) => {
          console.log(`  Reply[${i}]`, {
            txid: m.txid,
            parentMessageId: m.parentMessageId,
            threadId: m.threadId,
            sender: m.sender,
            contentPreview: m.content?.slice?.(0, 60)
          })
        })
      } else {
        console.warn('[ThreadPanel] No replies returned by loadReplies.')
      }

      // --- Shallow diff check ---
      setMessages((prev) => {
        if (prev.length !== loadedMessages.length) {
          console.log(`[ThreadPanel] Message count changed: ${prev.length} → ${loadedMessages.length}`)
          return loadedMessages
        }
        const changed = prev.some((m, i) => m.txid !== loadedMessages[i]?.txid)
        if (changed) console.log('[ThreadPanel] Message order or IDs changed. Updating state.')
        else console.log('[ThreadPanel] No message diff detected. Skipping update.')
        return changed ? loadedMessages : prev
      })

      setReactions(loadedReactions)

      // --- Merge resolved names into existing nameMap (don’t overwrite) ---
      setNameMap((prev) => {
        const merged = new Map(prev)
        for (const [k, v] of resolvedNames.entries()) merged.set(k, v)
        return merged
      })

      // --- Auto-restore recipients ---
      if (loadedMessages.length > 0) {
        const latest = loadedMessages[loadedMessages.length - 1]
        if (latest.recipients?.length) {
          console.log('[ThreadPanel] 👥 Restoring recipients from latest message:', latest.recipients)
          setCurrentRecipients(latest.recipients)
        } else {
          console.log('[ThreadPanel] No recipients found in latest message.')
        }
      }
    } catch (err) {
      console.error('[ThreadPanel] Failed to load replies:', err)
    } finally {
      setLoading(false)
      scrollToBottom()
      console.log('[ThreadPanel] fetchReplies complete. Scrolled to bottom.')
    }
  }

  // --- Initial load ---
  fetchReplies()

  // --- Polling (if enabled) ---
  if (POLLING_ENABLED) {
    console.log('[ThreadPanel] Starting polling interval (5000ms)')
    interval = setInterval(fetchReplies, 5000)
  }

  return () => {
    if (interval) {
      clearInterval(interval)
      console.log('[ThreadPanel] Cleared polling interval on unmount.')
    }
  }
}, [parentMessage?.txid, client, protocolID, keyID])


  // ============================= FILE PREVIEWS =============================
  useEffect(() => {
    const loadFilePreviews = async () => {
      for (const msg of messages) {
        let parsed: any
        try {
          parsed = JSON.parse(msg.content)
        } catch {
          continue
        }

        // ---- Support both single files and bundles ----
        const filesToProcess =
          parsed?.type === 'file'
            ? [parsed]
            : parsed?.type === 'bundle' && Array.isArray(parsed.files)
            ? parsed.files
            : []

        for (const file of filesToProcess) {
          if (!file?.handle) continue

          try {
            // --- Fetch expiry info first ---
            try {
              const info = await getFileExpiry(client, file.handle)
              const expires =
                typeof info?.expiresInMs === 'number' && info.expiresInMs > 0
                  ? info.expiresInMs
                  : undefined
              if (expires !== undefined) {
                const hrs = Math.floor(expires / 3600000)
                const mins = Math.floor((expires % 3600000) / 60000)
                setFileExpirations(prev => ({
                  ...prev,
                  [file.handle]: {
                    text: `${hrs}h ${mins}m remaining`,
                    expiryTime: Date.now() + expires
                  }
                }))
              }
            } catch (err) {
              console.warn('[Chat] Could not get expiry for', file.filename, err)
            }

            // --- Skip preview if already loaded ---
            if (imagePreviews[file.handle]) continue

            // --- Download & decrypt preview ---
            try {
              const blob = await downloadAndDecryptFile(
                client,
                protocolID,
                keyID,
                file.handle,
                file.header,
                file.mimetype
              )

              if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
                const url = URL.createObjectURL(blob)
                setImagePreviews(prev => ({ ...prev, [file.handle]: url }))
              } else if (file.mimetype.startsWith('text/')) {
                const text = await blob.text()
                const snippet = text.length > 500 ? text.slice(0, 500) + '…' : text
                setImagePreviews(prev => ({ ...prev, [file.handle]: snippet }))
              } else {
                setImagePreviews(prev => ({ ...prev, [file.handle]: null }))
              }
            } catch (err) {
              console.warn('[Chat] Failed to load preview for', file.filename, err)
              setImagePreviews(prev => ({ ...prev, [file.handle]: 'EXPIRED' }))
            }
          } catch (err) {
            console.error('[Chat] Unexpected error in file loop:', err)
          }
        }
      }
    }

    if (messages.length > 0) loadFilePreviews()
  }, [messages])

  // ============================= PARENT MESSAGE PREVIEWS =============================
  useEffect(() => {
    if (!parentMessage) return

    const loadParentPreviews = async () => {
      let parsed: any
      try {
        parsed = JSON.parse(parentMessage.content)
      } catch {
        return
      }

      const filesToProcess =
        parsed?.type === 'file'
          ? [parsed]
          : parsed?.type === 'bundle' && Array.isArray(parsed.files)
          ? parsed.files
          : []

      for (const file of filesToProcess) {
        if (!file?.handle) continue

        // --- Fetch expiry info first ---
      try {
        const info = await getFileExpiry(client, file.handle)
        const expires =
          typeof info?.expiresInMs === 'number' && info.expiresInMs > 0
            ? info.expiresInMs
            : undefined
        if (expires !== undefined) {
          const hrs = Math.floor(expires / 3600000)
          const mins = Math.floor((expires % 3600000) / 60000)
          setFileExpirations(prev => ({
            ...prev,
            [file.handle]: {
              text: `${hrs}h ${mins}m remaining`,
              expiryTime: Date.now() + expires
            }
          }))
        }
      } catch (err) {
        console.warn('[ThreadPanel] Could not get expiry for parent file', file.filename, err)
      }

        try {
          const blob = await downloadAndDecryptFile(
            client,
            protocolID,
            keyID,
            file.handle,
            file.header,
            file.mimetype
          )

          if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
            const url = URL.createObjectURL(blob)
            setImagePreviews((prev) => ({ ...prev, [file.handle]: url }))
          } else if (file.mimetype.startsWith('text/')) {
            const text = await blob.text()
            const snippet = text.length > 500 ? text.slice(0, 500) + '…' : text
            setImagePreviews((prev) => ({ ...prev, [file.handle]: snippet }))
          } else {
            setImagePreviews((prev) => ({ ...prev, [file.handle]: null }))
          }
        } catch (err) {
          console.warn('[ThreadPanel] Failed to load parent preview for', file.filename, err)
          setImagePreviews((prev) => ({ ...prev, [file.handle]: 'EXPIRED' }))
        }
      }
    }

    loadParentPreviews()
  }, [parentMessage, client, protocolID, keyID])

  // Ensure parent sender is inserted once parentMessage becomes available
useEffect(() => {
  if (parentMessage?.sender) {
    const normalized = normalizeSender(parentMessage.sender as string)
    setNameMap(prev => {
      if (!prev.has(normalized)) {
        const updated = new Map(prev)
        updated.set(normalized, normalized.slice(0, 10) + '…')
        console.log('[ThreadPanel] Added parent sender to nameMap after mount.')
        return updated
      }
      return prev
    })
  }
}, [parentMessage?.sender])

useEffect(() => {
  const timer = setInterval(() => {
    setFileExpirations(prev => {
      const updated: typeof prev = {}
      const now = Date.now()

      for (const [handle, data] of Object.entries(prev)) {
        const remaining = data.expiryTime - now
        if (remaining <= 0) {
          updated[handle] = { text: 'Expired', expiryTime: data.expiryTime }
        } else {
          const hrs = Math.floor(remaining / 3600000)
          const mins = Math.floor((remaining % 3600000) / 60000)
          updated[handle] = {
            text: `${hrs}h ${mins}m remaining`,
            expiryTime: data.expiryTime
          }
        }
      }

      return updated
    })
  }, 60000)

  return () => clearInterval(timer)
}, [])


  // Fullscreen image viewer with gallery support
  const [openGallery, setOpenGallery] = useState<{
    images: { url: string; filename: string }[]
    index: number
  } | null>(null)

  useEffect(() => {
    if (openGallery && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  }, [openGallery])

  const bindGallerySwipe = useGesture({
    onDragEnd: ({ swipe: [swipeX] }) => {
      if (!openGallery || openGallery.images.length <= 1) return
      if (swipeX === 1) {
        // Swipe right → previous
        setOpenGallery(prev =>
          prev
            ? { ...prev, index: (prev.index - 1 + prev.images.length) % prev.images.length }
            : null
        )
      } else if (swipeX === -1) {
        // Swipe left → next
        setOpenGallery(prev =>
          prev
            ? { ...prev, index: (prev.index + 1) % prev.images.length }
            : null
        )
      }
    }
  })

  // ============================= MESSAGE SEND =============================
  const handleSend = async () => {
    // Don't send if nothing to send or already sending
    if ((!newMessage.trim() && pendingFiles.length === 0) || sending) return
    setSending(true)

    try {
      const fileMessages = []

      // Upload all pending images first
      for (const file of pendingFiles) {
        const { handle, header, filename, mimetype } = await uploadEncryptedFile(
          client,
          protocolID,
          keyID,
          currentRecipients,
          file
        )
        fileMessages.push({ type: 'file', handle, header, filename, mimetype })
      }

      // Create combined message payload
      const payload = {
        type: 'bundle',
        text: newMessage.trim(),
        files: fileMessages
      }

      // Send single unified message (text + attachments)
      await sendMessage({
        client,
        protocolID,
        keyID,
        threadId: parentMessage.threadId,
        senderPublicKey,
        recipients: currentRecipients,
        content: JSON.stringify(payload),
        threadName,
        parentMessageId: parentMessage.txid
      })

      // Add it to local UI immediately
      setMessages((prev) => [
        ...prev,
        {
          content: JSON.stringify(payload),
          sender: senderPublicKey,
          createdAt: Date.now(),
          txid: 'temp',
          vout: 0,
          threadId: parentMessage.threadId
        }
      ])

      // Reset inputs
      setNewMessage('')
      setPendingFiles([])
      scrollToBottom()
    } catch (err) {
      console.error('[ThreadPanel] Failed to send combined message:', err)
      alert('⚠️ Failed to send message.')
    } finally {
      setSending(false)
    }
  }

  // ============================= REACTIONS =============================
  const handleReact = async (msg: MessagePayloadWithMetadata, emoji: string) => {
    const key = `${msg.txid}:${msg.vout}`
    setReactingMsg(key)
    try {
      await sendReaction({
        client,
        senderPublicKey,
        threadId: parentMessage.threadId,
        reaction: emoji,
        messageTxid: msg.txid,
        messageVout: msg.vout
      })

      setReactions((prev) => {
        const existing = prev[key] || []
        const updated = [...existing, { reaction: emoji, sender: senderPublicKey }]
        return { ...prev, [key]: updated }
      })
    } catch (err) {
      console.error('[Chat] Failed to send reaction:', err)
    } finally {
      setReactingMsg(null)
    }
  }

  const handleOpenPicker = (event: React.MouseEvent, msg: MessagePayloadWithMetadata) => {
    setEmojiAnchor(event.currentTarget as HTMLElement)
    setTargetMessage(msg)
  }

  const handleClosePicker = () => {
    setEmojiAnchor(null)
    setTargetMessage(null)
  }

  const handleSelectEmoji = async (emoji: string) => {
    handleClosePicker()
    if (targetMessage) await handleReact(targetMessage, emoji)
  }

  // ============================= FILE UPLOAD/DOWNLOAD =============================
  const handleFileSelected = async (file: File) => {
    setUploading(true)
    try {
      const { handle, header, filename, mimetype } = await uploadEncryptedFile(
        client,
        protocolID,
        keyID,
        currentRecipients,
        file
      )

      const fileMessage = JSON.stringify({ type: 'file', handle, header, filename, mimetype })
      await sendMessage({
        client,
        protocolID,
        keyID,
        threadId: parentMessage.threadId,
        senderPublicKey,
        recipients: currentRecipients,
        content: fileMessage,
        threadName,
        parentMessageId: parentMessage.txid
      })

      setMessages((prev) => [
        ...prev,
        {
          content: fileMessage,
          sender: senderPublicKey,
          createdAt: Date.now(),
          txid: 'temp',
          vout: 0,
          threadId: parentMessage.threadId
        }
      ])
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to upload file:', err)
    } finally {
      setUploading(false)
    }
  }

  const handleFileDownload = async (handle: string, header: number[], filename: string, mimetype: string) => {
    setDownloadingFile(handle)
    try {
      const blob = await downloadAndDecryptFile(client, protocolID, keyID, handle, header, mimetype)
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (err: any) {
      console.error('[Chat] Failed to download file:', err)
      let message = 'File could not be downloaded.'
      const errMsg = (err?.message || '').toLowerCase()
      if (errMsg.includes('no data returned') || errMsg.includes('404') || errMsg.includes('not found')) {
        message = '⚠️ This file is no longer hosted or has expired.'
      } else if (errMsg.includes('network')) {
        message = '⚠️ Unable to reach file host.'
      }
      alert(message)
    } finally {
      setDownloadingFile(null)
    }
  }

  const handleRenewFile = async (uhrpUrl: string) => {
      setRenewingFile(uhrpUrl)
      try {
        const result = await renewFileHosting(client, uhrpUrl, 1440 * 7) // 7 days
        if (result?.status === 'success') {
          // Optionally use Snackbar later
          alert('File renewed successfully!')
  
          // Refresh expiry time from server
          const updated = await getFileExpiry(client, uhrpUrl)
          const expires = updated?.expiresInMs
          if (typeof expires === 'number' && expires > 0) {
            const hrs = Math.floor(expires / 3600000)
            const mins = Math.floor((expires % 3600000) / 60000)
  
            setFileExpirations(prev => ({
              ...prev,
              [uhrpUrl]: {
                text: `${hrs}h ${mins}m remaining`,
                expiryTime: Date.now() + expires
              }
            }))
          }
        } else {
          alert('⚠️ File renewal failed.')
        }
      } catch (err) {
        console.error('[ThreadPanel] Renew failed:', err)
        alert('❌ Error renewing file.')
      } finally {
        setRenewingFile(null)
      }
    }

  // ============================= KEYBOARD SHORTCUT =============================
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !sending) {
      e.preventDefault()
      handleSend()
    }
  }

  // ============================= RENDER =============================
  return (
    <Box
      display="flex"
      flexDirection="column"
      height="100%"
      width="100%"
      sx={{
        backgroundColor: 'background.default',
        color: 'text.primary'
      }}
    >
      {/* Header */}
      <Box
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        px={2}
        py={1.5}
        sx={{
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          backgroundColor: 'background.paper'
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
          Reply Thread
        </Typography>
        <Button onClick={onClose} size="small" color="inherit">
          Close
        </Button>
      </Box>

      {/* Main message area */}
      <Box display="flex" flexDirection="column" flex={1} overflow="auto" p={2}>
        {threadName && (
          <Box my={2} display="flex" justifyContent="center">
            <Paper
              elevation={3}
              sx={{
                px: 2,
                py: 1,
                borderRadius: '16px',
                background: (theme) => theme.palette.primary.main,
                color: 'white',
                fontWeight: 'bold'
              }}
            >
              {threadName}
            </Paper>
          </Box>
        )}

        {loading ? (
          <Typography align="center" color="text.secondary">
            Loading messages...
          </Typography>
        ) : (
          <>
            {/* --- Original parent message shown at top --- */}
            {(() => {
              const parentNormalized = normalizeSender(parentMessage.sender as string)
              const parentDisplaySender =
                nameMap.get(parentNormalized) ??
                (parentMessage.sender === senderPublicKey
                  ? 'You'
                  : parentNormalized.slice(0, 10) + '...'
                )

              return (
                <Box
                  sx={{
                    p: 1,
                    mb: 2,
                    borderRadius: 2,
                    backgroundColor: 'rgba(255,255,255,0.05)',
                    color: 'white'
                  }}
                >
                  <Typography variant="subtitle2" color="text.secondary">
                    Original Message
                  </Typography>

                  {(() => {
                    let parsed: any
                    try {
                      parsed = JSON.parse(parentMessage.content)
                    } catch {
                      parsed = null
                    }

                    if (parsed && parsed.type === 'bundle') {
                      return (
                        <>
                          {parsed.text && (
                            <Typography
                              variant="body1"
                              sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}
                            >
                              {parsed.text}
                            </Typography>
                          )}

                          {parsed.files?.length > 0 && (
                            <Box
                              sx={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 1,
                                mt: 1
                              }}
                            >
                              {parsed.files.map((f: any, i: number) => {
                                const preview = imagePreviews[f.handle]
                                const isImage = f.mimetype?.startsWith('image/')
                                return (
                                  <Box
                                    key={i}
                                    sx={{
                                      p: 1,
                                      borderRadius: '8px',
                                      backgroundColor: 'rgba(255,255,255,0.08)',
                                      display: 'flex',
                                      flexDirection: 'column',
                                      alignItems: 'center',
                                      width: '160px'
                                    }}
                                  >
                                    <Typography
                                      variant="body2"
                                      sx={{ color: '#ccc', mb: 0.5, textAlign: 'center' }}
                                    >
                                      📎 {f.filename}
                                    </Typography>

                                    {preview && isImage ? (
                                      <img
                                        src={preview}
                                        alt={f.filename}
                                        style={{
                                          maxWidth: '140px',
                                          maxHeight: '120px',
                                          borderRadius: '6px',
                                          objectFit: 'cover',
                                          cursor: 'pointer'
                                        }}
                                        onClick={() =>
                                          setOpenGallery({
                                            images: parsed.files
                                              .filter((file: any) =>
                                                file.mimetype?.startsWith('image/')
                                              )
                                              .map((file: any) => ({
                                                url: imagePreviews[file.handle],
                                                filename: file.filename
                                              }))
                                              .filter((img: any) => img.url),
                                            index: i
                                          })
                                        }
                                      />
                                    ) : (
                                      <Typography color="text.secondary" fontSize="0.8rem">
                                        (Loading preview)
                                      </Typography>
                                    )}

                                    {imagePreviews[f.handle] !== 'EXPIRED' && (
                                      <Button
                                        size="small"
                                        variant="outlined"
                                        sx={{ mt: 1 }}
                                        onClick={() =>
                                          handleFileDownload(
                                            f.handle,
                                            f.header,
                                            f.filename,
                                            f.mimetype
                                          )
                                        }
                                      >
                                        Download
                                      </Button>
                                    )}
                                    {fileExpirations[f.handle]?.text && (
                                      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                                        ⏳ {fileExpirations[f.handle].text}
                                      </Typography>
                                    )}
                                    <Button
                                      size="small"
                                      variant="text"
                                      color="secondary"
                                      sx={{ mt: 0.3, minWidth: 80 }}
                                      onClick={() => handleRenewFile(f.handle)}
                                      disabled={renewingFile === f.handle}
                                    >
                                      {renewingFile === f.handle ? (
                                        <CircularProgress size={14} color="secondary" />
                                      ) : (
                                        'Renew'
                                      )}
                                    </Button>
                                  </Box>
                                )
                              })}
                            </Box>
                          )}
                        </>
                      )
                    } else if (parsed && parsed.type === 'file') {
                      const preview = imagePreviews[parsed.handle]
                      const isImage = parsed.mimetype?.startsWith('image/')
                      return (
                        <>
                          <Typography variant="body2" sx={{ mt: 0.5 }}>
                            📎 {parsed.filename}
                          </Typography>
                          {isImage && preview && (
                            <img
                              src={preview}
                              alt={parsed.filename}
                              style={{
                                maxWidth: '240px',
                                borderRadius: '8px',
                                marginTop: '8px',
                                cursor: 'pointer'
                              }}
                              onClick={() =>
                                setOpenGallery({
                                  images: [{ url: preview, filename: parsed.filename }],
                                  index: 0
                                })
                              }
                            />
                          )}
                          {parsed.mimetype === 'application/pdf' && preview && (
                            <Box mt={1}>
                              <embed
                                src={preview}
                                type="application/pdf"
                                width="240px"
                                height="240px"
                              />
                            </Box>
                          )}
                          {preview === 'EXPIRED' && (
                            <Typography color="error">File no longer hosted.</Typography>
                          )}
                          <Button
                            size="small"
                            variant="outlined"
                            sx={{ mt: 1 }}
                            onClick={() =>
                              handleFileDownload(
                                parsed.handle,
                                parsed.header,
                                parsed.filename,
                                parsed.mimetype
                              )
                            }
                          >
                            Download
                          </Button>
                          {fileExpirations[parsed.handle]?.text && (
                            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                              ⏳ {fileExpirations[parsed.handle].text}
                            </Typography>
                          )}
                          <Button
                            size="small"
                            variant="text"
                            color="secondary"
                            sx={{ mt: 0.3, minWidth: 80 }}
                            onClick={() => handleRenewFile(parsed.handle)}
                            disabled={renewingFile === parsed.handle}
                          >
                            {renewingFile === parsed.handle ? (
                              <CircularProgress size={14} color="secondary" />
                            ) : (
                              'Renew'
                            )}
                          </Button>

                        </>
                      )
                    } else {
                      return (
                        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}>
                          {parentMessage.content}
                        </Typography>
                      )
                    }
                  })()}

                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.5 }}
                  >
                    {new Date(parentMessage.createdAt).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true
                    })}{' '}
                    — {parentDisplaySender}
                  </Typography>
                </Box>
              )

            })()}

            {/* --- Replies list --- */}
            {messages.length === 0 ? (
              <Typography align="center" color="text.secondary">
                No replies yet
              </Typography>
            ) : (
              messages.map((msg) => {
                const normalized = normalizeSender(msg.sender as string)
                const displaySender =
                  nameMap.get(normalized) || normalized.slice(0, 10) + '...'
                const isOwn = msg.sender === senderPublicKey

                let parsed: any
                try {
                  parsed = JSON.parse(msg.content)
                } catch {
                  parsed = null
                }

                return (
                  <Box
                    key={`${msg.txid}-${msg.vout}`}
                    sx={{
                      p: 1,
                      mb: 1,
                      borderRadius: 2,
                      width: { xs: '100%', sm: '75%' },
                      ml: { xs: 0, sm: isOwn ? 'auto' : 0 },
                      backgroundColor: 'black',
                      color: 'white'
                    }}
                  >
                    {/* File / Text Content */}
                    {parsed && parsed.type === 'bundle' ? (
                      <>
                        {/* Text content */}
                        {parsed.text && (
                          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
                            {parsed.text}
                          </Typography>
                        )}
                    
                        {/* Image/file previews */}
                        {parsed.files?.length > 0 && (
                          <Box
                            sx={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: 1,
                              alignItems: 'flex-start'
                            }}
                          >
                            {parsed.files.map((f: any, i: number) => {
                              const preview = imagePreviews[f.handle]
                    
                              // --- File container
                              return (
                                <Box
                                  key={i}
                                  sx={{
                                    p: 1,
                                    borderRadius: '8px',
                                    backgroundColor: 'rgba(255,255,255,0.05)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    maxWidth: '160px'
                                  }}
                                >
                                  <Typography
                                    variant="body2"
                                    sx={{ color: '#ccc', mb: 0.5, textAlign: 'center' }}
                                  >
                                    📎 {f.filename}
                                  </Typography>
                    
                                  {/* Image preview */}
                                  {preview && f.mimetype.startsWith('image/') ? (
                                    <img
                                      src={preview}
                                      alt={f.filename}
                                      style={{
                                        maxWidth: '140px',
                                        maxHeight: '120px',
                                        borderRadius: '6px',
                                        objectFit: 'cover',
                                        cursor: 'pointer',
                                        transition: 'transform 0.2s ease'
                                      }}
                                      onClick={() => {
                                        // Gather all image files in this message bundle for navigation
                                        const imagesInMessage =
                                          parsed?.type === 'bundle'
                                            ? parsed.files
                                                .filter((f: any) => f.mimetype.startsWith('image/') && imagePreviews[f.handle])
                                                .map((f: any) => ({
                                                  url: imagePreviews[f.handle],
                                                  filename: f.filename
                                                }))
                                            : parsed?.type === 'file' && parsed.mimetype.startsWith('image/')
                                            ? [{ url: imagePreviews[parsed.handle], filename: parsed.filename }]
                                            : []

                                        const currentIndex =
                                          imagesInMessage.findIndex((img: any) => img.url === imagePreviews[f.handle]) ?? 0

                                        setOpenGallery({ images: imagesInMessage, index: currentIndex })
                                      }}
                                      onMouseOver={(e) => {       
                                        e.currentTarget.style.transform = 'scale(1.02)'
                                      }}
                                      onMouseOut={(e) => {
                                        e.currentTarget.style.transform = 'scale(1.0)'
                                      }}
                                    />
                                  ) : (
                                    <Typography color="text.secondary" fontSize="0.8rem">
                                      (Loading preview)
                                    </Typography>
                                  )}
                    
                                  {/* Download button */}
                                  {imagePreviews[f.handle] !== 'EXPIRED' && (
                                    <Button
                                      size="small"
                                      variant="outlined"
                                      sx={{ mt: 0.5 }}
                                      onClick={() =>
                                        handleFileDownload(f.handle, f.header, f.filename, f.mimetype)
                                      }
                                      disabled={downloadingFile === f.handle}
                                    >
                                      {downloadingFile === f.handle ? 'Downloading…' : 'Download'}
                                    </Button>
                                  )}
                                  {fileExpirations[f.handle]?.text && (
                                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                                      ⏳ {fileExpirations[f.handle].text}
                                    </Typography>
                                  )}
                                  <Button
                                    size="small"
                                    variant="text"
                                    color="secondary"
                                    sx={{ mt: 0.3, minWidth: 80 }}
                                    onClick={() => handleRenewFile(f.handle)}
                                    disabled={renewingFile === f.handle}
                                  >
                                    {renewingFile === f.handle ? (
                                      <CircularProgress size={14} color="secondary" />
                                    ) : (
                                      'Renew'
                                    )}
                                  </Button>
                                </Box>
                              )
                            })}
                          </Box>
                        )}
                      </>
                    ) : parsed && parsed.type === 'file' ? (
                      <>
                        <Typography variant="body2">📎 {parsed.filename}</Typography>
                        {(() => {
                          const preview = imagePreviews[parsed.handle]
                          if (preview === 'EXPIRED')
                            return (
                              <Typography color="error">File no longer hosted.</Typography>
                            )
                          if (parsed.mimetype.startsWith('image/') && preview)
                            return (
                              <img
                                src={preview}
                                alt={parsed.filename}
                                style={{
                                  maxWidth: '240px',
                                  borderRadius: '8px',
                                  marginTop: '8px',
                                  cursor: 'pointer',
                                  transition: 'transform 0.2s ease'
                                }}
                                onClick={() => {
                                  // Open single image in gallery format
                                  setOpenGallery({
                                    images: [{ url: preview, filename: parsed.filename }],
                                    index: 0
                                  })
                                }}
                                onMouseOver={(e) => {
                                  e.currentTarget.style.transform = 'scale(1.02)'
                                }}
                                onMouseOut={(e) => {
                                  e.currentTarget.style.transform = 'scale(1.0)'
                                }}
                              />
                            )
                          if (parsed.mimetype === 'application/pdf' && preview)
                            return (
                              <Box mt={1}>
                                <embed
                                  src={preview}
                                  type="application/pdf"
                                  width="240px"
                                  height="240px"
                                />
                              </Box>
                            )
                          if (
                            parsed.mimetype.startsWith('text/') &&
                            typeof preview === 'string'
                          )
                            return (
                              <Box
                                mt={1}
                                sx={{
                                  backgroundColor: 'rgba(255,255,255,0.05)',
                                  borderRadius: '8px',
                                  padding: '8px',
                                  fontFamily: 'monospace',
                                  whiteSpace: 'pre-wrap',
                                  maxHeight: '240px',
                                  overflowY: 'auto'
                                }}
                              >
                                {preview}
                              </Box>
                            )
                          if (preview === null)
                            return (
                              <Typography color="text.secondary">
                                Preview unavailable.
                              </Typography>
                            )
                          return (
                            <Box display="flex" alignItems="center" gap={1}>
                              <CircularProgress size={18} />
                              <Typography>Loading preview…</Typography>
                            </Box>
                          )
                        })()}
                        {imagePreviews[parsed.handle] !== 'EXPIRED' && (
                          <Button
                            size="small"
                            variant="outlined"
                            sx={{ mt: 1 }}
                            onClick={() =>
                              handleFileDownload(
                                parsed.handle,
                                parsed.header,
                                parsed.filename,
                                parsed.mimetype
                              )
                            }
                            disabled={downloadingFile === parsed.handle}
                          >
                            {downloadingFile === parsed.handle
                              ? 'Downloading…'
                              : 'Download'}
                          </Button>
                        )}
                        {fileExpirations[parsed.handle]?.text && (
                          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                            ⏳ {fileExpirations[parsed.handle].text}
                          </Typography>
                        )}
                        <Button
                          size="small"
                          variant="text"
                          color="secondary"
                          sx={{ mt: 0.3, minWidth: 80 }}
                          onClick={() => handleRenewFile(parsed.handle)}
                          disabled={renewingFile === parsed.handle}
                        >
                          {renewingFile === parsed.handle ? (
                            <CircularProgress size={14} color="secondary" />
                          ) : (
                            'Renew'
                          )}
                        </Button>
                      </>
                    ) : (
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                        {msg.content}
                      </Typography>
                    )}

                    {/* Reactions */}
                    {(() => {
                      const key = `${msg.txid}:${msg.vout}`
                      const msgReactions = reactions[key] || []
                      if (msgReactions.length === 0) return null
                      const reactionCounts = msgReactions.reduce<
                        Record<string, number>
                      >((acc, r) => {
                        acc[r.reaction] = (acc[r.reaction] || 0) + 1
                        return acc
                      }, {})
                      return (
                        <Box display="flex" gap={1} mt={1}>
                          {Object.entries(reactionCounts).map(([emoji, count]) => (
                            <Paper
                              key={emoji}
                              sx={{
                                px: 1,
                                py: 0.2,
                                borderRadius: '12px',
                                backgroundColor: 'rgba(255,255,255,0.1)',
                                color: 'white',
                                fontSize: '0.9rem'
                              }}
                            >
                              {emoji} {count > 1 && count}
                            </Paper>
                          ))}
                        </Box>
                      )
                    })()}

                    {/* Emoji react button */}
                    <IconButton
                      size="small"
                      onClick={(e) => handleOpenPicker(e, msg)}
                      disabled={reactingMsg === `${msg.txid}:${msg.vout}`}
                      sx={{
                        color: 'rgba(255,255,255,0.7)',
                        backgroundColor: 'rgba(255,255,255,0.08)',
                        borderRadius: '16px',
                        px: 1.2,
                        py: 0.4,
                        mt: 0.5,
                        '&:hover': { backgroundColor: 'rgba(255,255,255,0.15)', color: '#fff' },
                        transition: 'all 0.2s ease'
                      }}
                    >
                      {reactingMsg === `${msg.txid}:${msg.vout}` ? (
                        <CircularProgress size={16} color="inherit" />
                      ) : (
                        <AddReactionIcon fontSize="small" />
                      )}
                    </IconButton>

                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ mt: 0.5, textAlign: 'right' }}
                    >
                      {new Date(msg.createdAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                      })}{' '}
                      <br /> {displaySender}
                    </Typography>
                  </Box>
                )
              })
            )}
          </>
        )}
      </Box>

      {/* Upload status */}
      {uploading && (
        <Box textAlign="center" py={1}>
          <Typography color="text.secondary">Uploading file…</Typography>
        </Box>
      )}
      <div ref={chatEndRef} />

      {/* Input + actions */}
      {pendingFiles.length > 0 && (
        <Box
          sx={{
            mb: 1,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1,
            backgroundColor: 'rgba(255,255,255,0.05)',
            borderRadius: '12px',
            p: 1
          }}
        >
          {pendingFiles.map((file, i) => (
            <Box key={i} position="relative">
              <img
                src={URL.createObjectURL(file)}
                alt={`Preview ${i}`}
                style={{
                  maxHeight: '80px',
                  borderRadius: '8px'
                }}
              />
              <IconButton
                size="small"
                color="error"
                onClick={() =>
                  setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))
                }
                sx={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  backgroundColor: 'rgba(0,0,0,0.4)',
                  '&:hover': { backgroundColor: 'rgba(0,0,0,0.7)' }
                }}
              >
                ✕
              </IconButton>
            </Box>
          ))}
        </Box>
      )}

      <Box
        display="flex"
        gap={1}
        p={2}
        sx={{
          borderTop: '1px solid rgba(255,255,255,0.1)',
          backgroundColor: 'background.paper'
        }}
      >
        <TextField
          multiline
          minRows={1}
          maxRows={4}
          fullWidth
          placeholder={uploading ? 'Uploading file...' : 'Write a reply...'}
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={handleKeyPress}
          onPaste={(e) => {
            const items = e.clipboardData?.items
            if (!items) return

            for (const item of items) {
              if (item.type.startsWith('image/')) {
                e.preventDefault()
                const file = item.getAsFile()
                if (file) {
                  // ➤ Add pasted image(s) to pendingFiles state for preview & batch upload
                  setPendingFiles((prev) => [...prev, file])
                }
              }
            }
          }}
          slotProps={{
            input: {
              endAdornment: uploading ? (
                <CircularProgress size={18} sx={{ color: 'text.secondary', mr: 1 }} />
              ) : null
            }
          }}
        />

        <Button
          variant="contained"
          color="primary"
          disabled={!newMessage.trim() || sending}
          onClick={handleSend}
        >
          {sending ? 'Sending…' : 'Send'}
        </Button>
        <FileUpload onFileSelected={handleFileSelected} />
      </Box>

      {/* Emoji picker */}
      <Popover
        open={Boolean(emojiAnchor)}
        anchorEl={emojiAnchor}
        onClose={handleClosePicker}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <EmojiPicker onSelect={handleSelectEmoji} />
      </Popover>
      {/* Fullscreen Image Viewer */}
      <Dialog
        open={!!openImage}
        onClose={() => setOpenImage(null)}
        fullWidth
        maxWidth="xl"
        PaperProps={{
          sx: {
            backgroundColor: 'rgba(0,0,0,0.9)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            p: 0
          }
        }}
      >
        {openImage && (
          <Box sx={{ position: 'relative', width: '100%', textAlign: 'center' }}>
            <img
              src={openImage}
              alt={openImageFilename || ''}
              style={{
                maxWidth: '100%',
                maxHeight: '90vh',
                objectFit: 'contain'
              }}
            />
            <Typography
              variant="caption"
              sx={{
                color: 'white',
                position: 'absolute',
                bottom: 8,
                right: 16,
                opacity: 0.7
              }}
            >
              {openImageFilename}
            </Typography>
          </Box>
        )}
      </Dialog>

      {/* Fullscreen Image Gallery Viewer */}
      <Dialog
        open={!!openGallery}
        onClose={() => setOpenGallery(null)}
        fullWidth
        maxWidth="xl"
        PaperProps={{
          sx: {
            backgroundColor: 'rgba(0,0,0,0.95)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            p: 0,
            overflow: 'hidden'
          }
        }}
      >
        {openGallery && (
          <Box
            {...bindGallerySwipe()}
            sx={{
              width: '100%',
              height: '100%',
              position: 'relative',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              touchAction: 'pan-y' // allow horizontal swipes
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                setOpenGallery(prev =>
                  prev
                    ? { ...prev, index: (prev.index - 1 + prev.images.length) % prev.images.length }
                    : null
                )
              } else if (e.key === 'ArrowRight') {
                setOpenGallery(prev =>
                  prev ? { ...prev, index: (prev.index + 1) % prev.images.length } : null
                )
              }
            }}
            tabIndex={0}
          >
            {/* Image display */}
            <img
              src={openGallery.images[openGallery.index].url}
              alt={openGallery.images[openGallery.index].filename}
              style={{
                maxWidth: '100%',
                maxHeight: '90vh',
                objectFit: 'contain',
                borderRadius: '8px'
              }}
            />

            {/* Left/Right controls */}
            {openGallery.images.length > 1 && (
              <>
                <IconButton
                  onClick={() =>
                    setOpenGallery((prev) =>
                      prev
                        ? { ...prev, index: (prev.index - 1 + prev.images.length) % prev.images.length }
                        : null
                    )
                  }
                  sx={{
                    position: 'absolute',
                    left: 16,
                    color: 'white',
                    backgroundColor: 'rgba(0,0,0,0.4)',
                    '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' }
                  }}
                >
                  ◀
                </IconButton>
                <IconButton
                  onClick={() =>
                    setOpenGallery((prev) =>
                      prev ? { ...prev, index: (prev.index + 1) % prev.images.length } : null
                    )
                  }
                  sx={{
                    position: 'absolute',
                    right: 16,
                    color: 'white',
                    backgroundColor: 'rgba(0,0,0,0.4)',
                    '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' }
                  }}
                >
                  ▶
                </IconButton>
              </>
            )}

            {/* Filename */}
            <Typography
              variant="caption"
              sx={{
                position: 'absolute',
                bottom: 8,
                right: 16,
                color: 'white',
                opacity: 0.7
              }}
            >
              {openGallery.images[openGallery.index].filename}
            </Typography>
          </Box>
        )}
      </Dialog>

    </Box>
  )
}

export default ThreadPanel
