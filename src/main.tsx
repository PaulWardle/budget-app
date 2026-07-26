import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import './index.css'

// Vite fires this when a preloaded chunk/CSS fetch fails — i.e. this tab's
// HTML predates the latest deploy and references files that no longer exist.
// Reload to pick up the new build (same 10s guard as lazyPage in App.tsx).
window.addEventListener('vite:preloadError', (e) => {
  const last = Number(sessionStorage.getItem('chunk-reload') ?? 0)
  if (Date.now() - last > 10_000) {
    e.preventDefault()
    sessionStorage.setItem('chunk-reload', String(Date.now()))
    window.location.reload()
  }
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
