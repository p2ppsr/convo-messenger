import React, { ChangeEvent, FormEvent, useContext, useEffect, useState } from 'react'
import useAsyncEffect from 'use-async-effect'
import { Avatar, Button, List, ListItem, ListItemAvatar, ListItemText, Stack, styled, TextField } from '@mui/material'
import { AttachmentRounded, PropaneSharp, SendRounded } from '@mui/icons-material'
import pushdrop from 'pushdrop'
import { createAction, decrypt, getTransactionOutputs } from '@babbage/sdk-ts'
import sendMessage from '../utils/sendMessage'
import { newMessagesContext } from '../App'
import DecryptedImage from './DecryptedImage'

interface ChatProps {
  otherUserName: string
  otherUserId: string
  myUserId: string
}

export interface ChatMessage {
  text: string,
  authorId: string,
  image?: File | string,
  imageKey?: string
}

const VisuallyHiddenInput = styled('input')({
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  height: 1,
  overflow: 'hidden',
  position: 'absolute',
  bottom: 0,
  left: 0,
  whiteSpace: 'nowrap',
  width: 1,
})

const Chat: React.FC<ChatProps> = (props) => {

  const context = useContext(newMessagesContext)
  if (!context) {
    throw new Error('newMessagesContext must be used within a Provider')
  }
  
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [newMessages, setNewMessages] = context
  const [newMsg, setNewMsg] = useState<string>('')
  const [newImage, setNewImage] = useState<File | undefined>(undefined)

  useEffect(() => {
    if (newMessages.has(props.otherUserId)) {
      let tempMessages: Map<string, ChatMessage[]> = newMessages

      if (newMessages.get(props.otherUserId)) {
        setMessages([...messages, ...newMessages.get(props.otherUserId)!])
      }

      tempMessages.set(props.otherUserId, [])

      setNewMessages(tempMessages)
    }
  }, [newMessages])

  // load old chats on creation
  useAsyncEffect(async () => {
    console.log(props.otherUserId)
    // load chat outputs from the basket
    const oldMessageOutputs = await getTransactionOutputs({
      basket: `mcc_${props.otherUserId}`,
      limit: 500
    })

    // decode the loaded chat outputs
    const decodedOldMessageOutputs = await Promise.all(
      oldMessageOutputs.map(async (oldMessageOutput) => {
        try {
          return await pushdrop.decode({
            script: oldMessageOutput.outputScript,
            fieldFormat: 'utf8'
          })
        } catch (e) {
          console.error(e)
        }
      })
    )

    // decrypt the field
    const decryptedDecodedOldFieldZeroes = await Promise.all(
      decodedOldMessageOutputs.map(async (decodedOldMessageOutput) => {
        try {
          return await decrypt({
            ciphertext: decodedOldMessageOutput.fields[0],
            protocolID: [1, 'MattChatEncryption'],
            // handle legacy messages where the keyID was always 1 and not included in the output fields
            keyID: decodedOldMessageOutput.fields.length === 2 ? '1' : decodedOldMessageOutput.fields[2],
            counterparty: props.otherUserId,
            returnType: 'string'
          })
        } catch (e) {
          console.error('Unable to decrypt message: ', decodedOldMessageOutput)
        }
      })
    )

    // parse the field
    const oldMessages = decryptedDecodedOldFieldZeroes.map((decryptedDecodedOldFieldZero) => {
      
      let parsed

      try {
        parsed = JSON.parse(decryptedDecodedOldFieldZero as string)
      }
      catch (e) {
        console.error(e)
      }

      return parsed
    })

    // there are some older messages that aren't formatted the same way, filter those out.
    // TODO: this might break more than just filtering undefined if I further change the ChatMessage interface
    const oldFormattedMessages: ChatMessage[] = []
    oldMessages.forEach((oldMessage) => {
      if (oldMessage !== undefined) {
        oldFormattedMessages.push(oldMessage as ChatMessage)
      }
    })

    console.log('oldMessageOutputs',oldMessageOutputs)
    console.log('decodedOldMessageOutputs',decodedOldMessageOutputs)
    console.log('oldMessages',oldMessages)
    console.log('oldFormattedMessages',oldFormattedMessages)

    // for now, we need to reverse
    oldFormattedMessages.reverse()

    setMessages(oldFormattedMessages)
  }, [])

  const handleImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files

    if (selectedFiles && selectedFiles.length > 0) {
      const currentFile = selectedFiles[0]
      if (currentFile instanceof File) {
        setNewImage(currentFile)
      } else {
        console.error('Invalid file object', currentFile)
      }
    } else {
      setNewImage(undefined)
    }
  }

  const handleUploadAndSubmit = async () => {
    // send the message and file
    sendMessage(newMsg, props.otherUserId, newImage)

    // clear the message and file 
    setNewMsg('')
    setNewImage(undefined)

    // TODO WORK ON DISPLAYING image
    setMessages([...messages, { text: newMsg, authorId: props.myUserId, image: newImage}])
  }

  return (
    <>
      <Stack spacing={1}>

        <List sx={{ width: '100%', height: '100%' }} key={props.otherUserId}>

          {messages.map((message, index) => 
            <>
              <ListItem
                key={index}>
                {/* <ListItemAvatar>
                  <Img src={props.avatarURL} width={'30px'} confederacyHost={'https://confederacy.babbage.systems'} />
                </ListItemAvatar> */}
                <ListItemText primary={
                  message.authorId
                  ? (message.authorId === props.myUserId
                    ? 'Me'
                    : props.otherUserName)
                  : 'Unknown Author'
                  
                }
                secondary={
                  message.text
                }
                secondaryTypographyProps={
                  // necessary to preserve line breaks
                  {style: { whiteSpace: 'pre-wrap'}}
                }
                ></ListItemText>
              </ListItem>
              { 
                message.hasOwnProperty('image')
                && message.image
                && <DecryptedImage otherUserId={props.otherUserId} fileOrHash={message.image} imageKey={message.imageKey ? message.imageKey : '1'}/>
              }
            </>
          )}

        </List>

        <form id='messageForm' onSubmit={(e) => {
          e.preventDefault()
          handleUploadAndSubmit()
        }}>
          <Stack direction='row' spacing={1}>
            <TextField
              onKeyDown={(e) => {
                // ensure that shift + enter does not submit, but allows new line
                // only enter alone will allow a submission
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleUploadAndSubmit()
                }
              }}
              multiline
              sx={{width: '100%'}}
              value={newMsg}
              onChange={(e) => setNewMsg(e.target.value)}
            />

            <Button variant='contained' color='primary' type='submit'>
              <SendRounded />
            </Button>

            <Button
              variant='outlined'
              color='primary'
              component='label'
              role={undefined}
              style={{maxWidth: '72px'}}
            >
              { newImage ? <DecryptedImage otherUserId={props.otherUserId} fileOrHash={newImage} imageKey={'NO_KEY'}/> : <AttachmentRounded /> }
              <VisuallyHiddenInput
                type='file'
                onChange={(e) => handleImageChange(e)}
              />
            </Button>
          </Stack>
        </form>
         
      </Stack>
    </>
  )
}

export default Chat
