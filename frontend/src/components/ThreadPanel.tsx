import React, { useEffect, useRef, useState } from 'react'
import { loadReplies } from '../utils/loadReplies'
import { sendMessage } from '../utils/sendMessage'
import { uploadEncryptedFile, downloadAndDecryptFile } from '../utils/fileEncryptor'
import {
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
import type { WalletClient, WalletProtocol } from '@bsv/sdk'
import type { MessagePayloadWithMetadata } from '../types/types'
import { sendReaction } from '../utils/sendReaction'
import AddReactionIcon from '@mui/icons-material/AddReaction'
import EmojiPicker from './EmojiPicker'
import { POLLING_ENABLED } from '../utils/constants'

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
  const [uploading, setUploading] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null)
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)

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
        setNameMap(resolvedNames)

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

        if (parsed?.type !== 'file' || imagePreviews[parsed.handle]) continue

        try {
          const blob = await downloadAndDecryptFile(
            client,
            protocolID,
            keyID,
            parsed.handle,
            parsed.header,
            parsed.mimetype
          )

          if (parsed.mimetype.startsWith('image/') || parsed.mimetype === 'application/pdf') {
            const url = URL.createObjectURL(blob)
            setImagePreviews((prev) => ({ ...prev, [parsed.handle]: url }))
          } else if (parsed.mimetype.startsWith('text/')) {
            const text = await blob.text()
            const snippet = text.length > 500 ? text.slice(0, 500) + '…' : text
            setImagePreviews((prev) => ({ ...prev, [parsed.handle]: snippet }))
          } else {
            setImagePreviews((prev) => ({ ...prev, [parsed.handle]: null }))
          }
        } catch (err) {
          console.warn('[Chat] Failed to auto-load file preview:', err)
          setImagePreviews((prev) => ({ ...prev, [parsed.handle]: 'EXPIRED' }))
        }
      }
    }

    if (messages.length > 0) loadFilePreviews()
  }, [messages])

  // ============================= MESSAGE SEND =============================
  const handleSend = async () => {
    if (!newMessage.trim() || sending) return
    setSending(true)
    const content = newMessage.trim()

    try {
      await sendMessage({
        client,
        protocolID,
        keyID,
        threadId: parentMessage.threadId,
        senderPublicKey,
        recipients: currentRecipients,
        content,
        threadName,
        parentMessageId: parentMessage.txid
      })
      setMessages((prev) => [
        ...prev,
        {
          content,
          sender: senderPublicKey,
          createdAt: Date.now(),
          txid: 'temp',
          vout: 0,
          threadId: parentMessage.threadId
        }
      ])
      setNewMessage('')
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }

  // ============================= REACTIONS =============================
  const handleReact = async (msg: MessagePayloadWithMetadata, emoji: string) => {
    try {
      await sendReaction({
        client,
        senderPublicKey,
        threadId: parentMessage.threadId,
        reaction: emoji,
        messageTxid: msg.txid,
        messageVout: msg.vout
      })

      const key = `${msg.txid}:${msg.vout}`
      setReactions((prev) => {
        const existing = prev[key] || []
        const updated = [...existing, { reaction: emoji, sender: senderPublicKey }]
        return { ...prev, [key]: updated }
      })
    } catch (err) {
      console.error('[Chat] Failed to send reaction:', err)
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
    if (targetMessage) await handleReact(targetMessage, emoji)
    handleClosePicker()
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
                nameMap.get(parentNormalized) || parentNormalized.slice(0, 10) + '...'

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
                  <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}>
                    {parentMessage.content}
                  </Typography>
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
                    {parsed && parsed.type === 'file' ? (
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
                                  marginTop: '8px'
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
                      sx={{
                        color: 'rgba(255,255,255,0.7)',
                        backgroundColor: 'rgba(255,255,255,0.08)',
                        borderRadius: '16px',
                        px: 1.2,
                        py: 0.4,
                        mt: 0.5,
                        '&:hover': {
                          backgroundColor: 'rgba(255,255,255,0.15)',
                          color: '#fff'
                        },
                        transition: 'all 0.2s ease'
                      }}
                    >
                      <AddReactionIcon fontSize="small" />
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
          placeholder="Write a reply..."
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={handleKeyPress}
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
    </Box>
  )
}

export default ThreadPanel
