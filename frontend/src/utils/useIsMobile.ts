import { useState, useEffect } from 'react'

/**
 * useIsMobile
 *
 * Detects if the screen is smaller than a given breakpoint (default 768px).
 * Returns a boolean that updates when the window is resized.
 *
 * Example:
 *   const isMobile = useIsMobile()
 *   if (isMobile) { ... }
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint)
    check() // run immediately
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [breakpoint])

  return isMobile
}
