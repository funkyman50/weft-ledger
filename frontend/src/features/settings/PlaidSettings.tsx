import { useEffect, useRef, useState } from 'react'
import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import { Button } from '../../components/Button'
import { FilterSelect } from '../../components/FilterSelect'

type PlaidState = {
  revision: string
  client_id: string
  has_secret: boolean
  configured: boolean
  environment: 'production' | 'sandbox'
  configuration_matches: boolean
  identity_locked: boolean
  custody_environment: 'production' | 'sandbox' | null
  bank_sync_paused: boolean
}

export function PlaidSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [state, setState] = useState<PlaidState | null>(null)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [environment, setEnvironment] = useState<'production' | 'sandbox'>('production')
  const [busy, setBusy] = useState<string | null>(null)
  const busyRef = useRef(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function accept(value: PlaidState) {
    setState(value)
    setClientId(value.client_id)
    setEnvironment(value.custody_environment ?? value.environment)
    setSecret('')
    setNeedsRefresh(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    void apiClient.get<PlaidState>('/api/plaid/settings', controller.signal).then(accept).catch((cause) => {
      if (!controller.signal.aborted) setError(apiErrorMessage(cause, 'Could not load Plaid settings.'))
    })
    return () => controller.abort()
  }, [])

  const sameIdentity = state !== null && clientId.trim() === state.client_id && environment === state.environment
  const dirty = state !== null && (clientId.trim() !== state.client_id || environment !== (state.custody_environment ?? state.environment) || secret !== '')
  useEffect(() => { onBusyChange(Boolean(busy) || dirty && !needsRefresh); return () => onBusyChange(false) }, [busy, dirty, needsRefresh, onBusyChange])
  const blocked = Boolean(busy) || needsRefresh || !state
  const valid = Boolean(clientId.trim() && (secret.trim() || sameIdentity && state?.has_secret))

  async function refresh() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy('refresh')
    setError(null)
    try {
      accept(await apiClient.get<PlaidState>('/api/plaid/settings', AbortSignal.timeout(10_000)))
    } catch (cause) {
      setNeedsRefresh(true)
      setError(apiErrorMessage(cause, 'Could not refresh Plaid settings. Refresh before continuing.'))
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  async function run(action: 'save' | 'check') {
    if (busyRef.current || blocked || !state) return
    busyRef.current = true
    setBusy(action)
    setNotice(null)
    setError(null)
    try {
      if (action === 'save') {
        const value = await apiClient.providerPost<PlaidState>('/api/plaid/settings', {
          expected_revision: state.revision, client_id: clientId.trim(), secret: secret.trim() || null, environment,
        }, AbortSignal.timeout(70_000))
        accept(value)
        setNotice('Plaid settings saved. Existing connections and financial history are preserved. Saving does not start sync.')
      } else {
        const result = await apiClient.providerPost<{ message: string }>('/api/plaid/settings/check', { expected_revision: state.revision }, AbortSignal.timeout(40_000))
        setNotice(result.message)
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500 && cause.code !== 'unknown_error') {
        setError(apiErrorMessage(cause, 'The request was rejected. Correct the draft before trying again.'))
        if (cause.code === 'plaid_settings_changed') setNeedsRefresh(true)
      } else {
        try {
          accept(await apiClient.get<PlaidState>('/api/plaid/settings', AbortSignal.timeout(10_000)))
          setError(apiErrorMessage(cause, 'The request outcome was uncertain. Saved settings have been refreshed; review them before continuing.'))
        } catch {
          setNeedsRefresh(true)
          setError('The request outcome could not be confirmed. Refresh settings before continuing. Do not repeat the request yet.')
        }
      }
    } finally {
      setSecret('')
      busyRef.current = false
      setBusy(null)
    }
  }

  const setup = !state?.configured
    ? { tone: '', label: 'Not set up', detail: 'Manual accounts remain available.' }
    : !state.configuration_matches
      ? { tone: 'is-warning', label: 'Needs original credentials', detail: 'Saved credentials do not match the restored bank connections.' }
      : { tone: 'is-on', label: state.environment === 'sandbox' ? 'Saved · Sandbox' : 'Saved', detail: state.environment === 'sandbox' ? 'Using Plaid test banks.' : 'Using real banks.' }
  const checkUnavailable = !state?.configured ? 'Save credentials to check them.'
    : !state.configuration_matches ? 'Enter the original credentials for your bank connections first.'
      : state.bank_sync_paused ? 'Paused after restore. Press Sync Plaid to resume bank activity first.'
        : dirty ? 'Save or cancel your changes first.'
          : null

  return <>
    {state?.bank_sync_paused && <div className="bp-callout bp-callout--warning" role="status">Bank sync is paused after restore. Save matching credentials here if needed, then press Sync Plaid to resume bank activity.</div>}
    {state ? <form className="bp-settings-card" aria-labelledby="plaid-account-title" onSubmit={(event) => { event.preventDefault(); if (valid && dirty) void run('save') }}>
      <div className="bp-settings-card-head">
        <div>
          <strong id="plaid-account-title" role="heading" aria-level={3}>Plaid developer account</strong>
          <small>Copy the Client ID and Secret from your own <a className="bp-settings-link" href="https://dashboard.plaid.com/" target="_blank" rel="noopener noreferrer">Plaid Dashboard</a>. Bank sign-in happens separately when you connect an account.</small>
        </div>
        <span className={`bp-settings-pill ${setup.tone}`} role="status" title={setup.detail}><i aria-hidden="true" />{setup.label}<span className="bp-visually-hidden">. {setup.detail}</span></span>
      </div>
      {state.configured && !state.configuration_matches && <div className="bp-callout bp-callout--warning" role="alert">These bank connections belong to a different Plaid account or environment. Enter their original Client ID and Secret. Your history is preserved.</div>}
      <div className="bp-field-grid bp-field-grid--even">
        <label className="bp-field">Client ID<input className="bp-control" autoComplete="off" spellCheck={false} value={clientId} maxLength={256} disabled={blocked || state.identity_locked} onChange={(event) => setClientId(event.target.value)} /></label>
        <label className="bp-field">Secret<input className="bp-control" type="password" autoComplete="new-password" value={secret} maxLength={256} disabled={blocked} placeholder={state.has_secret && sameIdentity ? 'Saved — leave blank to keep' : 'Paste your Plaid Secret'} onChange={(event) => setSecret(event.target.value)} /></label>
      </div>
      {state.custody_environment && <p className="bp-note">Your bank connections are tied to this Plaid account and {state.custody_environment === 'production' ? 'real-bank' : 'Sandbox'} environment. You can replace the Secret. To switch accounts, disconnect those feeds first; your history stays.</p>}
      <details className="bp-settings-disclosure">
        <summary>Advanced</summary>
        <div className="bp-field-grid bp-field-grid--even">
          <label className="bp-field">Environment<FilterSelect ariaLabel="Plaid environment" autoFocus={false} disabled={blocked || state.custody_environment !== null} value={environment} options={[{ value: 'production', label: 'Real banks (Production)' }, { value: 'sandbox', label: 'Test banks (Sandbox)' }]} onChange={(value) => setEnvironment(value as PlaidState['environment'])} /></label>
        </div>
        <p className="bp-note">Use Sandbox only in a separate test installation. The environment is locked while bank connections exist.</p>
      </details>
      <div className="bp-button-group">
        <Button type="submit" size="md" variant="primary" busy={busy === 'save'} disabled={blocked || !valid || !dirty}>{busy === 'save' ? 'Saving…' : 'Save settings'}</Button>
        {dirty && !needsRefresh && <Button size="md" disabled={Boolean(busy)} onClick={() => accept(state)}>Cancel changes</Button>}
        {dirty && !needsRefresh && <span className="bp-note">Save or cancel before leaving this tab.</span>}
      </div>
    </form> : !error && <p className="bp-note" role="status">Loading Plaid settings…</p>}
    {state && <section className="bp-settings-card bp-settings-card--inline" aria-labelledby="plaid-check-title">
      <div className="bp-settings-card-head">
        <div>
          <strong id="plaid-check-title" role="heading" aria-level={3}>Check credentials</strong>
          <small>{checkUnavailable ?? 'Asks Plaid to accept the saved credentials. No bank connection is created, and success does not confirm access to every bank or product.'}</small>
        </div>
      </div>
      <Button size="md" busy={busy === 'check'} disabled={blocked || checkUnavailable !== null} onClick={() => void run('check')}>{busy === 'check' ? 'Checking…' : 'Check credentials'}</Button>
    </section>}
    {notice && <div className="bp-callout bp-callout--info" role="status">{notice}</div>}
    {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
    {(needsRefresh || !state && error) && <Button size="md" disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh settings</Button>}
    {state && <p className="bp-note">Weft is free, but Plaid eligibility, bank coverage and charges depend on your Plaid plan. A Trial allows ten bank-connection creations in total, and deleting a connection does not restore one. Several accounts can share one connection, so reuse or repair an existing bank login before adding another. A failed new connection can still use a Trial slot.</p>}
  </>
}
