import { CompletedProtoWallet, PrivateKey, Random, Utils, SymmetricKey } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'
const host = 'https://messagebox.babbage.systems'
const deadline = setTimeout(() => { console.error('Live validation timed out'); process.exit(1) }, 60000)
const wallets = [new CompletedProtoWallet(PrivateKey.fromRandom()), new CompletedProtoWallet(PrivateKey.fromRandom())]
const recipient = (await wallets[1].getPublicKey({identityKey:true})).publicKey
const clients = wallets.map(walletClient=>new MessageBoxClient({walletClient,host,networkPreset:'mainnet'}))
const messageBox = 'convo-qa-' + Utils.toHex(Random(16))
const key = new SymmetricKey(Random(32))
const sent=[]
try {
 for(let i=0;i<3;i++) {
   const messageId=Utils.toHex(Random(32)); sent.push(messageId)
   await clients[0].sendMessage({recipient,messageBox,messageId,skipEncryption:true,body:{type:'convo-qa',ciphertext:Utils.toBase64(key.encrypt(Utils.toArray('Synthetic store-and-forward validation '+i,'utf8')))}},host)
 }
 const batch=await clients[1].listMessages({messageBox,host,limit:100,pageSize:100,maxPages:2,acceptPayments:false})
 if(batch.length!==3) throw new Error('Expected 3 test messages; got '+batch.length)
 await clients[1].acknowledgeMessage({messageIds:batch.map(m=>m.messageId),host})
 const empty=await clients[1].listMessages({messageBox,host,limit:100,pageSize:100,maxPages:2,acceptPayments:false})
 if(empty.length!==0) throw new Error('Acknowledged test mailbox is not empty')
 console.log(JSON.stringify({host,sent:3,received:batch.length,batchAcknowledged:3,remaining:empty.length,encrypted:true}))
} finally {
 if(sent.length) await clients[1].acknowledgeMessage({messageIds:sent,host}).catch(()=>{})
 clearTimeout(deadline)
}
