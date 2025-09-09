// MainLayout.tsx
import React from 'react'
import { Box } from '@mui/material'

interface MainLayoutProps {
  sidebar: React.ReactNode
  content: React.ReactNode
}

const MainLayout: React.FC<MainLayoutProps> = ({ sidebar, content }) => {
  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      <Box sx={{
        width: 280,
        backgroundColor: '#1e1e1e',
        color: 'white',
        borderRight: '1px solid #444',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {sidebar}
      </Box>

      <Box sx={{
        flex: 1,
        backgroundColor: '#121212',
        color: 'white',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {content}
      </Box>
    </Box>
  )
}

export default MainLayout
