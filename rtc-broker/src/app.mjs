import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'

const AUTH_HEADERS = [
  'x-bsv-auth-version',
  'x-bsv-auth-message-type',
  'x-bsv-auth-identity-key',
  'x-bsv-auth-nonce',
  'x-bsv-auth-your-nonce',
  'x-bsv-auth-signature',
  'x-bsv-auth-request-id',
  'x-bsv-auth-requested-certificates',
]

const cleanOrigins = (origins) => new Set(origins.map((origin) => origin.trim()).filter(Boolean))

function installCors(app, allowedOrigins) {
  const origins = cleanOrigins(allowedOrigins)
  app.use((req, res, next) => {
    const origin = req.get('origin')
    if (origin && !origins.has(origin)) {
      res.status(403).json({ error: 'Origin is not allowed' })
      return
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin)
      res.vary('Origin')
    }
    res.set('Access-Control-Allow-Methods', 'GET,OPTIONS')
    res.set('Access-Control-Allow-Headers', ['accept', 'content-type', ...AUTH_HEADERS].join(', '))
    res.set('Access-Control-Expose-Headers', AUTH_HEADERS.join(', '))
    res.set('Access-Control-Max-Age', '600')
    res.set('Cross-Origin-Resource-Policy', 'cross-origin')
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })
}

function installSecurityHeaders(app) {
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, private')
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    res.set('Referrer-Policy', 'no-referrer')
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('X-Frame-Options', 'DENY')
    next()
  })
}

function rateLimiter({ limit, windowMs, now = Date.now }) {
  const buckets = new Map()
  return (req, res, next) => {
    const identityKey = req.auth?.identityKey
    if (typeof identityKey !== 'string' || !/^(02|03)[0-9a-f]{64}$/i.test(identityKey)) {
      res.status(401).json({ error: 'Metanet authentication is required' })
      return
    }
    const currentTime = now()
    let bucket = buckets.get(identityKey)
    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowMs }
      buckets.set(identityKey, bucket)
    }
    if (bucket.count >= limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1_000))))
      res.status(429).json({ error: 'Relay credential rate limit exceeded' })
      return
    }
    bucket.count += 1
    if (buckets.size > 10_000) {
      for (const [key, candidate] of buckets) {
        if (candidate.resetAt <= currentTime) buckets.delete(key)
        if (buckets.size <= 8_000) break
      }
    }
    next()
  }
}

function normalizeIceServers(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error('TURN provider returned invalid ICE servers')
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('TURN provider returned an invalid ICE server')
    const urls = candidate.urls ?? candidate.url
    const normalizedUrls = typeof urls === 'string' ? [urls] : urls
    if (!Array.isArray(normalizedUrls) || normalizedUrls.length === 0 || normalizedUrls.length > 8
      || !normalizedUrls.every((url) => typeof url === 'string'
        && url.length <= 2_048
        && /^(stun|stuns|turn|turns):/i.test(url))) {
      throw new Error('TURN provider returned invalid ICE URLs')
    }
    if ((candidate.username !== undefined && (typeof candidate.username !== 'string' || candidate.username.length > 512))
      || (candidate.credential !== undefined && (typeof candidate.credential !== 'string' || candidate.credential.length > 1_024))) {
      throw new Error('TURN provider returned invalid ICE credentials')
    }
    return {
      urls: typeof urls === 'string' ? urls : normalizedUrls,
      ...(candidate.username === undefined ? {} : { username: candidate.username }),
      ...(candidate.credential === undefined ? {} : { credential: candidate.credential }),
    }
  })
}

export function createTwilioIssuer({ accountSid, authToken, ttlSeconds = 3_600, fetchImpl = fetch }) {
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || typeof authToken !== 'string' || authToken.length < 20) {
    throw new Error('Twilio credentials are not configured')
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
    throw new Error('TURN credential TTL must be between 60 and 86400 seconds')
  }
  return async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    try {
      const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ Ttl: String(ttlSeconds) }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Twilio token request failed with ${response.status}`)
      const body = await response.json()
      return { iceServers: normalizeIceServers(body.ice_servers), ttlSeconds }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function createApp({
  wallet,
  issueToken,
  allowedOrigins = ['https://convo.metanet.app', 'http://localhost:5173'],
  rateLimit = 30,
  rateWindowMs = 60 * 60 * 1_000,
  now = Date.now,
}) {
  if (!wallet || typeof issueToken !== 'function') throw new Error('Broker dependencies are required')
  const app = express()
  app.disable('x-powered-by')
  installCors(app, allowedOrigins)
  installSecurityHeaders(app)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.use(express.json({ limit: '16kb' }))
  app.use(createAuthMiddleware({
    wallet,
    logLevel: 'error',
    transportLimits: {
      requestTimeoutMs: 10_000,
      maxPendingRequests: 200,
      maxResponseBytes: 64 * 1_024,
    },
  }))

  app.get('/ice', rateLimiter({ limit: rateLimit, windowMs: rateWindowMs, now }), async (_req, res) => {
    try {
      const { iceServers, ttlSeconds } = await issueToken()
      res.json({
        iceServers: normalizeIceServers(iceServers),
        expiresAt: now() + ttlSeconds * 1_000,
      })
    } catch {
      res.status(502).json({ error: 'Managed relay credentials are temporarily unavailable' })
    }
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })
  return app
}
