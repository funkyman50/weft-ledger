import { useCallback, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { endLedgerHistorySession, setUnauthorizedHandler } from './api/client'
import { LoginPage } from './components/LoginPage'
import { LedgerScreen } from './features/ledger/LedgerScreen'
import './blueprint.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
})

function App() {
  const [authenticated, setAuthenticated] = useState(true)

  useEffect(() => {
    setUnauthorizedHandler(() => {
      endLedgerHistorySession()
      queryClient.clear()
      setAuthenticated(false)
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const handleLogin = useCallback(() => {
    queryClient.clear()
    setAuthenticated(true)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      {authenticated ? <LedgerScreen /> : <LoginPage onSuccess={handleLogin} />}
    </QueryClientProvider>
  )
}

export default App
