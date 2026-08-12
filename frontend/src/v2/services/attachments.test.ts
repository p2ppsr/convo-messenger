import type { WalletInterface } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { generateRootKey } from '../domain/crypto'
import { AttachmentService, MAX_ATTACHMENT_BYTES } from './attachments'

describe('attachment limits', () => {
  it('rejects oversized content before reading or uploading it', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const file = {
      name: 'too-large.bin', type: 'application/octet-stream', size: MAX_ATTACHMENT_BYTES + 1, arrayBuffer,
    } as unknown as File
    const service = new AttachmentService({} as WalletInterface)
    const epoch = { epoch: 1, rootKey: generateRootKey(), members: [], admins: [], activatedAt: 1 }

    await expect(service.upload(file, epoch)).rejects.toThrow('25 MB')
    expect(arrayBuffer).not.toHaveBeenCalled()
  })
})
