import { useEffect, useState } from 'react'
import { identityInitials, type IdentityProfileMap } from '../hooks/useIdentityProfiles'

interface Props {
  identityKey?: string
  profiles: IdentityProfileMap
  className: string
  fallback?: string
}

/** Render a certified public avatar without sending the current page as a referrer. */
export function IdentityAvatar({ identityKey, profiles, className, fallback }: Props) {
  const avatarURL = identityKey ? profiles[identityKey]?.avatarURL : undefined
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [avatarURL])

  return (
    <span className={`${className} identity-avatar ${avatarURL && !failed ? 'has-image' : ''}`}>
      {avatarURL && !failed
        ? <img src={avatarURL} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        : (fallback ?? identityInitials(profiles, identityKey))}
    </span>
  )
}
