import React, { useState, useEffect, useCallback, createContext } from 'react'
import { Box, Container, Typography, Tabs, Tab, Grid, Avatar, Stack, Button, AppBar, Toolbar, List, ListItem, ListItemText, ListItemAvatar, makeStyles } from '@mui/material'
import { AddCircleOutline } from '@mui/icons-material'
import useAsyncEffect from 'use-async-effect'
import checkForMetaNetClient from './utils/checkForMetaNetClient'
import { NoMncModal } from 'metanet-react-prompt'
import './App.scss'
import Chat, { ChatMessage } from './components/Chat'
import NewConversationDialog from './components/NewConversationDialog'
// import { Tokenator } from '@babbage/tokenator'
import pushdrop from 'pushdrop'
import { submitDirectTransaction, CreateActionResult, SubmitDirectTransaction, SubmitDirectTransactionOutput, getTransactionOutputs, createAction, discoverByIdentityKey } from '@babbage/sdk-ts'
import tokenator from './utils/tokenatorSingleton'
import checkMessages from './utils/checkMessages'
import getMyId from './utils/getMyId'
import { addChat, loadSettings } from './utils/loadSettings'
import { parseIdentity, TrustLookupResult } from 'identinator'
import { Img } from 'uhrp-react'

type PeerServMessage = {
  messageId: number
  body: CreateActionResult
  sender: string
  created_at: string
  updated_at: string
}

type ChatCollection = {
  id: string
  friendlyName: string
  avatarURL: string
  chat: React.JSX.Element
}

export const newMessagesContext = createContext<[Map<string, ChatMessage[]>, React.Dispatch<React.SetStateAction<Map<string, ChatMessage[]>>>] | undefined>(undefined)
export const chatIdListContext = createContext<[string[], React.Dispatch<React.SetStateAction<string[]>>] | undefined>(undefined)

// i think i want to have a prop in the chat child that activates when a new message is added
// che child sees the change and it checks from the basket and checks for the most recent messages since the last one
const App: React.FC = () => {

  const initialMap = new Map<string, ChatMessage[]>()
  const [tabIndex, setTabIndex] = useState<number>(0)
  const [isMncMissing, setIsMncMissing] = useState<boolean>(false)
  const [openNewConversationDialog, setOpenNewConversationDialog] = useState<boolean>(false)
  const [myId, setMyId] = useState<string>('')
  const [otherId, setOtherId] = useState<string>('')
  const [chats, setChats] = useState<ChatCollection[]>([])
  const [newMessages, setNewMessages] = useState<Map<string, ChatMessage[]>>(initialMap)
  const [chatIdList, setChatIdList] = useState<string[]>([])
  const [chatCollection, setChatCollection] = useState<ChatCollection[]>([])

  const loadMessages = async () => {
    // print messages added to local This PC basket
    const foundMessages = await getTransactionOutputs({
      basket: `mcc_${myId}`,
      limit: 500
    })
    console.log('foundMessages:', foundMessages)

    // decode and print all messages
    await Promise.all(foundMessages.map(async (message: any) => {
      const decodedMessage = await pushdrop.decode({
        script: message.outputScript,
        fieldFormat: 'utf8'
      })

      console.log('decodedMessage:', decodedMessage)
    }))

    // print messages added locally to Other PC basket 
    const otherMessages = await getTransactionOutputs({
      basket: `mcc_${otherId}`,
      limit: 500
    })
    console.log('otherMessages:', otherMessages)

    // decode and print all messages
    await Promise.all(otherMessages.map(async (message: any) => {
      const decodedMessage = await pushdrop.decode({
        script: message.outputScript,
        fieldFormat: 'utf8'
      })

      console.log('decodedMessage:', decodedMessage)
    }))
  }

  useAsyncEffect(async () => {
    // Get the user's MNC ID
    const my_id = await getMyId()

    const tempChatCollection: ChatCollection[] = await Promise.all(
      chatIdList.map(async (chatId, index) => {

        const personResults = await discoverByIdentityKey({
          identityKey: chatId,
          description: 'Getting info for MattChat'
        })
      
        const identity = parseIdentity(personResults[0] as TrustLookupResult)

        console.log(chatId, identity)
     
        const chatItem: ChatCollection = {
          id: chatId,
          friendlyName: identity.name,
          avatarURL: identity.avatarURL,
          chat: <Chat
            key={index}
            otherUserName={identity.name}
            otherUserId={chatId}
            myUserId={my_id}
          />
        }

        return chatItem
      })
    )

    console.log('tempChatCollection',tempChatCollection)

    setChatCollection(tempChatCollection)
  }, [chatIdList])

  useAsyncEffect(async () => {

    // Get the user's MNC ID
    const my_id = await getMyId()
    setMyId(my_id)

    // use to clear failed messages
    // const waitingMessages = await tokenator.listMessages({
    //   messageBox: `mci_${my_id}`
    // })
    // console.log('waitingMessages',waitingMessages)
    // // await tokenator.acknowledgeMessage({ messageIds: [
    // // ] })
    // if (waitingMessages.length != 0) {
    //   await tokenator.acknowledgeMessage({
    //     messageIds: waitingMessages.map((message: any) => message.messageId)
    //   })
    // }



    // set the other recipient depending on which machine this is
    const other_id = (my_id === '026568a7b81be8db1f2df6513f7b3c91860dde6019768a1a7bec4e2b99d0f94eba'
      ? '02a602f6f8b85aced3fe3ca588dd0328112b31ca6c01a09214d8691fce5d50222b'
      : '026568a7b81be8db1f2df6513f7b3c91860dde6019768a1a7bec4e2b99d0f94eba'
    )
    setOtherId(other_id)

    const chatList = await loadSettings()
    console.log('chatList:', chatList)
    setChatIdList(chatList)

    

    // Run a 1s interval for checking if MNC is running
    const mncCheck = setInterval(async () => {
      const hasMNC = await checkForMetaNetClient()
      if (hasMNC === 0) {
        setIsMncMissing(true) // Open modal if MNC is not found
      } else {
        setIsMncMissing(false) // Ensure modal is closed if MNC is found
      }
    }, 1000)

    // check for new messages at interval without queueing
    let isChecking = false
    const messageCheck = setInterval(async () => {
      if (!isChecking) {
        isChecking = true
        const result: Map<string, ChatMessage[]> = await checkMessages()
        console.log(result)

        // if any new messages come from unadded chatters, add their ID to the list
        chatIdList.forEach((chatId) => {
          if (!result.has(chatId)) {
            addChat(chatId)
            setChatIdList([...chatIdList, chatId])
          }
        })

        // TODO might overwrite unprocessed messages, work on this soon
        setNewMessages(result)
        isChecking = false
      }
    }, 3000)

    return () => {
      clearInterval(mncCheck)
      clearInterval(messageCheck)
    }
  }, [])

  return (
    <newMessagesContext.Provider value={[newMessages, setNewMessages]}>
    <chatIdListContext.Provider value={[chatIdList, setChatIdList]}>
    <Container sx={{ paddingTop: '2em' }}>

      <NoMncModal open={isMncMissing} onClose={() => setIsMncMissing(false)} />

      <NewConversationDialog open={openNewConversationDialog} close={() => setOpenNewConversationDialog(false)} />

      {/* <Typography>{newMessages.toString()}</Typography> */}

      <Grid container spacing={2}>
        
        <Grid item xs={8}>
          <Stack direction='row' spacing={3} sx={{ alignItems: 'center' }}>
            <Avatar 
              onClick={() => {loadMessages()}}
              alt='Mattchat logo'
              src='/mattchat1.png'
              sx={{ width: 50, height: 50 }} />
            <Typography variant='h3'>Mattchat</Typography>
          </Stack>
        </Grid>

        <Grid item xs={4} sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant='contained'
            onClick={() => setOpenNewConversationDialog(true)}
            endIcon={ <AddCircleOutline /> }
          >New Conversation</Button>
        </Grid>

        <Grid item xs={3}>
          <List>
            {chatCollection.map((chatItem, index) => 
              <ListItem key={index} onClick={() => setTabIndex(index)} sx={tabIndex === index ? {background: '#222222'} : null}>
                <ListItemAvatar>
                  <Img src={chatItem.avatarURL} width={'30px'} confederacyHost={'https://confederacy.babbage.systems'} />
                </ListItemAvatar>
                <ListItemText primary={chatItem.friendlyName} primaryTypographyProps={{style: {whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}}></ListItemText>
              </ListItem>
            )}
          </List>
        </Grid>

        <Grid item xs={9}>
          { chatCollection[tabIndex] && chatCollection[tabIndex].chat }
        </Grid>

      </Grid>
      
    </Container>
    </chatIdListContext.Provider>
    </newMessagesContext.Provider>
  )
}

export default App
