import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ThemeProvider } from './lib/theme.jsx'

// Wait for Inter before the first draw. Tables and panel headers size their
// columns by measuring text on a canvas, once, when they first render; if that
// runs before the font arrives it measures the stand-in font and the columns
// are sized for text that is then painted wider or narrower. The font is local
// (ui/public/fonts) and preloaded, so this is normally a few milliseconds. The
// 1.5s cap means a missing font can delay the app, never stop it.
const fontReady = document.fonts
  ? Promise.all([document.fonts.load('400 14px Inter'), document.fonts.load('600 14px Inter')]).catch(() => {})
  : Promise.resolve()
const cap = new Promise((resolve) => setTimeout(resolve, 1500))

Promise.race([fontReady, cap]).then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  )
})
