// src/components/Chat.tsx
import React, { useEffect, useRef, useState } from 'react'
import { loadMessages } from '../utils/loadMessages'
import { sendMessage } from '../utils/sendMessage'
import { uploadEncryptedFile, downloadAndDecryptFile } from '../utils/fileEncryptor'
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
  IconButton
} from '@mui/material'
import FileUpload from './FileUpload'
import type { DisplayableIdentity, WalletClient, WalletProtocol } from '@bsv/sdk'
import type { MessagePayloadWithMetadata } from '../types/types'
import { sendReaction } from '../utils/sendReaction'
import EmojiPicker from './EmojiPicker'
import { Popover } from '@mui/material'
import AddReactionIcon from '@mui/icons-material/AddReaction'

interface ChatProps {
  client: WalletClient
  protocolID: WalletProtocol
  keyID: string
  senderPublicKey: string
  threadId: string
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

export const Chat: React.FC<ChatProps> = ({
  client,
  protocolID,
  keyID,
  senderPublicKey,
  threadId,
  recipientPublicKeys,
  threadName,
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

  // Upload/download & preview state
  const [uploading, setUploading] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null)
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })

  // Load messages periodically
  useEffect(() => {
    let interval: NodeJS.Timeout

    const fetchMessages = async () => {
      try {
        const result = await loadMessages({ client, protocolID, keyID, topic: threadId })
        if (!('messages' in result) || !('nameMap' in result)) {
          throw new Error('[Chat] loadMessages returned unexpected structure')
        }
        const { messages: loadedMessages, reactions: loadedReactions, nameMap: resolvedNames } = result

        setMessages((prev) =>
          JSON.stringify(prev) !== JSON.stringify(loadedMessages) ? loadedMessages : prev
        )
        setReactions(loadedReactions)
        setNameMap(resolvedNames)

        // Restore recipients from last message
        if (loadedMessages.length > 0) {
          const latest = loadedMessages[loadedMessages.length - 1]
          if (latest.recipients && latest.recipients.length > 0) {
            setCurrentRecipients(latest.recipients)
          }
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
    interval = setInterval(fetchMessages, 5000)
    return () => clearInterval(interval)
  }, [threadId, client, protocolID, keyID])

  // Auto-decrypt file previews once messages are loaded
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

          if (parsed.mimetype.startsWith('image/')) {
            // 🔹 Existing image preview logic
            const url = URL.createObjectURL(blob)
            setImagePreviews((prev) => ({ ...prev, [parsed.handle]: url }))
          }

          else if (parsed.mimetype === 'application/pdf') {
            // 🔹 Generate PDF preview
            const url = URL.createObjectURL(blob)
            setImagePreviews((prev) => ({ ...prev, [parsed.handle]: url }))
          }

          else if (parsed.mimetype.startsWith('text/')) {
            // 🔹 Read first ~500 characters of text
            const text = await blob.text()
            const snippet = text.length > 500 ? text.slice(0, 500) + '…' : text
            setImagePreviews((prev) => ({ ...prev, [parsed.handle]: snippet }))
          }

          else {
            // 🔹 For unsupported file types, mark with null (so we know it exists but no preview)
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

  const handleSend = async () => {
    if (!newMessage.trim() || sending) return
    setSending(true)
    const content = newMessage.trim()
    try {
      await sendMessage({
        client,
        protocolID,
        keyID,
        threadId,
        senderPublicKey,
        recipients: currentRecipients,
        content,
        threadName,
      })
      setMessages((prev) => [
        ...prev,
        { content, sender: senderPublicKey, createdAt: Date.now(), txid: 'temp', vout: 0, threadId },
      ])
      setNewMessage('')
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }

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
        threadName,
      })
      setCurrentRecipients(updated)
      setMessages((prev) => [
        ...prev,
        { content, sender: senderPublicKey, createdAt: Date.now(), txid: 'temp', vout: 0, threadId },
      ])
      setPendingInvite(null)
      setInviteOpen(false)
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to invite new participant:', err)
    }
  }

  const handleReact = async (msg: MessagePayloadWithMetadata, emoji: string) => {
    try {
      await sendReaction({
        client,
        senderPublicKey,
        threadId,
        reaction: emoji,
        messageTxid: msg.txid,
        messageVout: msg.vout,
      })

      const key = `${msg.txid}:${msg.vout}`
      setReactions(prev => {
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
    if (targetMessage) {
      await handleReact(targetMessage, emoji)
    }
    handleClosePicker()
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !sending) {
      e.preventDefault()
      handleSend()
    }
  }

  /** Handle file upload */
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

      const fileMessage = JSON.stringify({
        type: 'file',
        handle,
        header,
        filename,
        mimetype,
      })

      await sendMessage({
        client,
        protocolID,
        keyID,
        threadId,
        senderPublicKey,
        recipients: currentRecipients,
        content: fileMessage,
        threadName,
      })

      setMessages((prev) => [
        ...prev,
        {
          content: fileMessage,
          sender: senderPublicKey,
          createdAt: Date.now(),
          txid: 'temp',
          vout: 0,
          threadId,
        },
      ])
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to upload file:', err)
    } finally {
      setUploading(false)
    }
  }

  /** Handle file download (manual save) */
  const handleFileDownload = async (
    handle: string,
    header: number[],
    filename: string,
    mimetype: string
  ) => {
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

    // Show an inline alert for expired/missing files
    let message = 'File could not be downloaded.'
    const errMsg = (err?.message || '').toLowerCase()

    if (errMsg.includes('no data returned') || errMsg.includes('404') || errMsg.includes('not found')) {
      message = '⚠️ This file is no longer hosted or has expired.'
    } else if (errMsg.includes('failed to fetch') || errMsg.includes('network')) {
      message = '⚠️ Unable to reach file host.'
    }

    // Use a simple alert for now, can be swapped for Snackbar later
    alert(message)
    } finally {
      setDownloadingFile(null)
    }
  }

  return (
    <Box display="flex" flexDirection="column" height="100%" p={2}>
      <Box flex={1} overflow="auto" mb={2}>
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
                fontWeight: 'bold',
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
        ) : messages.length === 0 ? (
          <Typography align="center" color="text.secondary">
            No messages yet
          </Typography>
        ) : (
          messages.map((msg) => {
            const normalized = normalizeSender(msg.sender as string)
            const displaySender = nameMap.get(normalized) || normalized.slice(0, 10) + '...'
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
                  width: {
                    xs: '100%', // full width on mobile
                    sm: '75%', // 75% on tablet/desktop
                  },
                  ml: {
                    xs: 0, // no margin on mobile
                    sm: isOwn ? 'auto' : 0, // right-align own messages on desktop
                  },
                  backgroundColor: 'black',
                  color: 'white',
                }}
              >
                {parsed && parsed.type === 'file' ? (
                  <>
                    <Typography variant="body2">📎 {parsed.filename}</Typography>

                    {(() => {
                      const preview = imagePreviews[parsed.handle]

                      if (preview === 'EXPIRED') {
                        return (
                          <Typography variant="body2" color="error" mt={1}>
                            File no longer hosted or expired.
                          </Typography>
                        )
                      }

                      if (parsed.mimetype.startsWith('image/') && preview) {
                        return (
                          <img
                            src={preview}
                            alt={parsed.filename}
                            style={{
                              maxWidth: '240px',
                              maxHeight: '240px',
                              borderRadius: '8px',
                              marginTop: '8px',
                              objectFit: 'cover',
                              display: 'block',
                            }}
                          />
                        )
                      }

                      if (parsed.mimetype === 'application/pdf' && preview) {
                        return (
                          <Box mt={1}>
                            <embed
                              src={preview}
                              type="application/pdf"
                              width="240px"
                              height="240px"
                              style={{ borderRadius: '8px', background: '#111' }}
                            />
                          </Box>
                        )
                      }

                      if (parsed.mimetype.startsWith('text/') && typeof preview === 'string') {
                        return (
                          <Box mt={1} sx={{
                            backgroundColor: 'rgba(255,255,255,0.05)',
                            borderRadius: '8px',
                            padding: '8px',
                            fontFamily: 'monospace',
                            whiteSpace: 'pre-wrap',
                            maxHeight: '240px',
                            overflowY: 'auto',
                          }}>
                            {preview}
                          </Box>
                        )
                      }

                      if (preview === null) {
                        return (
                          <Typography variant="body2" color="text.secondary" mt={1}>
                            Preview unavailable for this file type.
                          </Typography>
                        )
                      }

                      return (
                        <Box display="flex" alignItems="center" gap={1} mt={1}>
                          <CircularProgress size={18} color="inherit" />
                          <Typography variant="body2" color="text.secondary">
                            Loading preview…
                          </Typography>
                        </Box>
                      )
                    })()}

                    {/* Hide Download Button if expired */}
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

                {/* Reactions section */}
                {(() => {
                  const key = `${msg.txid}:${msg.vout}`
                  const msgReactions = reactions[key] || []
                  if (msgReactions.length === 0) return null

                  const reactionCounts = msgReactions.reduce<Record<string, number>>(
                    (acc, r) => {
                      acc[r.reaction] = (acc[r.reaction] || 0) + 1
                      return acc
                    },
                    {}
                  )

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
                            fontSize: '0.9rem',
                          }}
                        >
                          {emoji} {count > 1 && count}
                        </Paper>
                      ))}
                    </Box>
                  )
                })()}

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
                      color: '#fff',
                    },
                    transition: 'all 0.2s ease',
                  }}
                >
                  <AddReactionIcon fontSize="small" />
                </IconButton>

                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mt: 0.5, textAlign: 'right' }}
                >
                  {new Date(msg.createdAt).toLocaleTimeString()}
                  <br />
                  {displaySender}
                </Typography>
              </Box>
            )
          })
        )}

        {/* Uploading indicator */}
        {uploading && (
          <Box textAlign="center" py={1}>
            <Typography variant="body2" color="text.secondary">
              Uploading file…
            </Typography>
          </Box>
        )}

        <div ref={chatEndRef} />
      </Box>

      {/* Input + actions */}
      <Box display="flex" gap={1}>
        <TextField
          multiline
          minRows={1}
          maxRows={4}
          fullWidth
          placeholder="Type a message..."
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
          {sending ? 'Sending...' : 'Send'}
        </Button>
        <Button variant="contained" color="secondary" onClick={() => setInviteOpen(true)}>
          Invite
        </Button>
        <FileUpload onFileSelected={handleFileSelected} />
      </Box>

      <Dialog open={inviteOpen} onClose={() => setInviteOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Invite New Participant</DialogTitle>
        <DialogContent>
          <IdentitySearchField appName="Convo" onIdentitySelected={(id) => setPendingInvite(id)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInviteOpen(false)}>Cancel</Button>
          <Button onClick={handleConfirmInvite} disabled={!pendingInvite} variant="contained">
            Invite
          </Button>
        </DialogActions>
      </Dialog>

      {/* Emoji picker popover (shared by all messages) */}
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

export default Chat
