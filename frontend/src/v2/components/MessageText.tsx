import { Fragment } from 'react'
import type { IdentityProfileMap } from '../hooks/useIdentityProfiles'
import { identityName } from '../hooks/useIdentityProfiles'

/** Render a small, safe formatting vocabulary without HTML or remote embeds. */
export function MessageText({ body, profiles }: { body: string; profiles: IdentityProfileMap }) {
  const tokens = body.split(/(```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<>]+|@<(?:02|03)[0-9a-f]{64}>)/gi)
  return <div className="message-text">{tokens.map((token, index) => {
    if (token.startsWith('```') && token.endsWith('```')) {
      const code = token.slice(3, -3).replace(/^[a-z0-9#+.-]*\n/i, '')
      return <pre key={index}><code>{code}</code></pre>
    }
    if (token.startsWith('`') && token.endsWith('`')) return <code className="inline-code" key={index}>{token.slice(1, -1)}</code>
    if (/^https?:\/\//i.test(token)) return <a key={index} href={token} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{token}</a>
    if (/^@<(?:02|03)[0-9a-f]{64}>$/i.test(token)) return <span className="message-mention" title={token.slice(2, -1)} key={index}>@{identityName(profiles, token.slice(2, -1))}</span>
    return <Fragment key={index}>{token}</Fragment>
  })}</div>
}
