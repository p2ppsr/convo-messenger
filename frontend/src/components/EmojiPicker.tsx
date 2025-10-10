import React, { useState, useMemo } from 'react'
import { Box, Typography, Divider, TextField } from '@mui/material'
import { emojiCategories } from '../utils/emojiList'

interface EmojiPickerProps {
  onSelect: (emoji: string) => void
}

const EmojiPicker: React.FC<EmojiPickerProps> = ({ onSelect }) => {
  const [query, setQuery] = useState('')

  // Filter emojis based on the query
  const filteredCategories = useMemo(() => {
    if (!query.trim()) return emojiCategories
    const lower = query.toLowerCase()
    return emojiCategories
      .map((cat) => ({
        ...cat,
        emojis: cat.emojis.filter(
          (e) => e.includes(lower) || cat.name.toLowerCase().includes(lower)
        ),
      }))
      .filter((cat) => cat.emojis.length > 0)
  }, [query])

  return (
    <Box
      sx={{
        p: 1,
        width: 300,
        maxHeight: 360,
        overflowY: 'auto',
        backgroundColor: 'rgba(30,30,30,0.95)',
        borderRadius: 2,
        boxShadow: 3,
      }}
    >
      {/* Search bar */}
      <TextField
        size="small"
        placeholder="Search emoji..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        fullWidth
        sx={{
          mb: 1,
          '& .MuiInputBase-root': {
            backgroundColor: 'rgba(255,255,255,0.1)',
            borderRadius: 1,
            color: 'white',
          },
          '& .MuiInputBase-input::placeholder': { color: 'rgba(255,255,255,0.5)' },
        }}
        inputProps={{ style: { color: 'white' } }}
      />

      {/* Emoji sections */}
      {filteredCategories.length === 0 ? (
        <Typography variant="body2" color="gray" align="center" mt={2}>
          No results
        </Typography>
      ) : (
        filteredCategories.map((cat, i) => (
          <Box key={cat.name} mb={1}>
            <Typography variant="subtitle2" color="gray" mb={0.5}>
              {cat.name}
            </Typography>

            {/* Emoji grid (flex-wrap) */}
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                justifyContent: 'flex-start',
              }}
            >
              {cat.emojis.map((emoji) => (
                <Box
                  key={emoji}
                  sx={{
                    width: '14.28%', // ~7 per row
                    textAlign: 'center',
                    cursor: 'pointer',
                    fontSize: '1.3rem',
                    lineHeight: 1.8,
                    transition: 'transform 0.15s ease',
                    '&:hover': { transform: 'scale(1.3)' },
                  }}
                  onClick={() => onSelect(emoji)}
                >
                  {emoji}
                </Box>
              ))}
            </Box>

            {i < filteredCategories.length - 1 && (
              <Divider sx={{ my: 1, borderColor: 'rgba(255,255,255,0.2)' }} />
            )}
          </Box>
        ))
      )}
    </Box>
  )
}

export default EmojiPicker
