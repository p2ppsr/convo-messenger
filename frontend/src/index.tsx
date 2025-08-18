import ReactDOM from 'react-dom/client'
import { CssBaseline } from '@mui/material'
import { ThemeProvider } from '@mui/material/styles'
import App from './App'
import web3Theme from './theme'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <ThemeProvider theme={web3Theme}>
    <CssBaseline />
    <App />
  </ThemeProvider>
)
