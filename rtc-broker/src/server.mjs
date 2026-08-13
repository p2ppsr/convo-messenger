import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { createApp, createTwilioIssuer } from './app.mjs'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const port = Number(process.env.PORT ?? 8080)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid')

const wallet = new ProtoWallet(PrivateKey.fromString(required('SERVER_PRIVATE_KEY')))
const issueToken = createTwilioIssuer({
  accountSid: required('TWILIO_ACCOUNT_SID'),
  authToken: required('TWILIO_AUTH_TOKEN'),
  ttlSeconds: Number(process.env.TURN_CREDENTIAL_TTL_SECONDS ?? 3_600),
})
const app = createApp({
  wallet,
  issueToken,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'https://convo.metanet.app,http://localhost:5173').split(','),
})

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Convo RTC credential broker listening on ${port}`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
