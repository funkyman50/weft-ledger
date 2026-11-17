import { useEffect } from 'react'
import { usePlaidLink, type PlaidLinkOptionsWithLinkToken } from 'react-plaid-link'

export type PlaidLinkHandlers = Omit<PlaidLinkOptionsWithLinkToken, 'token'>

// Mounted only while a bank workflow holds a Link token, so Plaid's script loads on demand.
export function PlaidLinkLauncher({ token, ...handlers }: PlaidLinkHandlers & { token: string }) {
  const { open, ready } = usePlaidLink({ token, ...handlers })
  useEffect(() => { if (ready) open() }, [open, ready])
  return null
}
