import type { Db } from 'mongodb'

// Shared storage
import { ConvoStorage } from './src/lookup-services/ConvoStorage'

// Services
import { ConvoLookupService } from './src/lookup-services/ConvoLookupServiceFactory'
import ConvoTopicManager from './src/topic-managers/ConvoTopicManager'

export function createConvoBackend(
  db: Db,
  opts?: { collectionPrefix?: string }
) {
  // Reuse one storage instance across services
  const storage = new ConvoStorage(db, opts)

  const lookup = new ConvoLookupService(storage)
  const topic  = new ConvoTopicManager()

  return {
    storage, // exposes helper methods if host needs them
    lookup,  // register under service name `ls_convo`
    topic    // register under topic name  `tm_ls_convo`
  }
}

// Re-export public types for host apps
export * from './src/types'

// Optional: re-export storage class if hosts want to compose manually
export { ConvoStorage as ConvoStorageClass } from './src/lookup-services/ConvoStorage'
