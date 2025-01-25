import { getPublicKey } from "@babbage/sdk-ts"

let myId: string = ''

export default async function getMyId(): Promise<string> {

  // check if we've saved the id already
  if (!myId) {

    // get the user's MNC ID
    myId = await getPublicKey({
      identityKey: true
    })

  }

  return myId
}
