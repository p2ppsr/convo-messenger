import React from 'react'
import { Typography, Link, Box } from '@mui/material'

const Footer: React.FC = () => {
  return (
    <Box component="footer" sx={{ mt: 6, mb: 2, textAlign: 'center' }}>
      <Typography variant="body2" paragraph>
        Check out the{' '}
        <Link
          href="https://projectbabbage.com/docs/nanostore/concepts/uhrp"
          target="_blank"
          rel="noopener noreferrer"
        >
          Universal Hash Resolution Protocol
        </Link>
        !
      </Typography>
      <Typography variant="body2">
        <Link
          href="https://projectbabbage.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          www.ProjectBabbage.com
        </Link>
      </Typography>
    </Box>
  )
}

export default Footer
