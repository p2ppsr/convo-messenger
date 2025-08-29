// frontend/src/components/Chat.tsx

import React, { useEffect, useRef, useState } from 'react'
import { loadMessages } from '../utils/loadMessages'
import { sendMessage } from '../utils/sendMessage'
import type { MessagePayloadWithMetadata } from '../types/types'
import type { WalletClient, WalletProtocol } from '@bsv/sdk'

interface ChatProps {
  threadId: string
  client: WalletClient
  protocolID: WalletProtocol
  keyID: string
  senderPublicKey: string // identity public key in hex
  recipientPublicKeys: string[] // identity public keys of other participants
}

export const Chat: React.FC<ChatProps> = ({
  threadId,
  client,
  protocolID,
  keyID,
  senderPublicKey,
  recipientPublicKeys
}) => {
  const [messages, setMessages] = useState<MessagePayloadWithMetadata[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const chatEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    const fetchMessages = async () => {
      setLoading(true)
      try {
        const loaded = await loadMessages({
          client,
          protocolID,
          keyID,
          topic: threadId
        })
        setMessages(loaded)
      } catch (err) {
        console.error('[Chat] Failed to load messages:', err)
      } finally {
        setLoading(false)
        scrollToBottom()
      }
    }

    fetchMessages()
  }, [threadId, client, protocolID, keyID])

  const handleSend = async () => {
    if (!newMessage.trim()) return

    try {
      await sendMessage({
        client,
        protocolID,
        keyID,
        threadId,
        senderPublicKey,
        recipients: recipientPublicKeys,
        content: newMessage.trim()
      })

      const loaded = await loadMessages({
        client,
        protocolID,
        keyID,
        topic: threadId
      })

      setMessages(loaded)
      setNewMessage('')
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to send message:', err)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex-1 overflow-y-auto space-y-2">
        {loading ? (
          <div className="text-center text-gray-400">Loading messages...</div>
        ) : messages.length === 0 ? (
          <div className="text-center text-gray-400">No messages yet</div>
        ) : (
          messages.map((msg) => (
            <div
              key={`${msg.txid}-${msg.vout}`}
              className={`p-2 rounded-lg max-w-[75%] ${
                msg.sender === senderPublicKey
                  ? 'bg-blue-500 text-white self-end ml-auto'
                  : 'bg-gray-200 text-black self-start mr-auto'
              }`}
            >
              <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
              <div className="text-xs text-right opacity-60 mt-1">
                {new Date(msg.createdAt).toLocaleTimeString()}
              </div>
            </div>
          ))
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="mt-4 flex gap-2">
        <textarea
          className="flex-1 p-2 border rounded resize-none min-h-[40px] max-h-[120px]"
          placeholder="Type a message..."
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={handleKeyPress}
        />
        <button
          className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
          onClick={handleSend}
          disabled={!newMessage.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}

export default Chat
