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
} from '@mui/material'
import FileUpload from './FileUpload'
import type { DisplayableIdentity, WalletClient, WalletProtocol } from '@bsv/sdk'
import type { MessagePayloadWithMetadata } from '../types/types'

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

  const [inviteOpen, setInviteOpen] = useState(false)
  const [pendingInvite, setPendingInvite] = useState<DisplayableIdentity | null>(null)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })

  useEffect(() => {
    let interval: NodeJS.Timeout

    const fetchMessages = async () => {
      try {
        const result = await loadMessages({ client, protocolID, keyID, topic: threadId })
        if (!('messages' in result) || !('nameMap' in result)) {
          throw new Error('[Chat] loadMessages returned unexpected structure')
        }
        const { messages: loadedMessages, nameMap: resolvedNames } = result

        // Update messages
        setMessages((prev) =>
          JSON.stringify(prev) !== JSON.stringify(loadedMessages) ? loadedMessages : prev
        )
        setNameMap(resolvedNames)

        // 🔑 Update currentRecipients from the last message
        if (loadedMessages.length > 0) {
          const latest = loadedMessages[loadedMessages.length - 1]
          if (latest.recipients && latest.recipients.length > 0) {
            setCurrentRecipients(latest.recipients)
            console.log('[Chat] Restored recipients from last message:', latest.recipients)
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

    interval = setInterval(fetchMessages, 5000) // poll every 5s

    return () => clearInterval(interval)

  }, [threadId, client, protocolID, keyID])

  const handleSend = async () => {
    if (!newMessage.trim()) return
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

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  /** Handle file upload */
  const handleFileSelected = async (file: File) => {
    console.log('[Chat] Current recipients:', currentRecipients)
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
    }
  }

  /** Handle file download */
  const handleFileDownload = async (
    handle: string,
    header: number[],
    filename: string,
    mimetype: string
  ) => {
    try {
      const blob = await downloadAndDecryptFile(
        client,
        protocolID,
        keyID,
        handle,   // pass raw handle
        header,
        mimetype
      )

      // Trigger browser download
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[Chat] Failed to download file:', err)
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
                  maxWidth: '75%',
                  ml: isOwn ? 'auto' : 0,
                  backgroundColor: 'black',
                  color: 'white',
                }}
              >
                {parsed && parsed.type === 'file' ? (
                  <>
                    <Typography variant="body2">📎 {parsed.filename}</Typography>
                    <Button
                      size="small"
                      variant="contained"
                      sx={{ mt: 1 }}
                      onClick={() =>
                        handleFileDownload(parsed.handle, parsed.header, parsed.filename, parsed.mimetype)
                      }
                    >
                      Download
                    </Button>
                  </>
                ) : (
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {msg.content}
                  </Typography>
                )}
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
        <Button variant="contained" color="primary" disabled={!newMessage.trim()} onClick={handleSend}>
          Send
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
    </Box>
  )
}

export default Chat
