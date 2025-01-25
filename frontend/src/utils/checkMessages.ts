import { decrypt, submitDirectTransaction } from "@babbage/sdk-ts"
import tokenator from './tokenatorSingleton'
import getMyId from "./getMyId"
import { ChatMessage } from "../components/Chat"
import pushdrop from 'pushdrop'

export default async function checkMessages(): Promise<Map<string, ChatMessage[]>> {

  // TODO investigate adding this at the top level, not allowed in es5
  const myId = await getMyId()

  let msgNotifications: Map<string, ChatMessage[]> = new Map()

  const messages = await tokenator.listMessages({
    messageBox: `mci_${myId}`
  })
    
  if (messages.length !== 0) {
    console.log('messages:\n', messages)

    let parsedMessageBodies = messages.map((x: any) => JSON.parse(x.body))

    console.log('parsedMessageBodies:\n', parsedMessageBodies)

    const decodedMessageOutputs = await Promise.all(
      parsedMessageBodies.map(async (parsedMessageBody: any) => {
        console.log('currently processing parsedMessageBody', parsedMessageBody)
        console.log('parsedMessageBody.body.transaction.outputs[0].script',parsedMessageBody.body.transaction.outputs[0].script)
        try {
          return await pushdrop.decode({
            script: parsedMessageBody.body.transaction.outputs[0].script,
            fieldFormat: 'utf8'
          })
        } catch (e) {
          console.error('Unable to decode the parsed message body: ', e, parsedMessageBody)
        }
      }))

    console.log('decodedMessageOutputs', decodedMessageOutputs)

    // decrypt
    const decryptedDecodedMessageOutputs = await Promise.all(
      decodedMessageOutputs.map(async (decodedMessageOutput, index) => {
        try {
          console.log(decodedMessageOutput.fields[1] === myId ? messages[index].sender : myId)
          
          return await decrypt({
            ciphertext: decodedMessageOutput.fields[0],
            protocolID: [1, 'MattChatEncryption'],
            // handle legacy messages where the keyID was always 1 and not included in the output fields
            keyID: decodedMessageOutput.fields.length === 2 ? '1' : decodedMessageOutput.fields[2],
            counterparty: messages[index].sender,
            returnType: 'string'
          })
        } catch (e) {
          console.error('Unable to decrypt decoded message output ', e, decodedMessageOutput)
        }
    }))
    console.log('decryptedDecodedMessageOutputs', decryptedDecodedMessageOutputs)

    const parsedFieldZeroes = decryptedDecodedMessageOutputs.map((decryptedDecodedMessageOutput) => {
      try {
        return JSON.parse(decryptedDecodedMessageOutput as string)
      } catch (e) {
        console.error('parsing fields did not work', decryptedDecodedMessageOutput)
      }
    })
    console.log('parsedFieldZeroes', parsedFieldZeroes)

    const messagesProcessed = []
    const tokensReceived = []

    let i = 0
    for (const message of messages) {

      console.log('Current Message:\n', i, message)

      console.log('parsedFieldZeroes[i]',parsedFieldZeroes[i])

      // Add to notification list
      const chatId = message.sender
      const msg = parsedFieldZeroes[i].text
      const author = parsedFieldZeroes[i].authorId
      const imageHash = parsedFieldZeroes[i].hasOwnProperty('image') ? parsedFieldZeroes[i].image : ''
      const imgKey = decodedMessageOutputs[i].fields[4]

      // TODO investigate using a weak map instead, trying get and seeing if it fails instead of checking has, decide if need to track multiple outputs with output index
      if (msgNotifications.has(chatId)) {
        msgNotifications.get(chatId)!.push({
          text: msg,
          authorId: author,
          image: imageHash,
          imageKey: imgKey
        })
      } else {
        msgNotifications.set(chatId, [{
          text: msg,
          authorId: author,
          image: imageHash,
          imageKey: imgKey
        }])
      }

      // change the basket to match the chat from this user's perspective
      parsedMessageBodies[i].body.transaction.outputs = parsedMessageBodies[i].body.transaction.outputs.map((x: any) => {
        return {
          ...x,
          basket: `mcc_${message.sender}`
        }
      })

      console.log(parsedMessageBodies[i].body.transaction.outputs)

      try {
        const result = await submitDirectTransaction({
          senderIdentityKey: message.sender,
          note: 'New MattChat Message',
          amount: 1,
          transaction: parsedMessageBodies[i].body.transaction
        })

        tokensReceived.push(result)
        messagesProcessed.push(message.messageId)
      } catch (e) {
        console.error(e)
      }

      i++
    }

    if (messagesProcessed.length > 0) {
      await tokenator.acknowledgeMessage({ messageIds: messagesProcessed })
    }

    console.log('tokensReceived:\n', tokensReceived)

  }

  return msgNotifications
}
