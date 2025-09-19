// src/theme.ts
import { createTheme } from '@mui/material/styles'

// 🎨 Define base colors
const primary = '#5865F2'   // Discord blurple
const secondary = '#3BA55D' // Discord green (for invites/confirm)
const backgroundDark = '#2B2D31' // Chat background
const surfaceDark = '#313338'    // Message + input surfaces
const textPrimary = '#FFFFFF'
const textSecondary = '#B9BBBE'

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: primary,
    },
    secondary: {
      main: secondary,
    },
    background: {
      default: backgroundDark,
      paper: surfaceDark,
    },
    text: {
      primary: textPrimary,
      secondary: textSecondary,
    },
  },
  typography: {
    fontFamily: `'Inter', 'Roboto', 'Helvetica', 'Arial', sans-serif`,
    fontSize: 14,
    body1: {
      fontSize: '0.95rem',
    },
    body2: {
      fontSize: '0.85rem',
      color: textSecondary,
    },
  },
  components: {
    // 🧾 Buttons look more Discord-like (pill style)
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          textTransform: 'none',
          fontWeight: 500,
        },
      },
    },
    // 📨 Input fields
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 8,
            backgroundColor: surfaceDark,
          },
        },
      },
    },
    // 📑 Paper (used for cards, menus, etc.)
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundColor: surfaceDark,
          borderRadius: 8,
        },
      },
    },
    // 📋 Lists (sidebar style)
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          margin: '2px 4px',
          '&.Mui-selected': {
            backgroundColor: primary,
            color: '#fff',
            '&:hover': {
              backgroundColor: primary,
            },
          },
        },
      },
    },
  },
})

export default theme
