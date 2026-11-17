import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Sparkles } from 'lucide-react'
import { apiClient, apiErrorMessage } from '../../api/client'
import type { OpenAIConnectionState, OpenAIModel } from '../../api/types'
import { Button } from '../../components/Button'
import { Switch } from '../../components/Switch'
import { FilterSelect } from '../../components/FilterSelect'

export function OpenAISettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const busy = busyAction !== null
  const busyRef = useRef(false)
  const modelRef = useRef<HTMLDivElement>(null)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const statusQuery = useQuery({
    queryKey: ['openai', 'status'],
    queryFn: ({ signal }) => apiClient.get<OpenAIConnectionState>('/api/openai/status', signal),
    retry: false,
    refetchInterval: (query) => query.state.data?.authorization_pending && !busy ? 1500 : false,
  })
  const state = statusQuery.data
  const modelsQuery = useQuery({
    queryKey: ['openai', 'models', state?.active_client_id],
    queryFn: async ({ signal }) => {
      try {
        return await apiClient.get<{ models: OpenAIModel[] }>('/api/openai/models', signal)
      } finally {
        void statusQuery.refetch()
      }
    },
    enabled: Boolean(state?.connected && state.plan_usage_enabled && !state.authorization_pending),
    retry: false,
  })
  const blocked = busy || needsRefresh || !state || statusQuery.isError

  async function refreshStatus() {
    const result = await statusQuery.refetch()
    setNeedsRefresh(result.isError)
    return !result.isError
  }

  async function run<T>(action: string, fields: Record<string, unknown> = {}, complete?: (result: T) => void) {
    if (busyRef.current || blocked) return false
    const focusBefore = document.activeElement
    busyRef.current = true
    setBusyAction(action)
    onBusyChange(true)
    setError(null)
    setNotice(null)
    try {
      const body = action === 'authorization/cancel' ? fields : { expected_revision: state!.revision, ...fields }
      const result = await apiClient.providerPost<T>(`/api/openai/${action}`, body, AbortSignal.timeout(action === 'check' ? 90_000 : 60_000))
      complete?.(result)
      if (!await refreshStatus()) setError('The request returned, but current connection status could not be read. Refresh status before continuing.')
      return true
    } catch (cause) {
      const refreshed = await refreshStatus()
      setError(apiErrorMessage(cause, refreshed ? 'The request outcome was uncertain. Connection status has been refreshed; check it before trying again.' : 'The request outcome is uncertain. Refresh connection status before continuing.'))
      return false
    } finally {
      busyRef.current = false
      setBusyAction(null)
      onBusyChange(false)
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body) return
        const target = focusBefore instanceof HTMLElement && focusBefore.isConnected ? focusBefore : modelRef.current?.querySelector<HTMLButtonElement>('button')
        if (target && !target.matches(':disabled')) target.focus({ preventScroll: true })
      })
    }
  }

  async function connect(clientId: string | null) {
    if (blocked) return
    const browser = window.open('about:blank', '_blank')
    if (!browser) {
      setError('Allow a new browser tab for ChatGPT sign-in, then try again.')
      return
    }
    browser.opener = null
    const started = await run<{ authorization_url: string }>('authorize', { client_id: clientId }, (result) => {
      const url = new URL(result.authorization_url)
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') throw new Error('Invalid authorization destination')
      browser.location.href = result.authorization_url
    })
    if (!started) browser.close()
  }

  if (!state) return <>
    <p role="status">{statusQuery.isPending ? 'Loading AI settings…' : 'AI settings are unavailable.'}</p>
    {statusQuery.isError && <div className="bp-callout bp-callout--error" role="alert">{apiErrorMessage(statusQuery.error, 'Could not read connection status.')}</div>}
    {!statusQuery.isPending && <Button size="md" onClick={() => void refreshStatus()}>Retry connection status</Button>}
  </>

  const available = modelsQuery.data?.models ?? []
  const active = state.registrations.find((registration) => registration.client_id === state.active_client_id)
  const selectedAvailable = available.some((model) => model.slug === state.selected_model)

  const connection = state.authorization_pending
    ? { tone: 'is-warning is-busy', label: 'Waiting for sign-in', detail: 'Complete ChatGPT sign-in in the browser tab that opened.' }
    : !state.connected
      ? { tone: '', label: 'Not connected', detail: 'Continue with ChatGPT to connect an account.' }
      : state.plan_usage_enabled
        ? { tone: 'is-on', label: 'Connected', detail: 'ChatGPT plan usage authorized.' }
        : { tone: 'is-warning', label: 'Plan usage off', detail: 'Signed in, but ChatGPT plan usage is not authorized.' }

  return <>
    <div className={`bp-ai-master${state.ai_disabled ? '' : ' is-enabled'}`}>
      <span className="bp-ai-master-icon" aria-hidden="true"><Sparkles /></span>
      <div className="bp-ai-master-copy">
        <div className="bp-ai-master-title">
          <strong>Disable all AI</strong>
          <span className={`bp-settings-pill${state.ai_disabled ? '' : ' is-on'}`} role="status"><i aria-hidden="true" />AI features are currently {state.ai_disabled ? 'disabled' : 'enabled'}</span>
        </div>
        <small>Applies to this installation. Connecting ChatGPT does not enable AI or share transaction data.</small>
      </div>
      <Switch label="Disable all AI" checked={state.ai_disabled} disabled={blocked || state.authorization_pending} onChange={(checked) => void run('settings', { ai_disabled: checked })} />
    </div>
    <div className={`bp-ai-body${state.ai_disabled ? ' is-dimmed' : ''}`}>
      {state.ai_disabled && <p className="bp-ai-body-hint">You can still connect ChatGPT and choose a model while AI is off. Nothing is sent until AI is enabled.</p>}
      <section className="bp-settings-card" aria-labelledby="openai-connection-title">
        <div className="bp-settings-card-head">
          <div>
            <strong id="openai-connection-title" role="heading" aria-level={3}>OpenAI connection</strong>
            <small>Eligible requests use your ChatGPT plan. Model access depends on your account and workspace permissions.</small>
          </div>
          <span className={`bp-settings-pill ${connection.tone}`} role="status" title={connection.detail}><i aria-hidden="true" />{connection.label}<span className="bp-visually-hidden">. {connection.detail}</span></span>
        </div>
        {state.registrations.length > 0 && <label className="bp-field">ChatGPT registration
          <FilterSelect
            ariaLabel="ChatGPT registration"
            autoFocus={false}
            value={state.active_client_id ?? ''}
            disabled={blocked || state.authorization_pending}
            options={[
              ...(state.active_client_id ? [] : [{ value: '', label: 'Choose a saved registration', disabled: true }]),
              ...state.registrations.map((registration, index) => ({
                value: registration.client_id,
                label: `${registration.email ?? 'ChatGPT'} · Registration ${index + 1}${!registration.verified ? ' (incomplete sign-in)' : registration.connected ? '' : ' (disconnected)'}`,
                disabled: !registration.verified,
              })),
            ]}
            onChange={(value) => { if (value !== state.active_client_id) void run('settings', { client_id: value }) }}
          />
        </label>}
        <div className="bp-button-group">
          <Button size="md" variant="primary" disabled={blocked || state.authorization_pending} onClick={() => void connect(active?.client_id ?? null)}>Continue with ChatGPT</Button>
          {active && <Button size="md" disabled={blocked || state.authorization_pending} onClick={() => void connect(null)}>Connect another account or workspace</Button>}
          {state.authorization_pending && <Button size="md" disabled={blocked} onClick={() => void run('authorization/cancel', { attempt_id: state.authorization_attempt })}>Cancel sign-in</Button>}
          {state.connected && <Button size="md" variant="quiet" className="bp-ai-disconnect" disabled={blocked || state.authorization_pending} onClick={() => void run<{ revocation_confirmed: boolean }>('disconnect', {}, (result) => setNotice(result.revocation_confirmed ? 'Disconnected from ChatGPT.' : 'Disconnected locally. Remote revocation was not confirmed; disconnect this app in ChatGPT settings.'))}>Disconnect</Button>}
        </div>
        {state.authorization_error && <div className="bp-callout bp-callout--error" role="alert">{state.authorization_error}</div>}
        {state.connected && state.plan_usage_enabled && !state.usage_acknowledged && <div className="bp-callout bp-callout--warning" role="alertdialog" aria-labelledby="openai-plan-title">
          <strong id="openai-plan-title">You’re using your ChatGPT plan</strong>
          <p>Eligible AI requests in Weft use your ChatGPT plan and its usage limits. You can manage access and usage in ChatGPT settings. Each AI feature requires your opt-in.</p>
          <div className="bp-callout-actions"><Button size="md" variant="primary" disabled={blocked} onClick={() => void run('settings', { acknowledge_usage: true })}>Got it</Button></div>
        </div>}
      </section>
      <section className="bp-settings-card" aria-labelledby="openai-model-title">
        <div className="bp-settings-card-head">
          <div>
            <strong id="openai-model-title" role="heading" aria-level={3}>AI model</strong>
            <small>{state.plan_usage_enabled ? 'Applies to every AI feature. Requests use your ChatGPT plan.' : 'Authorize ChatGPT plan usage to choose a model.'}</small>
          </div>
          <a className="bp-settings-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage</a>
        </div>
        <div className="bp-ai-model-row">
          <div ref={modelRef} className="bp-ai-select">
            <FilterSelect
              ariaLabel="AI model"
              autoFocus={false}
              value={state.selected_model ?? ''}
              disabled={blocked || !state.plan_usage_enabled || state.authorization_pending || modelsQuery.isFetching}
              options={[
                { value: '', label: 'Choose a model' },
                ...(state.selected_model && !selectedAvailable ? [{ value: state.selected_model, label: `${state.selected_model} (unavailable)`, disabled: true }] : []),
                ...available.map((model) => ({ value: model.slug, label: model.display_name })),
              ]}
              onChange={(value) => { if (value !== (state.selected_model ?? '')) void run('settings', { selected_model: value || null }) }}
            />
          </div>
          {state.connected && state.plan_usage_enabled && <Button size="lg" iconOnly aria-label="Refresh models" title="Refresh models" disabled={blocked || state.authorization_pending || modelsQuery.isFetching} onClick={() => void modelsQuery.refetch()}><RefreshCw className={modelsQuery.isFetching ? 'bp-ai-spin' : undefined} aria-hidden="true" /></Button>}
        </div>
        {modelsQuery.isFetching && <p className="bp-note" role="status">Loading available models…</p>}
        {modelsQuery.isError && <div className="bp-callout bp-callout--error" role="alert">{apiErrorMessage(modelsQuery.error, 'Could not load available models.')}</div>}
      </section>
      <section className="bp-settings-card bp-settings-card--inline" aria-labelledby="openai-check-title">
        <div className="bp-settings-card-head">
          <div>
            <strong id="openai-check-title" role="heading" aria-level={3}>Check connection</strong>
            <small>Sends only a fixed, invented “Example Market” example to the selected model. It uses your ChatGPT plan. No ledger data is read or sent.</small>
          </div>
        </div>
        <Button size="md" busy={busyAction === 'check'} disabled={blocked || state.ai_disabled || !state.connected || !state.usage_acknowledged || !selectedAvailable || state.authorization_pending} onClick={() => void run<{ message: string }>('check', {}, (result) => setNotice(result.message))}>{busyAction === 'check' ? 'Checking…' : 'Check connection'}</Button>
      </section>
    </div>
    {notice && <div className="bp-callout bp-callout--info" role="status">{notice}</div>}
    {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
    {(needsRefresh || statusQuery.isError) && <Button size="md" disabled={busy || statusQuery.isFetching} onClick={() => void refreshStatus()}>Refresh connection status</Button>}
  </>
}
