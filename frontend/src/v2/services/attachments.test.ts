import { CompletedProtoWallet, PrivateKey, StorageUtils, Utils } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { generateRootKey } from '../domain/crypto'
import type { ConversationEpoch } from '../domain/types'
import { AttachmentService, MAX_ATTACHMENT_BYTES } from './attachments'

function file(name: string, type: string, data: number[]): File {
  return {
    name,
    type,
    size: data.length,
    arrayBuffer: async () => Uint8Array.from(data).buffer,
  } as File
}

function blobBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)))
    reader.readAsArrayBuffer(blob)
  })
}

function memoryStorage() {
  const blobs = new Map<string, Uint8Array>()
  return {
    blobs,
    storage: {
      publish: vi.fn(async (data: Uint8Array) => {
        const copy = Uint8Array.from(data)
        const handle = StorageUtils.getURLForFile(copy)
        blobs.set(handle, copy)
        return handle
      }),
      download: vi.fn(async (handle: string) => {
        const data = blobs.get(handle)
        if (!data) throw new Error('missing')
        return Uint8Array.from(data)
      }),
    },
  }
}

async function fixture() {
  const wallets = [0, 1, 2].map(() => new CompletedProtoWallet(PrivateKey.fromRandom()))
  const identities = await Promise.all(wallets.map(async (wallet) => (await wallet.getPublicKey({ identityKey: true })).publicKey))
  const epoch: ConversationEpoch = {
    epoch: 1,
    rootKey: generateRootKey(),
    members: identities.slice(0, 2),
    admins: [identities[0]],
    activatedAt: 1,
  }
  return { wallets, identities, epoch, conversationId: 'ab'.repeat(32) }
}

describe('CurvePoint UHRP attachments', () => {
  it('rejects oversized content before reading, encrypting, or uploading it', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const oversized = {
      name: 'too-large.bin', type: 'application/octet-stream', size: MAX_ATTACHMENT_BYTES + 1, arrayBuffer,
    } as unknown as File
    const { wallets, epoch, conversationId } = await fixture()
    const memory = memoryStorage()
    const service = new AttachmentService(wallets[0], memory.storage)

    await expect(service.upload([oversized], conversationId, epoch)).rejects.toThrow('25 MB')
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(memory.storage.publish).not.toHaveBeenCalled()
  })

  it('publishes only padded ciphertext while every epoch member can decrypt the image', async () => {
    const { wallets, identities, epoch, conversationId } = await fixture()
    const memory = memoryStorage()
    const plaintext = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]
    const sender = new AttachmentService(wallets[0], memory.storage)
    const batch = await sender.upload([file('private.png', 'image/png', plaintext)], conversationId, epoch)
    const reference = batch.attachments[0]
    const published = memory.blobs.get(reference.handle)

    expect(StorageUtils.isValidURL(reference.handle)).toBe(true)
    expect(published?.length).toBeGreaterThanOrEqual(4_096)
    expect(Utils.toHex(Array.from(published ?? []))).not.toContain(Utils.toHex(plaintext))
    for (const identity of identities.slice(0, 2)) expect(Utils.toHex(Array.from(published ?? []))).not.toContain(identity)

    for (const wallet of wallets.slice(0, 2)) {
      const blob = await new AttachmentService(wallet, memory.storage).download(reference, batch.attachmentKey, conversationId, epoch)
      expect(await blobBytes(blob)).toEqual(plaintext)
      expect(blob.type).toBe('image/png')
    }
  })

  it('denies non-members and rejects tampering or cross-conversation key reuse', async () => {
    const { wallets, epoch, conversationId } = await fixture()
    const memory = memoryStorage()
    const sender = new AttachmentService(wallets[0], memory.storage)
    const batch = await sender.upload([file('secret.jpg', 'image/jpeg', [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])], conversationId, epoch)
    const reference = batch.attachments[0]

    await expect(new AttachmentService(wallets[2], memory.storage)
      .download(reference, batch.attachmentKey, conversationId, epoch)).rejects.toThrow()
    await expect(sender.download(reference, batch.attachmentKey, 'cd'.repeat(32), epoch)).rejects.toThrow('scope')

    const ciphertext = memory.blobs.get(reference.handle)
    if (!ciphertext) throw new Error('test ciphertext missing')
    const tampered = Uint8Array.from(ciphertext)
    tampered[tampered.length - 1] ^= 1
    memory.blobs.set(reference.handle, tampered)
    await expect(sender.download(reference, batch.attachmentKey, conversationId, epoch)).rejects.toThrow()
  })

  it('wraps one batch key so a 100-member attachment event stays within the durable event budget', async () => {
    const keys = Array.from({ length: 100 }, () => PrivateKey.fromRandom())
    const wallet = new CompletedProtoWallet(keys[0])
    const members = keys.map((key) => key.toPublicKey().toString())
    const epoch: ConversationEpoch = {
      epoch: 7,
      rootKey: generateRootKey(),
      members,
      admins: [members[0]],
      activatedAt: 1,
    }
    const conversationId = 'ef'.repeat(32)
    const memory = memoryStorage()
    const batch = await new AttachmentService(wallet, memory.storage)
      .upload([file('group.png', 'image/png', [1, 2, 3])], conversationId, epoch)
    const event = {
      v: 2, type: 'message', id: '12'.repeat(32), conversationId, epoch: 7,
      sender: members[0], createdAt: Date.now(), body: '', ...batch,
    }

    expect(Utils.toArray(JSON.stringify(event), 'utf8').length).toBeLessThanOrEqual(24_000)
  })
})
