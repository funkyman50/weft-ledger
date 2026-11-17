import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, apiClient } from '../api/client'
import { Button } from './Button'

interface LoginPageProps {
  onSuccess: () => void
}

export function LoginPage({ onSuccess }: LoginPageProps) {
  const [checking, setChecking] = useState(true)
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setChecking(true)
    setError(null)
    const open = async () => {
      try {
        await apiClient.get('/api/system/password', controller.signal)
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 401) throw cause
        await apiClient.providerPost('/login', { password: '' }, controller.signal)
      }
      if (!controller.signal.aborted) onSuccess()
    }
    void open().catch((cause) => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.code === 'password_required') setPasswordRequired(true)
      else setError(cause instanceof ApiError ? cause.message : 'Could not open Weft.')
    }).finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [attempt, onSuccess])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await apiClient.providerPost('/login', { password })
      onSuccess()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="bp-login">
      <form className="bp-login-card" onSubmit={handleSubmit}>
        <div className="bp-login-brand"><img className="bp-brand-mark" src="/icon.png" alt="" width={36} height={36} /><strong>Weft</strong></div>
        <h1>{checking ? 'Opening Weft…' : 'Welcome back'}</h1>
        {checking ? <p role="status">Checking this installation…</p> : passwordRequired ? <>
        <p>Enter the shared password to open your accounts.</p>
        <label htmlFor="password">Password</label>
        <input id="password" className="bp-control" name="password" type="password" autoComplete="current-password" maxLength={4096} autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
        {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
        <Button size="lg" variant="primary" type="submit" busy={submitting}>{submitting ? 'Opening…' : 'Log in'}</Button>
        </> : <>
          {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
          <Button size="lg" variant="primary" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry opening Weft</Button>
        </>}
      </form>
    </main>
  )
}
