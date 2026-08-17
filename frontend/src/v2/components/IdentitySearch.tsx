import { useEffect, useId, useMemo, useState } from 'react'
import { IdentityClient, type WalletInterface } from '@bsv/sdk'
import { Search, ShieldCheck } from 'lucide-react'

export interface IdentityChoice {
  identityKey: string
  name: string
}

interface Props {
  wallet: WalletInterface
  onSelect: (identity: IdentityChoice) => void
}

const IDENTITY_KEY = /^(02|03)[0-9a-f]{64}$/i

export function IdentitySearch({ wallet, onSelect }: Props) {
  const inputId = useId()
  const client = useMemo(() => new IdentityClient(wallet), [wallet])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<IdentityChoice[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const clean = query.trim()
    if (clean.length < 2) { setResults([]); setLoading(false); setError(''); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      setError('')
      const request = IDENTITY_KEY.test(clean)
        ? client.resolveByIdentityKey({ identityKey: clean, limit: 10 }, { useContacts: true })
        : client.resolveByAttributes({ attributes: { any: clean }, limit: 10 }, { useContacts: true })
      void request.then((identities) => {
        if (controller.signal.aborted) return
        const mapped = identities.map((identity) => ({ identityKey: identity.identityKey, name: identity.name || identity.abbreviatedKey }))
        if (IDENTITY_KEY.test(clean) && !mapped.some((identity) => identity.identityKey === clean)) {
          mapped.unshift({ identityKey: clean, name: 'Verified public key format' })
        }
        setResults(mapped.filter((identity, index, all) => all.findIndex((item) => item.identityKey === identity.identityKey) === index))
      }).catch(() => { if (!controller.signal.aborted) setError('Identity lookup is temporarily unavailable. A complete public key still works.') })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 350)
    return () => { clearTimeout(timer); controller.abort() }
  }, [client, query])

  return (
    <div className="identity-search">
      <label htmlFor={inputId}><Search size={17} /><input id={inputId} name="identity-search" aria-label="Search identities" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or identity public key" autoComplete="off" /></label>
      {loading && <div className="identity-search-state"><span className="mini-spinner" /> Searching certified identities…</div>}
      {error && <p className="identity-search-error">{error}</p>}
      {results.length > 0 && <div className="identity-results">
        {results.map((identity) => <button key={identity.identityKey} onClick={() => { onSelect(identity); setQuery(''); setResults([]) }}>
          <span className="identity-result-avatar">{identity.name.slice(0, 2).toUpperCase()}</span>
          <span><strong>{identity.name}</strong><small>{identity.identityKey.slice(0, 14)}…{identity.identityKey.slice(-10)}</small></span>
          <ShieldCheck size={16} />
        </button>)}
      </div>}
    </div>
  )
}
