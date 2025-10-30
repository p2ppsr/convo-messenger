import React, { useEffect, useRef, useState } from 'react'
import { loadMessages } from '../utils/loadMessages'
import { sendMessage } from '../utils/sendMessage'
import { uploadEncryptedFile, downloadAndDecryptFile, getFileExpiry, renewFileHosting } from '../utils/fileEncryptor'
import { IdentitySearchField } from '@bsv/identity-react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  TextField,
  Paper,
  CircularProgress,
  IconButton,
  Popover
} from '@mui/material'
import FileUpload from './FileUpload'
import type { DisplayableIdentity, WalletClient, WalletProtocol } from '@bsv/sdk'
import type { MessagePayloadWithMetadata } from '../types/types'
import { sendReaction } from '../utils/sendReaction'
import AddReactionIcon from '@mui/icons-material/AddReaction'
import ThreadPanel from './ThreadPanel'
import EmojiPicker from './EmojiPicker'
import { POLLING_ENABLED } from '../utils/constants'
import { motion, AnimatePresence } from 'framer-motion'
import { useIsMobile } from '../utils/useIsMobile'
import { useGesture } from '@use-gesture/react'
import { send } from 'process'

interface ChatProps {
  client: WalletClient
  protocolID: WalletProtocol
  keyID: string
  senderPublicKey: string
  threadId: string
  recipientPublicKeys: string[]
  threadName?: string
}

type PreviewEntry =
  | string
  | { type: 'audio'; audioUrl: string }
  | { type: 'video'; videoUrl: string }
  | null

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

function mergeMessages(
  prev: MessagePayloadWithMetadata[],
  incoming: MessagePayloadWithMetadata[]
) {
  const map = new Map(prev.map(msg => [msg.txid, msg]))

  // Add/replace incoming messages
  for (const msg of incoming) {
    map.set(msg.txid, msg)
  }

  return Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt)
}

export const Chat: React.FC<ChatProps> = ({
  client,
  protocolID,
  keyID,
  senderPublicKey,
  threadId,
  recipientPublicKeys,
  threadName
}) => {
  const [messages, setMessages] = useState<MessagePayloadWithMetadata[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map())
  const [currentRecipients, setCurrentRecipients] = useState<string[]>(recipientPublicKeys)
  const [reactions, setReactions] = useState<Record<string, { reaction: string; sender: string }[]>>({})
  const [emojiAnchor, setEmojiAnchor] = useState<null | HTMLElement>(null)
  const [targetMessage, setTargetMessage] = useState<MessagePayloadWithMetadata | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [pendingInvite, setPendingInvite] = useState<DisplayableIdentity | null>(null)
  const [uploading, setUploading] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null)
  const [imagePreviews, setImagePreviews] = useState<Record<string, PreviewEntry | null>>({})
  const [sending, setSending] = useState(false)
  const [selectedThread, setSelectedThread] = useState<MessagePayloadWithMetadata | null>(null)
  const [threadOpen, setThreadOpen] = useState(false)
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({})
  const [latestReplyTimes, setLatestReplyTimes] = useState<Record<string, number>>({})
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [openImage, setOpenImage] = useState<string | null>(null)
  const [openImageFilename, setOpenImageFilename] = useState<string | null>(null)
  const [reactingMsg, setReactingMsg] = useState<string | null>(null)
  const [fileExpirations, setFileExpirations] = useState<
  Record<string, { text: string; expiryTime: number }>
    >({})
  const [renewingFile, setRenewingFile] = useState<string | null>(null)
  const [openAudio, setOpenAudio] = useState<string | null>(null)
  const [sendingTxid, setSendingTxid] = useState<string | null>(null)
  const isSendingRef = useRef<boolean>(false)
  const messageListRef = useRef<HTMLDivElement | null>(null)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  const isMobile = useIsMobile()

  // === Audio Recording ===
  const [recordDialogOpen, setRecordDialogOpen] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const timerRef = useRef<number | null>(null)

  const scrollToBottomIfNearEnd = () => {
      const container = messageListRef.current
      if (!container) return

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight

      // Only auto-scroll if user is within 200px of the bottom
      if (distanceFromBottom < 200) {
        container.scrollTop = container.scrollHeight
      }
    }

  // Load messages (with batch reply counts)
  useEffect(() => {
    const fetchMessages = async () => {
      try {
        console.log('[Chat] Fetching messages for thread:', threadId)
        const result = await loadMessages({ client, protocolID, keyID, topic: threadId })
        if (!result || !('messages' in result)) throw new Error('Unexpected loadMessages result')

        const {
          messages: loadedMessages,
          reactions: loadedReactions,
          nameMap: resolvedNames,
          replyCounts: loadedReplyCounts,
          latestReplyTimes: loadedLatestReplyTimes
        } = result

        console.log('[Chat] Loaded replyCounts:', loadedReplyCounts)
        console.log('[Chat] Loaded latestReplyTimes:', loadedLatestReplyTimes)

        setMessages(prev => mergeMessages(prev, loadedMessages))
        setReactions(loadedReactions)
        setNameMap(resolvedNames)
        setReplyCounts(loadedReplyCounts || {})
        setLatestReplyTimes(loadedLatestReplyTimes || {})

        // Auto-restore recipients
        if (loadedMessages.length > 0) {
          const latest = loadedMessages[loadedMessages.length - 1]
          if (latest.recipients?.length) setCurrentRecipients(latest.recipients)
        }
      } catch (err) {
        console.error('[Chat] Failed to load messages:', err)
      } finally {
        setLoading(false)
        scrollToBottom()
      }
    }

    setLoading(true)
    fetchMessages()
    scrollToBottom()
  }, [threadId])

  useEffect(() => {
  let interval: NodeJS.Timeout | undefined

  const pollMessages = async () => {
    // Don't fetch if still sending
    if (isSendingRef.current) {
      console.log("[Chat] ⏳ Poll skip — message still sending")
      return
    }

    try {
      console.log("[Chat] Polling overlay for updates...")

      const result = await loadMessages({ client, protocolID, keyID, topic: threadId })
      if (!result || !("messages" in result)) throw new Error("Unexpected loadMessages result")

      const {
        messages: loadedMessages,
        reactions: loadedReactions,
        nameMap: resolvedNames,
        replyCounts: loadedReplyCounts,
        latestReplyTimes: loadedLatestReplyTimes
      } = result

      // ✅ Append-only update (no full rerender)
      setMessages(prev => mergeMessages(prev, loadedMessages))

      // ✅ update other metadata but keeps prev messages intact
      setReactions(loadedReactions)
      setNameMap(resolvedNames)
      setReplyCounts(loadedReplyCounts || {})
      setLatestReplyTimes(loadedLatestReplyTimes || {})

      // ✅ Only auto-restore recipients on newest messages (like before)
      if (loadedMessages.length > 0) {
        const last = loadedMessages[loadedMessages.length - 1]
        if (last?.recipients?.length) setCurrentRecipients(last.recipients)
      }

    } catch (err) {
      console.error("[Chat] Polling failed:", err)
    } finally {
      scrollToBottomIfNearEnd()   // ✅ only scroll if user is near bottom
    }
  }

  console.log("[Chat] ▶ Polling started")

  // First poll immediately
  pollMessages()

  // Start interval
  interval = setInterval(pollMessages, 5000)

  // Cleanup
  return () => {
    console.log("[Chat] ⏹ Polling stopped")
    clearInterval(interval)
  }

}, [threadId, client, protocolID, keyID])

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
              } else if (file.mimetype.startsWith('audio/')) {
                const audioUrl = URL.createObjectURL(blob)
                setImagePreviews(prev => ({ ...prev, [file.handle]: { type: 'audio', audioUrl } }))
              } else if (file.mimetype.startsWith('video/')) {
                const videoUrl = URL.createObjectURL(blob)
                setImagePreviews(prev => ({ ...prev, [file.handle]: { type: 'video', videoUrl } }))
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

  // Message send
  const handleSend = async () => {
    if ((!newMessage.trim() && pendingFiles.length === 0) || sending) return

    setSending(true)
    setSendingTxid("pending")
    isSendingRef.current = true

    try {
      const fileMessages = []
      for (const file of pendingFiles) {
        const f = await uploadEncryptedFile(
          client, protocolID, keyID, currentRecipients, file
        )
        fileMessages.push(f)
      }

      const payload = {
        type: "bundle",
        text: newMessage.trim(),
        files: fileMessages
      }

      const txid = await sendMessage({
        client,
        protocolID,
        keyID,
        threadId,
        senderPublicKey,
        recipients: currentRecipients,
        content: JSON.stringify(payload),
        threadName
      })
      console.log("[Chat] Message sent with txid:", txid)

      setNewMessage("")
      setPendingFiles([])
      setSending(false)
      setSendingTxid(null)
      isSendingRef.current = false

    } catch (err) {
      console.error("[Chat] Failed to send:", err)
      setSending(false)
      setSendingTxid(null)
      isSendingRef.current = false
    }
  }

  // Invite participant
  const handleConfirmInvite = async () => {
    if (!pendingInvite) return
    const newKey = pendingInvite.identityKey
    const updated = [...new Set([...currentRecipients, newKey])]
    try {
      const content = `🔔 Invited new participant: ${pendingInvite.name || newKey.slice(0, 12)}...`
      await sendMessage({
        client,
        protocolID,
        keyID,
        threadId,
        senderPublicKey,
        recipients: updated,
        content,
        threadName
      })
      setCurrentRecipients(updated)
      setMessages((prev) => [
        ...prev,
        { content, sender: senderPublicKey, createdAt: Date.now(), txid: 'temp', vout: 0, threadId }
      ])
      setPendingInvite(null)
      setInviteOpen(false)
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to invite new participant:', err)
    }
  }

  // Reactions
  const handleReact = async (msg: MessagePayloadWithMetadata, emoji: string) => {
    try {
      const key = `${msg.txid}:${msg.vout}`
      setReactingMsg(key)
      await sendReaction({
        client,
        senderPublicKey,
        threadId,
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
  const handleClosePicker = () => { setEmojiAnchor(null); setTargetMessage(null) }
  const handleSelectEmoji = async (emoji: string) => {
    handleClosePicker()
    if (targetMessage) await handleReact(targetMessage, emoji)
  }

  // Replies
  const handleOpenThread = (msg: MessagePayloadWithMetadata) => {
    setSelectedThread(msg)
    setThreadOpen(true)
  }
  const handleCloseThread = () => {
    setThreadOpen(false)
    setSelectedThread(null)
  }

  // File upload
  const handleFileSelected = async (file: File) => {
    setUploading(true)
    try {
      const { handle, header, filename, mimetype } = await uploadEncryptedFile(client, protocolID, keyID, currentRecipients, file)
      const fileMessage = JSON.stringify({ type: 'file', handle, header, filename, mimetype })

      setSendingTxid('pending')

      const txid = await sendMessage({
        client,
        protocolID,
        keyID,
        threadId,
        senderPublicKey,
        recipients: currentRecipients,
        content: fileMessage,
        threadName
      })
      console.log('[Chat] File message sent with txid:', txid)

      setUploading(false)
      setSendingTxid(null)
    } catch (err) {
      console.error('[Chat] Failed to upload file:', err)
    }
  }

  // File download
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

  // Start recording from microphone
  const handleStartRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      chunksRef.current = []

      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyserNode = context.createAnalyser()
      analyserNode.fftSize = 2048
      source.connect(analyserNode)
      setAudioContext(context)
      setAnalyser(analyserNode)

      // Draw waveform
      const drawWaveform = () => {
        if (!canvasRef.current || !analyserNode) return
        const canvas = canvasRef.current
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const bufferLength = analyserNode.fftSize
        const dataArray = new Uint8Array(bufferLength)
        analyserNode.getByteTimeDomainData(dataArray)

        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.lineWidth = 2
        ctx.strokeStyle = '#4caf50'
        ctx.beginPath()

        const sliceWidth = (canvas.width * 1.0) / bufferLength
        let x = 0
        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0
          const y = (v * canvas.height) / 2
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
          x += sliceWidth
        }
        ctx.lineTo(canvas.width, canvas.height / 2)
        ctx.stroke()

        if (isRecording) requestAnimationFrame(drawWaveform)
      }

      drawWaveform()

      // Capture data chunks
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        setRecordedBlob(blob)
        const url = URL.createObjectURL(blob)
        setRecordingUrl(url)
        setElapsed(0)
        if (context.state !== 'closed') context.close()
      }

      mediaRecorder.start()
      setIsRecording(true)
      setRecordedBlob(null)
      setRecordingUrl(null)

      // Start timer
      const startTime = Date.now()
      timerRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000))
      }, 500)
    } catch (err) {
      console.error('Microphone access denied or error:', err)
      alert('🎙️ Unable to access microphone.')
    }
  }

  // Stop recording
  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }

  // Upload recorded file as message
  const handleUploadRecording = async () => {
    if (!recordedBlob) return
    const file = new File([recordedBlob], 'voice-message.webm', { type: 'audio/webm' })
    setRecordDialogOpen(false)
    await handleFileSelected(file)
    setRecordedBlob(null)
    setRecordingUrl(null)
  }

  // Keyboard shortcut
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !sending) {
      e.preventDefault()
      handleSend()
    }
  }

  // ========================================= RENDER =========================================
  return (
    <Box display="flex" flexDirection="column" height="100%" p={2}>
      <Box flex={1} overflow="auto" mb={2}>
        {threadName && (
          <Box my={2} display="flex" justifyContent="center">
            <Paper elevation={3} sx={{
              px: 2, py: 1, borderRadius: '16px',
              background: (theme) => theme.palette.primary.main,
              color: 'white', fontWeight: 'bold'
            }}>
              {threadName}
            </Paper>
          </Box>
        )}

        {loading ? (
          <Typography align="center" color="text.secondary">Loading messages...</Typography>
        ) : messages.length === 0 ? (
          <Typography align="center" color="text.secondary">No messages yet</Typography>
        ) : (
          messages.map((msg) => {
            const normalized = normalizeSender(msg.sender as string)
            const displaySender = nameMap.get(normalized) || normalized.slice(0, 10) + '...'
            const isOwn = msg.sender === senderPublicKey

            let parsed: any
            try { parsed = JSON.parse(msg.content) } catch { parsed = null }

            return (
              <Box key={`${msg.txid}-${msg.vout}`} sx={{
                p: 1, mb: 1, borderRadius: 2,
                width: { xs: '100%', sm: '75%' },
                ml: { xs: 0, sm: isOwn ? 'auto' : 0 },
                backgroundColor: 'black', color: 'white'
              }}>
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
                                {typeof preview === 'string' && f.mimetype.startsWith('image/') ? (
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
                                                .filter((f: any) => f.mimetype.startsWith('image/') && typeof imagePreviews[f.handle] === 'string')
                                                .map((f: any) => ({
                                                  url: imagePreviews[f.handle] as string,
                                                  filename: f.filename
                                                }))
                                            : parsed?.type === 'file' && parsed.mimetype.startsWith('image/') && typeof imagePreviews[parsed.handle] === 'string'
                                            ? [{ url: imagePreviews[parsed.handle] as string, filename: parsed.filename }]
                                            : []

                                        const currentIndex =
                                          imagesInMessage.findIndex((img: any) => img.url === (imagePreviews[f.handle] as string)) ?? 0

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
                      if (preview === 'EXPIRED') return <Typography color="error">File no longer hosted.</Typography>
                      if (parsed.mimetype.startsWith('image/') && typeof preview === 'string')
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
                                images: [{ url: preview as string, filename: parsed.filename }],
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
                      if (parsed.mimetype === 'application/pdf' && typeof preview === 'string')
                        return <Box mt={1}><embed src={preview} type="application/pdf" width="240px" height="240px" /></Box>
                      if (parsed.mimetype.startsWith('text/') && typeof preview === 'string')
                        return <Box mt={1} sx={{
                          backgroundColor: 'rgba(255,255,255,0.05)',
                          borderRadius: '8px', padding: '8px',
                          fontFamily: 'monospace', whiteSpace: 'pre-wrap',
                          maxHeight: '240px', overflowY: 'auto'
                        }}>{preview}</Box>
                      if (parsed.mimetype.startsWith('audio/') && preview && typeof preview === 'object' && preview.type === 'audio')
                        return (
                          <Box
                            sx={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              backgroundColor: 'rgba(255,255,255,0.05)',
                              borderRadius: '8px',
                              width: '160px',
                              height: '120px',
                              cursor: 'pointer'
                            }}
                            onClick={() => setOpenAudio(preview.audioUrl)}
                          >
                            <Typography variant="h4">🎵</Typography>
                            <Typography variant="caption" color="text.secondary">Play Audio</Typography>
                          </Box>
                        )
                      if (preview === null)
                        return <Typography color="text.secondary">Preview unavailable.</Typography>
                      return <Box display="flex" alignItems="center" gap={1}><CircularProgress size={18} /><Typography>Loading preview…</Typography></Box>
                    })()}
                    {imagePreviews[parsed.handle] !== 'EXPIRED' && (
                      <Button size="small" variant="outlined" sx={{ mt: 1 }}
                        onClick={() => handleFileDownload(parsed.handle, parsed.header, parsed.filename, parsed.mimetype)}
                        disabled={downloadingFile === parsed.handle}>
                        {downloadingFile === parsed.handle ? 'Downloading…' : 'Download'}
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
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{msg.content}</Typography>
                )}

                {/* Reactions */}
                {(() => {
                  const key = `${msg.txid}:${msg.vout}`
                  const msgReactions = reactions[key] || []
                  if (msgReactions.length === 0) return null
                  const reactionCounts = msgReactions.reduce<Record<string, number>>((acc, r) => {
                    acc[r.reaction] = (acc[r.reaction] || 0) + 1
                    return acc
                  }, {})
                  return (
                    <Box display="flex" gap={1} mt={1}>
                      {Object.entries(reactionCounts).map(([emoji, count]) => (
                        <Paper key={emoji} sx={{
                          px: 1, py: 0.2, borderRadius: '12px',
                          backgroundColor: 'rgba(255,255,255,0.1)',
                          color: 'white', fontSize: '0.9rem'
                        }}>
                          {emoji} {count > 1 && count}
                        </Paper>
                      ))}
                    </Box>
                  )
                })()}

                {/* Reply button + count */}
                <Box display="flex" alignItems="center" justifyContent="space-between" mt={0.5}>
                  {(() => {
                    const count = replyCounts?.[msg.txid] ?? 0
                    const latest = latestReplyTimes?.[msg.txid]
                    const latestTime = latest
                      ? new Date(latest).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true
                        })
                      : ''

                    return (
                      <Button
                    size="small"
                    variant="text"
                    title={count > 0 ? `${count} replies` : 'Reply to this message'}
                    sx={{
                      color: 'rgba(255,255,255,0.6)',
                      textTransform: 'none',
                      '&:hover': { color: 'white', backgroundColor: 'rgba(255,255,255,0.1)' }
                    }}
                    onClick={() => handleOpenThread(msg)}
                  >
                    {count > 0 ? (
                      <>
                        <Typography
                          component="span"
                          sx={{ color: '#4caf50', fontWeight: 600, mr: 0.5 }}
                        >
                          {count} Replies
                        </Typography>
                        {latestTime && (
                          <Typography
                            component="span"
                            sx={{ color: 'rgba(255,255,255,0.6)' }}
                          >
                            — Last reply {latestTime}
                          </Typography>
                        )}
                      </>
                    ) : (
                      'Reply'
                    )}
                  </Button>
                    )
                  })()}
                </Box>

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

                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, textAlign: 'right' }}>
                  {new Date(msg.createdAt).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                  })} <br /> {displaySender}
                </Typography>
              </Box>
            )
          })
        )}

        {uploading && (
          <Box textAlign="center" py={1}><Typography color="text.secondary">Uploading file…</Typography></Box>
        )}
        <div ref={chatEndRef} />
      </Box>

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

      <Box display="flex" gap={1}>
        <TextField
          multiline
          minRows={1}
          maxRows={4}
          fullWidth
          placeholder={uploading ? 'Uploading file...' : 'Write a message...'}
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

        <Button variant="contained" color="primary" disabled={!newMessage.trim() || sending} onClick={handleSend}>
          {sending ? 'Sending...' : 'Send'}
        </Button>
        <Button variant="contained" color="secondary" onClick={() => setInviteOpen(true)}>
          Invite
        </Button>
        <Button
          variant="contained"
          color="secondary"
          onClick={() => setRecordDialogOpen(true)}
        >
          🎙️ Record
        </Button>
        <FileUpload onFileSelected={handleFileSelected} />
      </Box>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onClose={() => setInviteOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Invite New Participant</DialogTitle>
        <DialogContent>
          <IdentitySearchField appName="Convo" onIdentitySelected={(id) => setPendingInvite(id)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInviteOpen(false)}>Cancel</Button>
          <Button onClick={handleConfirmInvite} disabled={!pendingInvite} variant="contained">Invite</Button>
        </DialogActions>
      </Dialog>

      {/* Emoji picker */}
      <Popover open={Boolean(emojiAnchor)} anchorEl={emojiAnchor} onClose={handleClosePicker}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }} transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <EmojiPicker onSelect={handleSelectEmoji} />
      </Popover>

      {/* ====================== Reply Thread Panel ====================== */}
      <AnimatePresence>
        {selectedThread && threadOpen && (
          isMobile ? (
            // MOBILE: Full-screen view
            <motion.div
              key="mobile-reply"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100vw',
                height: '100vh',
                backgroundColor: 'var(--mui-palette-background-default)',
                zIndex: 1300,
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <ThreadPanel
                open={true}
                parentMessage={selectedThread}
                onClose={handleCloseThread}
                client={client}
                protocolID={protocolID}
                keyID={keyID}
                senderPublicKey={senderPublicKey}
                threadName={threadName}
                recipientPublicKeys={currentRecipients}
                nameMap={nameMap}
                setNameMap={setNameMap}
              />
            </motion.div>
          ) : (
            // DESKTOP: Slide-in side panel
            <motion.div
              key="desktop-reply"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.3 }}
              style={{
                position: 'fixed',
                top: 0,
                right: 0,
                height: '100vh',
                width: '40%',
                maxWidth: '600px',
                backgroundColor: 'var(--mui-palette-background-default)',
                boxShadow: '-4px 0 10px rgba(0,0,0,0.4)',
                display: 'flex',
                flexDirection: 'column',
                zIndex: 1200
              }}
            >
              <ThreadPanel
                open={true}
                parentMessage={selectedThread}
                onClose={handleCloseThread}
                client={client}
                protocolID={protocolID}
                keyID={keyID}
                senderPublicKey={senderPublicKey}
                threadName={threadName}
                recipientPublicKeys={currentRecipients}
                nameMap={nameMap}
                setNameMap={setNameMap}
              />
            </motion.div>
          )
        )}
      </AnimatePresence>
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

      {/* Audio Player Dialog */}
      <Dialog
        open={!!openAudio}
        onClose={() => setOpenAudio(null)}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          sx: {
            backgroundColor: 'rgba(0,0,0,0.9)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            p: 2
          }
        }}
      >
        {openAudio && (
          <>
            <Typography variant="h6" color="white" sx={{ mb: 1 }}>
              Audio Player
            </Typography>
            <audio controls autoPlay src={openAudio} style={{ width: '100%' }} />
          </>
        )}
      </Dialog>

      {/* ====================== Audio Recorder Dialog ====================== */}
      <Dialog
        open={recordDialogOpen}
        onClose={() => setRecordDialogOpen(false)}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          sx: {
            backgroundColor: 'rgba(0,0,0,0.9)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            p: 2
          }
        }}
      >
        <Typography variant="h6" color="white" sx={{ mb: 2 }}>
          Record Voice Message
        </Typography>

        {!recordedBlob ? (
          <>
            <canvas
              ref={canvasRef}
              width={400}
              height={100}
              style={{
                backgroundColor: 'black',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '8px',
                marginBottom: '12px'
              }}
            />
            <Typography color="white" sx={{ mb: 1 }}>
              {isRecording ? `Recording... (${elapsed}s)` : `Ready to record`}
            </Typography>

            {isRecording ? (
              <Button
                variant="contained"
                color="error"
                onClick={handleStopRecording}
              >
                Stop Recording
              </Button>
            ) : (
              <Button
                variant="contained"
                color="primary"
                onClick={handleStartRecording}
              >
                Start Recording
              </Button>
            )}
          </>
        ) : (
          <>
            <audio
              controls
              src={recordingUrl || ''}
              style={{ width: '100%', marginBottom: '12px' }}
            />
            <Box display="flex" gap={1}>
              <Button
                variant="outlined"
                color="error"
                onClick={() => {
                  setRecordedBlob(null)
                  setRecordingUrl(null)
                }}
              >
                Discard
              </Button>
              <Button
                variant="contained"
                color="primary"
                onClick={handleUploadRecording}
              >
                Upload
              </Button>
            </Box>
          </>
        )}
      </Dialog>

    </Box>
  )
}

export default Chat
