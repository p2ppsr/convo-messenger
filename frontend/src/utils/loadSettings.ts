import { createAction, CreateActionInput, CreateActionOutputToRedeem, CreateActionResult, GetTransactionOutputResult, getTransactionOutputs } from "@babbage/sdk-ts"
import pushdrop from 'pushdrop'
import getMyId from './getMyId'

// TODO: split or rename this file, maybe pull finding unspent token out

let activeTxid: string | undefined = undefined
let activeOutputIndex: number | undefined = undefined

async function retrieveSettingsTokens(): Promise<GetTransactionOutputResult[]> {

  const myId = await getMyId()

  // Look for unspent settings tokens
  const foundSettingsTokens: GetTransactionOutputResult[] = await getTransactionOutputs({
    basket: `mcs_${myId}`,
    spendable: true,
    includeEnvelope: true
  })
  console.log('foundSettingsTokens:', foundSettingsTokens)

  return foundSettingsTokens

} 

// make a first time settings token that only includes the user's self
async function firstTimeSetup() {

  // get the user's id and start the list of individual chat ids, including only the user for now
  const myId = await getMyId()
  const individualIds: string[] = [myId]

  // create the output script
  const outputScript = await pushdrop.create({
    fields: [
      Buffer.from(JSON.stringify(individualIds))
    ],
    protocolID: 'mattchatAlphaSettings',
    keyID: '1'
  })

  // create a transaction from the output script
  const token: CreateActionResult = await createAction({
    outputs: [{
      satoshis: 1,
      script: outputScript,
      basket: `mcs_${myId}`,
      customInstructions: ''
    }],
    description: 'Initial MattChat Settings Token'
  })

  // under the current system, we are assuming it will be output 0, but will likely be randomized in the future
  // save the info
  activeTxid = token.txid
  activeOutputIndex = 0

  console.log('first time settings script:', outputScript)
  console.log('first time settings token:', token)
}

export async function loadSettings(): Promise<string[]> {

  /*
  when asked to load settings:
  
  // add all the others to a create action that redeems them.
  */

  // Get the user's MNC ID
  const myId = await getMyId()

  // find all unspent outputs in that basket
  let foundSettingsOutputs: GetTransactionOutputResult[] = await retrieveSettingsTokens()

  // if none, firstTimeSetup(), save txid and vout, return [myId]
  // TODO ask if we're okay with having multiple return statements or if they want to avoid it
  if (foundSettingsOutputs.length === 0) {
    await firstTimeSetup()
    return [myId]
  }

  // decode all of the found outputs
  const decodedSettingsOutputs = await Promise.all(
    foundSettingsOutputs.map(async (settingsOutput) =>
      await pushdrop.decode({
        script: settingsOutput.outputScript,
        fieldFormat: 'utf8'
      })
    )
  )

  // parse all of their field[0]
  const decodedChatIdList: string[][] = decodedSettingsOutputs.map( (decodedSettingsOutput) =>
    JSON.parse(decodedSettingsOutput.fields[0])
  )

  // if only one, return its field[0], save txid and vout
  if (decodedSettingsOutputs.length === 1) {
    activeTxid = foundSettingsOutputs[0].txid
    activeOutputIndex = foundSettingsOutputs[0].vout
    return decodedChatIdList[0]
  }

  // if multiple found, this is the process overview
  // see which has the longest list
  // save its txid and vout
  // remove it from the foundSettingsOutputs array
  // purge all that remain in foundSettingsOutputs
  // return the longest field[0]

  // see which has the longest list
  let longestArrayLength = 0
  let longestArrayIndex = 0

  decodedChatIdList.forEach( (chatIdList, index) => {
    const currentLength = chatIdList.length

    if (currentLength > longestArrayLength) {
      longestArrayLength = currentLength
      longestArrayIndex = index
    }
  })

  // save its txid and vout
  activeTxid = foundSettingsOutputs[longestArrayIndex].txid
  activeOutputIndex = foundSettingsOutputs[longestArrayIndex].vout

  // remove it from the foundSettingsOutputs array
  foundSettingsOutputs.splice(longestArrayIndex, 1)

  // purge all that remain in foundSettingsOutputs
  // create their unlocking scripts
  const defunctSettingsOutputUnlockScripts = await Promise.all(

    foundSettingsOutputs.map(async (settingsOutput, index) => {

      console.log(settingsOutput.txid)
      console.log(settingsOutput.vout)
      console.log(settingsOutput.outputScript)
      console.log(settingsOutput.amount)

      return await pushdrop.redeem({
        protocolID: 'mattchatAlphaSettings',
        keyID: '1',
        prevTxId: settingsOutput.txid,
        outputIndex: settingsOutput.vout,
        lockingScript: settingsOutput.outputScript,
        outputAmount: settingsOutput.amount
      })
    })
  )

  console.log('defunctSettingsOutputUnlockScripts', defunctSettingsOutputUnlockScripts)

  // there could be a problem if multiple outputs come from the same transaction txid, but at the moment the system shouldn't create any of those
  let defunctSettingsRecords: Record<string, CreateActionInput> = {}

  foundSettingsOutputs.forEach( (settingsOutput, index) => {

    const outputToRedeem: CreateActionOutputToRedeem = {
      index: settingsOutput.vout,
      unlockingScript: defunctSettingsOutputUnlockScripts[index]
    }

    defunctSettingsRecords[settingsOutput.txid] = {
      ...settingsOutput.envelope,
      outputsToRedeem: [
        outputToRedeem
      ]
    }
  })

  console.log('defunctSettingsRecords', defunctSettingsRecords)

  // run the redeem action
  const defunctSettingsRedeemResults: CreateActionResult = await createAction({
    inputs: defunctSettingsRecords,
    description: 'Removing defunct MattChat settings outputs'
  })

  // return the longest field[0]
  return decodedChatIdList[longestArrayIndex]

}

//when adding a chat to the current list:
  // use the saved txid and vout to retrive the id list
  // add the chat to the list
  // create an output script that saves the updated list
  // create an input script that consumes the old list
  // create an action that redeems the old txid and vout and adds the new output script
export async function addChat(chatId: string) {

  const myId = await getMyId()

  // use the saved txid and vout to retrive the id list

  // find all unspent outputs in that basket
  const foundSettingsOutputs: GetTransactionOutputResult[] = await retrieveSettingsTokens()

  console.log('add asking for current', foundSettingsOutputs)

  if (foundSettingsOutputs.length !== 1) {
    throw(new Error(`When adding a chat, outputs found: ${foundSettingsOutputs.length}`))
  }

  // decode the found output
  const decodedSettingsOutput = await pushdrop.decode({
    script: foundSettingsOutputs[0].outputScript,
    fieldFormat: 'utf8'
  })

  // parse field[0]
  const decodedChatIdList: string[] = JSON.parse(decodedSettingsOutput.fields[0])

  console.log('add decodedChatIdList',decodedChatIdList)

  // add the chat to the list
  decodedChatIdList.push(chatId)

  console.log('pushed decodedChatIdList', decodedChatIdList)

  // create an output script that saves the updated list
  const newSettingsOutputScript = await pushdrop.create({
    fields: [
      Buffer.from(JSON.stringify(decodedChatIdList))
    ],
    protocolID: 'mattchatAlphaSettings',
    keyID: '1'
  })

  console.log('old foundSettingsOutputs[0]',foundSettingsOutputs[0])

  // create an input script that consumes the old list
  const defunctSettingsOutputUnlockScript = await pushdrop.redeem({
    protocolID: 'mattchatAlphaSettings',
    keyID: '1',
    prevTxId: foundSettingsOutputs[0].txid,
    outputIndex: foundSettingsOutputs[0].vout,
    lockingScript: foundSettingsOutputs[0].outputScript,
    outputAmount: foundSettingsOutputs[0].amount
  })

  // create an action that redeems the old txid and vout and adds the new output script
  const token: CreateActionResult = await createAction({
    inputs: {
      [foundSettingsOutputs[0].txid]: {
        ...foundSettingsOutputs[0].envelope,
        outputsToRedeem: [{
          index: foundSettingsOutputs[0].vout,
          unlockingScript: defunctSettingsOutputUnlockScript
        }]
      }
    },
    outputs: [{
      satoshis: 1,
      script: newSettingsOutputScript,
      basket: `mcs_${myId}`,
      customInstructions: ''
    }],
    description: 'Replacing MattChat Settings Token'
  })

  // under the current system, we are assuming it will be output 0, but will likely be randomized in the future
  // save the info
  activeTxid = token.txid
  activeOutputIndex = 0
}