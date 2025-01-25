import pushdrop from 'pushdrop'
import { createAction, encrypt } from '@babbage/sdk-ts'
import tokenator from './tokenatorSingleton'
import getMyId from './getMyId'
import { ChatMessage } from '../components/Chat'
import { Random } from '@bsv/sdk'
import { Utils } from '@bsv/sdk'
import { publishFile } from 'nanostore-publisher'

interface TokenatorMessageData {
  messageBox: string
  body: any
}

export default async function sendMessage(msg: string, recipientId: string, img?: File) {

  const myId = await getMyId()

  let imgHash: string = 'NO_IMG'

  // generate random keyIDs (image key will be generated only if one is attached)
  const randomizedTextKey: string = Utils.toBase64(Random(64))
  let randomizedImageKey: string = 'NO_KEY'

  // handle an image if present
  if (img) {
    try {
      // generate a random key for the image
      randomizedImageKey = Utils.toBase64(Random(64))

      // make Uint8ArrayBuffer of the file
      const fileArrayBuffer: ArrayBuffer = await img.arrayBuffer()
      const fileUint8ArrayBuffer: Uint8Array = new Uint8Array(fileArrayBuffer)

      // encrypt the Uint8ArrayBuffer of the file
      const encryptedFileArrayBuffer = await encrypt({
        plaintext: fileUint8ArrayBuffer,
        protocolID: [1, 'MattChatEncryption'],
        keyID: randomizedImageKey,
        counterparty: recipientId,
        returnType: 'Uint8Array'
      })

      // turn the encrypted version of the file into a Blob
      const encryptedFile: File = new File([encryptedFileArrayBuffer], 'temp')

      // publish the file
      const uploadResult = await publishFile({
        config: {
          nanostoreURL: 'https://nanostore.babbage.systems'
        },
        file: encryptedFile,
        retentionPeriod: 180,
      })

      // set the hash
      imgHash = uploadResult.hash

    } catch (e) {
      console.error(e)
    }
  }

  // create the message
  const chatMessage: ChatMessage = {
    text: msg,
    authorId: myId,
    image: imgHash
  }

  console.log('imgUrl', imgHash)

  // stringify data
  const stringifiedChatMessage: string = JSON.stringify(chatMessage)

  // encrypt data
  const encryptedChatMessage = await encrypt({
    plaintext: stringifiedChatMessage,
    protocolID: [1, 'MattChatEncryption'],
    keyID: randomizedTextKey,
    counterparty: recipientId,
    returnType: 'string'
  })

  // sanity check type and value of fields
  console.log('field[0]', typeof(encryptedChatMessage), encryptedChatMessage)
  console.log('field[1]', typeof(myId), myId)
  console.log('field[2]', typeof(randomizedTextKey), randomizedTextKey)
  console.log('field[3]', typeof(imgHash), imgHash)
  console.log('field[4]', typeof(randomizedImageKey), randomizedImageKey)

  // create the output script
  const outputScript = await pushdrop.create({
    fields: [
      encryptedChatMessage, // [0]: encrypted message
      myId,                 // [1]: author id
      randomizedTextKey,    // [2]: key used in encrypt text message
      imgHash,              // [3]: image url
      randomizedImageKey    // [4]: key used to encrypt image
    ],
    protocolID: 'mattchatAlpha',
    keyID: '1'
  })

  // submit the transaction to the blockchain
  const token = await createAction({
    outputs: [{
      satoshis: 1,
      script: outputScript,
      basket: `mcc_${recipientId}`,
      customInstructions: ''
    }],
    description: 'Sending a MattChat message.'
  })

  console.log(token)

  // create the tokenator information
  const tokenatorMessageData: TokenatorMessageData = {
    messageBox: `mci_${recipientId}`,
    body: {
      transaction: {
        ...token,
        outputs: [{
          vout: 0,
          satoshis: 1,
          basket: `mcc_${recipientId}`,
          customInstructions: '',
          script: outputScript
        }]
      },
      amount: 1
    }
  }

  console.log('tokenatorMessageData', tokenatorMessageData)

  // send the message
  await tokenator.sendMessage({
    recipient: recipientId,
    messageBox: `mci_${recipientId}`,
    body: tokenatorMessageData
  })
}