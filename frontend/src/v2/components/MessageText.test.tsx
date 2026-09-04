import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MessageText } from './MessageText'
afterEach(cleanup)
it('renders code and links without interpreting HTML or creating remote image requests', () => {
  const { container } = render(<MessageText profiles={{}} body={'Use `npm test`.\n```ts\nconst x = 1\n```\nhttps://example.com/docs\n<img src=x onerror=alert(1)> javascript:alert(1)'} />)
  expect(container.querySelector('pre code')?.textContent).toBe('const x = 1\n')
  expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/docs')
  expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer')
  expect(container.querySelector('img')).toBeNull()
  expect(screen.getAllByRole('link')).toHaveLength(1)
})
