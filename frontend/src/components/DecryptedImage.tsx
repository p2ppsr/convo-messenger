import React, { useState } from 'react'
import useAsyncEffect from 'use-async-effect'
import { download } from 'nanoseek'
import { decrypt } from '@babbage/sdk-ts'

interface DecryptedImageProps {
  otherUserId: string,
  fileOrHash: File | string
  imageKey: string
}

const DecryptedImage: React.FC<DecryptedImageProps> = (props) => {

  const [imgUrl, setImgUrl] = useState<string | undefined>(undefined)

  useAsyncEffect(async () => {

    // check that the hash isn't blank
    if (typeof(props.fileOrHash) === 'string') {

      console.log(props.fileOrHash)

      if (props.fileOrHash !== 'NO_IMG') {

        try {

          // use nanoseek to download the image
          const { mimeType, data } = await download({
            UHRPUrl: props.fileOrHash,
            confederacyHost: 'https://confederacy.babbage.systems'
          })

          // create a Blob of the data
          const encryptedBlob = new Blob([data], { type: mimeType })

          // change the Blob into a Uint8Array
          const encryptedBlobArrayBuffer: ArrayBuffer = await encryptedBlob.arrayBuffer()
          const encryptedBlobUint8Array: Uint8Array = new Uint8Array(encryptedBlobArrayBuffer)

          console.log('decrypted image imageKey', props.imageKey)

          // decrypt the Blob
          const decryptedArray = await decrypt({
            ciphertext: encryptedBlobUint8Array,
            protocolID: [1, 'MattChatEncryption'],
            keyID: props.imageKey,
            counterparty: props.otherUserId,
            returnType: 'Uint8Array'
          })

          // new Blob of the decrypted data
          const decryptedBlob = new Blob([decryptedArray], { type: mimeType})

          // create object URL of the decrypted image
          const objectUrl = window.URL.createObjectURL(decryptedBlob)

          // set the the objectURL for the img element to use
          setImgUrl(objectUrl)

        } catch (e) {
          console.error(e)
        }
      }
    } else if (props.fileOrHash instanceof File) {
      try {
        // create object URL of the passed image
        const objectUrl = window.URL.createObjectURL(props.fileOrHash)

        // set the objectURL for the img element
        setImgUrl(objectUrl)
      } catch (e) {
        console.error(e)
      }
    }

  }, [])

  return (
    <>
      {imgUrl && <img style={{maxWidth: "100%"}} src={imgUrl} alt='photo sent with message'/>}
    </>
  )
}

export default DecryptedImage
