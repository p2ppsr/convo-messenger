type NetworkPreset = 'local' | 'testnet' | 'mainnet'

interface ConvoConstants {
  networkPreset: NetworkPreset
  walletHost: string
  overlayTopic: string
  overlayTM: string
  basket: string
  protocolID: [number, string]
  uhrpGateway: string
}

const isLocal =
  typeof window !== 'undefined' &&
  window.location.hostname === 'localhost'

const networkFromEnv = (typeof import.meta !== 'undefined'
  ? (import.meta as any).env?.VITE_NETWORK
  : undefined) as NetworkPreset | undefined

const walletHostFromEnv = (typeof import.meta !== 'undefined'
  ? (import.meta as any).env?.VITE_WALLET_HOST
  : undefined)

const uhrpFromEnv = (typeof import.meta !== 'undefined'
  ? (import.meta as any).env?.VITE_UHRP_GATEWAY
  : undefined)

const constants: ConvoConstants = {
  networkPreset: networkFromEnv ?? (isLocal ? 'local' : 'mainnet'),
  walletHost: walletHostFromEnv ?? 'localhost',
  overlayTopic: 'ls_convo',
  overlayTM: 'tm_ls_convo',
  basket: 'ls_convo',
  protocolID: [1, 'ConvoMessenger'],
  // uhrpGateway: uhrpFromEnv ?? (isLocal
  //   ? 'http://localhost:3301'
  //   : 'https://uhrp-lite.babbage.systems'),
      uhrpGateway: uhrpFromEnv ?? (isLocal
          ? 'http://localhost:3301'
          : 'https://nanostore.babbage.systems'),
}

export const POLLING_ENABLED = true

export default constants
