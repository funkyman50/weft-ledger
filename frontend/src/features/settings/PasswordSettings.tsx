import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import { Button } from '../../components/Button'
import { Switch } from '../../components/Switch'

type PasswordStatus = { revision: string; password_required: boolean }

export function PasswordSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<PasswordStatus | null>(null)
  const [required, setRequired] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const clearPasswords = () => { setCurrentPassword(''); setNewPassword(''); setConfirmation('') }
  const apply = (value: PasswordStatus) => { setState(value); setRequired(value.password_required); clearPasswords(); setNeedsRefresh(false) }

  useEffect(() => {
    const controller = new AbortController()
    void apiClient.get<PasswordStatus>('/api/system/password', controller.signal).then((value) => {
      if (!controller.signal.aborted) { setState(value); setRequired(value.password_required) }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(apiErrorMessage(cause, 'Could not read password settings.'))
    })
    return () => controller.abort()
  }, [])

  const refresh = async () => {
    if (busyRef.current) return
    setError(null)
    setNotice(null)
    clearPasswords()
    try { apply(await apiClient.get<PasswordStatus>('/api/system/password')) }
    catch (cause) { setError(apiErrorMessage(cause, 'Could not read password settings.')) }
  }

  const save = async () => {
    if (!state || busyRef.current || needsRefresh || uncertain) return
    busyRef.current = true
    setBusy(true)
    onBusyChange(true)
    setError(null)
    setNotice(null)
    let unknown = false
    try {
      const result = await apiClient.providerPost<PasswordStatus>('/api/system/password', {
        revision: state.revision, current_password: currentPassword, new_password: required ? newPassword : null,
      })
      apply(result)
      void queryClient.invalidateQueries({ queryKey: ['backup-status'] })
      setNotice(result.password_required ? 'Password saved. Older sessions must sign in again.' : 'Password removed. Weft opens without signing in on this computer.')
    } catch (cause) {
      unknown = !(cause instanceof ApiError) || cause.status >= 500
      if (unknown) { clearPasswords(); setUncertain(true) }
      if (cause instanceof ApiError && cause.code === 'password_settings_stale') setNeedsRefresh(true)
      setError(unknown ? 'The password save could not be confirmed. Reload, sign in if needed, and inspect Security settings before trying again.' : apiErrorMessage(cause, 'Could not save password settings.'))
    } finally {
      busyRef.current = unknown
      setBusy(unknown)
      onBusyChange(unknown)
    }
  }

  const blocked = busy || needsRefresh
  const valid = !!state && (!state.password_required || !!currentPassword) && (!required || (newPassword.trim().length >= 12 && newPassword === confirmation)) && (state.password_required || required)
  const dirty = !!state && (required !== state.password_required || !!currentPassword || !!newPassword || !!confirmation)
  const mismatch = !!confirmation && confirmation !== newPassword
  const removing = !!state?.password_required && !required

  return <>
    {state ? <form className="bp-settings-card" aria-labelledby="password-settings-title" onSubmit={(event) => { event.preventDefault(); if (valid) void save() }}>
      <div className="bp-account-settings-row">
        <div>
          <strong id="password-settings-title" role="heading" aria-level={3}>Require password</strong>
          <small>Ask for a password before opening Weft on this installation. Encryption keys, saved data and bank connections stay unchanged.</small>
        </div>
        <Switch label="Require password" checked={required} disabled={blocked} onChange={(value) => { setRequired(value); setNewPassword(''); setConfirmation(''); setNotice(null) }} />
      </div>
      {!required && <div className={removing ? 'bp-callout bp-callout--warning' : 'bp-note'} role={removing ? 'status' : undefined}>Without a password, other people, accounts and programs on this computer can open Weft, export data and change settings, including recovery keys. Browser-site protections stay active.</div>}
      {state.password_required && <div className="bp-field-grid bp-field-grid--even">
        <label className="bp-field">Current password<input className="bp-control" type="password" autoComplete="current-password" value={currentPassword} maxLength={4096} disabled={blocked} required onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      </div>}
      {required && <>
        <div className="bp-field-grid bp-field-grid--even">
          <label className="bp-field">New password<input className="bp-control" type="password" autoComplete="new-password" aria-describedby="password-settings-hint" value={newPassword} minLength={12} maxLength={4096} disabled={blocked} required onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label className="bp-field">Confirm new password<input className="bp-control" type="password" autoComplete="new-password" aria-describedby="password-settings-hint" aria-invalid={mismatch || undefined} value={confirmation} maxLength={4096} disabled={blocked} required onChange={(event) => setConfirmation(event.target.value)} /></label>
        </div>
        <p className="bp-note" id="password-settings-hint" role={mismatch ? 'status' : undefined}>{mismatch ? 'New passwords do not match.' : 'Use at least 12 characters.'}</p>
      </>}
      {(state.password_required || required) && <div className="bp-button-group">
        <Button type="submit" size="md" variant={required ? 'primary' : 'danger'} busy={busy && !uncertain} disabled={!valid || blocked}>{required ? state.password_required ? 'Change password' : 'Set password' : 'Remove password'}</Button>
        {dirty && <Button size="md" disabled={blocked} onClick={() => { apply(state); setError(null); setNotice(null) }}>Cancel changes</Button>}
      </div>}
    </form> : !error && <p className="bp-note" role="status">Loading password settings…</p>}
    {notice && <div className="bp-callout bp-callout--info" role="status">{notice}</div>}
    {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
    {uncertain ? <Button size="md" variant="primary" onClick={() => window.location.reload()}>Reload to inspect password settings</Button>
      : (needsRefresh || !state) && <Button size="md" onClick={() => void refresh()}>Refresh password settings</Button>}
  </>
}
