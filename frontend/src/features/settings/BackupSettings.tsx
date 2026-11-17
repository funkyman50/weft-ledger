import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, KeyRound, Upload } from 'lucide-react'

import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import { Button } from '../../components/Button'
import { money } from '../../lib/money'
import { downloadFile } from '../../lib/download'
import { dateLabel } from '../ledger/transactionDisplay'

type KeyStatus = { password_required: boolean; recipient: string | null; key_id: string | null }
type KeyDraft = { recovery_key: string; recipient: string; key_id: string; previous_key_id: string | null }
type Preview = {
  digest: string; generation: string; key_id: string; created_at: string; provider_configuration_matches: boolean
  accounts: Array<{ id: number; name: string; working_balance_cents: number | null; latest_transaction_date: string | null }>
}

export function BackupSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: ['backup-status'], queryFn: ({ signal }) => apiClient.get<KeyStatus>('/api/system/backup/status', signal), retry: false })
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const uncertainRef = useRef(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [replacingKey, setReplacingKey] = useState(false)
  const [password, setPassword] = useState('')
  const [draft, setDraft] = useState<KeyDraft | null>(null)
  const [confirmedKey, setConfirmedKey] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [restorePassword, setRestorePassword] = useState('')

  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    onBusyChange(true)
    setError(null)
    setNotice(null)
    try { await work() } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'bad_password') await status.refetch()
      setError(apiErrorMessage(cause, 'The backup request could not be completed. Retry checks the saved key before making another change.'))
    }
    finally {
      busyRef.current = uncertainRef.current
      setBusy(uncertainRef.current)
      onBusyChange(uncertainRef.current)
    }
  }

  const readStatus = async () => {
    const value = await apiClient.get<KeyStatus>('/api/system/backup/status')
    queryClient.setQueryData(['backup-status'], value)
    return value
  }

  const clearSetup = () => { setDownloadOpen(false); setReplacingKey(false); setDraft(null); setConfirmedKey(''); setPassword(''); setError(null) }
  const clearRestore = () => { setFile(null); setRecoveryKey(''); setPreview(null); setRestorePassword(''); setError(null) }
  const startDownload = (replace: boolean) => { clearRestore(); clearSetup(); setNotice(null); setReplacingKey(replace); setDownloadOpen(true) }

  const downloadBackup = async (keyId: string) => {
    const result = await apiClient.postDownload('/api/system/backup', { password, key_id: keyId })
    const filename = result.filename ?? `weft-backup-${keyId}.age`
    downloadFile(result.blob, filename)
    clearSetup()
    setNotice(`Downloaded ${filename}. Preview it with its recovery key to check that it opens.`)
  }

  const prepareBackup = () => void run(async () => {
    const current = await readStatus()
    if (!current.key_id || replacingKey) {
      const key = await apiClient.providerPost<Omit<KeyDraft, 'previous_key_id'>>('/api/system/backup/key/new', { password })
      setDraft({ ...key, previous_key_id: current.key_id })
      setConfirmedKey('')
    } else await downloadBackup(current.key_id)
  })

  const confirmSetup = () => {
    if (!draft) return
    if (confirmedKey.trim() !== draft.recovery_key) { setError('Paste the saved recovery key exactly to confirm it.'); return }
    void run(async () => {
      let current = await readStatus()
      if (current.recipient !== draft.recipient) {
        if (current.key_id !== draft.previous_key_id) { setError('The backup key changed in another session. Cancel and reopen setup.'); return }
        try {
          current = await apiClient.providerPost<KeyStatus>('/api/system/backup/key', { password, recovery_key: confirmedKey.trim(), expected_key_id: draft.previous_key_id })
        } catch (cause) {
          current = await readStatus()
          if (current.recipient !== draft.recipient) throw cause
        }
      }
      queryClient.setQueryData(['backup-status'], current)
      setDraft(null)
      setConfirmedKey('')
      setReplacingKey(false)
      await downloadBackup(draft.key_id)
    })
  }

  const selectFile = (value: File | null) => {
    clearSetup()
    clearRestore()
    setNotice(null)
    if (value && value.size > 256 * 1024 * 1024) { setError('Backup files must be 256 MB or smaller.'); return }
    setFile(value)
  }

  const previewBackup = () => void run(async () => {
    if (!file || !recoveryKey.trim()) { setError('Choose a backup and enter its recovery key.'); return }
    const form = new FormData()
    form.append('backup', file)
    form.append('recovery_key', recoveryKey.trim())
    setPreview(await apiClient.postMultipart<Preview>('/api/system/restore/preview', form))
    setRestorePassword('')
  })

  const restoreBackup = () => void run(async () => {
    if (!file || !preview || (status.data?.password_required !== false && !restorePassword)) return
    const form = new FormData()
    form.append('backup', file)
    form.append('recovery_key', recoveryKey.trim())
    form.append('digest', preview.digest)
    form.append('generation', preview.generation)
    form.append('password', restorePassword)
    try {
      await apiClient.postMultipart('/api/system/restore', form)
      clearRestore()
      window.location.reload()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) {
        if (cause.code === 'bad_password') await status.refetch()
        setError(cause.message)
        if (cause.code === 'restore_preview_stale') { setPreview(null); setRestorePassword('') }
      } else {
        uncertainRef.current = true
        setUncertain(true)
        setRecoveryKey('')
        setRestorePassword('')
        setError(`${apiErrorMessage(cause, 'The restore result could not be confirmed.')} Reload to inspect the current database before trying another restore.`)
      }
    }
  })

  const passwordRequired = status.data?.password_required !== false
  const keyId = status.data?.key_id
  const setupTitle = replacingKey ? 'Replace recovery key' : keyId ? 'Download backup' : 'Set up backups'
  const setupIntro = replacingKey ? 'A new key protects future backups. Older backups still need their original key.' : keyId ? passwordRequired ? 'Confirm your Weft password to download an encrypted backup.' : 'Download an encrypted backup with your saved recovery key.' : passwordRequired ? 'Your first backup creates a recovery key. Confirm your Weft password to begin.' : 'Your first backup creates a recovery key. Continue to save it before downloading.'

  return <>
    <div className="bp-backup-cards">
      <section className={`bp-backup-card${downloadOpen ? ' is-active' : ''}`} aria-labelledby="system-backup-title">
        <h3 id="system-backup-title" className="bp-backup-card-title"><span className="bp-backup-card-icon"><Download aria-hidden="true" /></span>Download backup</h3>
        <p className="bp-note">An encrypted copy of your accounts, transactions, settings and bank connections, up to 256 MB.</p>
        {status.isError ? <p className="bp-backup-key">Backup settings could not be loaded.<Button size="sm" disabled={busy} onClick={() => void status.refetch()}>Retry</Button></p>
          : status.data && <p className="bp-backup-key"><KeyRound aria-hidden="true" />{keyId ? <>Recovery key <strong>{keyId}</strong></> : 'No recovery key yet. Your first backup creates one.'}</p>}
        <div className="bp-backup-card-actions">
          {keyId && <Button size="md" variant="quiet" disabled={busy || downloadOpen} onClick={() => startDownload(true)}>Replace key…</Button>}
          <Button size="md" disabled={busy || !status.data || downloadOpen} onClick={() => startDownload(false)}>Download backup…</Button>
        </div>
      </section>
      <section className={`bp-backup-card${file ? ' is-active' : ''}`} aria-labelledby="system-restore-title">
        <h3 id="system-restore-title" className="bp-backup-card-title"><span className="bp-backup-card-icon"><Upload aria-hidden="true" /></span>Restore from backup</h3>
        <p className="bp-note">Replace all Weft data with an encrypted .age backup. You review its accounts before anything changes. No key setup is needed to restore.</p>
        <input ref={fileInput} hidden type="file" accept=".age,application/octet-stream" onChange={(event) => { selectFile(event.target.files?.[0] ?? null); event.target.value = '' }} />
        <div className="bp-backup-card-actions"><Button size="md" disabled={busy} onClick={() => fileInput.current?.click()}>{file ? 'Choose another backup…' : 'Choose backup…'}</Button></div>
      </section>
    </div>
    {downloadOpen && !draft && <section className="bp-backup-panel" aria-labelledby="system-setup-title">
      <div className="bp-backup-panel-head"><strong id="system-setup-title">{setupTitle}</strong></div>
      <p className="bp-note">{setupIntro}</p>
      <form className="bp-backup-row" onSubmit={(event) => { event.preventDefault(); prepareBackup() }}>
        {passwordRequired && <label className="bp-field">Weft password<input className="bp-control" type="password" autoComplete="current-password" autoFocus value={password} disabled={busy} onChange={(event) => { setPassword(event.target.value); setError(null) }} /></label>}
        <div className="bp-button-group"><Button size="md" disabled={busy} onClick={clearSetup}>Cancel</Button><Button type="submit" size="md" variant="primary" busy={busy} disabled={passwordRequired && !password}>{replacingKey || !keyId ? 'Continue' : 'Download backup'}</Button></div>
      </form>
    </section>}
    {draft && <form className="bp-backup-panel" aria-labelledby="system-key-title" onSubmit={(event) => { event.preventDefault(); confirmSetup() }}>
      <div className="bp-backup-panel-head"><strong id="system-key-title">{replacingKey ? 'Save your new recovery key' : 'Save your recovery key'}</strong><span>Key {draft.key_id}</span></div>
      <p className="bp-note">Only this key can open backups made with it. Weft keeps just its public half. Store the key apart from your backups and off this machine. If both this machine and the key are lost, those backups can’t be recovered.</p>
      <ol className="bp-backup-steps">
        <li>
          <strong className="bp-backup-step-title">Save the key</strong>
          <div className="bp-backup-key-box">
            <textarea className="bp-control" rows={2} readOnly aria-label="Recovery key" value={draft.recovery_key} autoComplete="off" spellCheck={false} />
            <Button size="md" disabled={busy} onClick={() => downloadFile(new Blob([`${draft.recovery_key}\n`], { type: 'text/plain' }), `weft-recovery-key-${draft.key_id}.txt`)}><Download aria-hidden="true" />Save key file</Button>
          </div>
        </li>
        <li>
          <label className="bp-backup-step-title" htmlFor="system-confirm-key">Paste it back to confirm</label>
          <input id="system-confirm-key" className="bp-control" type="password" autoComplete="off" value={confirmedKey} disabled={busy} onChange={(event) => { setConfirmedKey(event.target.value); setError(null) }} />
        </li>
      </ol>
      <div className="bp-backup-panel-foot">
        <p className="bp-note">{replacingKey ? 'Older backups still need their old key. Keep it until a new backup passes a restore preview.' : 'Later backups use this recovery key and ask for your Weft password when one is enabled.'}</p>
        <div className="bp-button-group"><Button size="md" disabled={busy} onClick={clearSetup}>Cancel</Button><Button type="submit" size="md" variant="primary" busy={busy} disabled={!confirmedKey}>Confirm and download backup</Button></div>
      </div>
    </form>}
    {file && <section className="bp-backup-panel" aria-labelledby="system-review-title">
      <div className="bp-backup-panel-head"><strong id="system-review-title">Review backup</strong><span title={file.name}>{file.name}</span></div>
      {!preview ? <form className="bp-backup-row" onSubmit={(event) => { event.preventDefault(); previewBackup() }}>
        <label className="bp-field">Recovery key for this backup<input className="bp-control" type="password" autoComplete="off" autoFocus value={recoveryKey} disabled={busy} onChange={(event) => { setRecoveryKey(event.target.value); setError(null) }} /></label>
        <div className="bp-button-group"><Button size="md" disabled={busy} onClick={clearRestore}>Cancel</Button><Button type="submit" size="md" variant="primary" busy={busy} disabled={!recoveryKey.trim()}>Preview backup</Button></div>
      </form> : <>
        <p className="bp-note">Created {new Date(preview.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} with recovery key <strong>{preview.key_id}</strong></p>
        {preview.accounts.length === 0 ? <p className="bp-note">This backup has no accounts.</p> : <table className="bp-backup-table">
          <thead><tr><th scope="col">Account</th><th scope="col" className="is-number">Working balance</th><th scope="col">Latest transaction</th></tr></thead>
          <tbody>{preview.accounts.map((account) => <tr key={account.id}><td>{account.name}</td><td className={`is-number${(account.working_balance_cents ?? 0) < 0 ? ' is-negative' : ''}`}>{account.working_balance_cents === null ? 'Not initialized' : money(account.working_balance_cents)}</td><td className="is-date">{account.latest_transaction_date ? dateLabel(account.latest_transaction_date) : 'No transactions'}</td></tr>)}</tbody>
        </table>}
        {!preview.provider_configuration_matches && <div className="bp-callout bp-callout--info"><p>This installation’s bank configuration is missing or differs from the backup’s. Financial data restores normally, but bank connections may need matching configuration, repair or reconnection.</p></div>}
        <div className="bp-callout bp-callout--warning"><strong>Restoring replaces all current data</strong><p>Changes made after this backup will be lost. Weft keeps a private safety copy first. Bank sync stays paused until you press Sync Plaid. A working key proves the file is intact, not who made it, so check these accounts before you continue.</p></div>
        <form className="bp-backup-row" onSubmit={(event) => { event.preventDefault(); restoreBackup() }}>
          {passwordRequired && <label className="bp-field">Weft password<input className="bp-control" type="password" autoComplete="current-password" autoFocus value={restorePassword} disabled={busy} onChange={(event) => { setRestorePassword(event.target.value); setError(null) }} /></label>}
          <div className="bp-button-group"><Button size="md" disabled={busy} onClick={clearRestore}>Cancel</Button><Button type="submit" size="md" variant="danger" busy={busy} disabled={passwordRequired && !restorePassword}>Replace database</Button></div>
        </form>
      </>}
    </section>}
    {notice && <div className="bp-callout bp-callout--info" role="status">{notice}</div>}
    {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
    {uncertain && <div><Button size="md" variant="primary" onClick={() => window.location.reload()}>Reload to inspect restored data</Button></div>}
    <p className="bp-note">Keep a recent backup off this machine, with its recovery key stored separately. Preview each new backup with its key, and take a new backup after a schema upgrade. Login passwords, Plaid API credentials, OpenAI settings and browser preferences aren’t included. Without a login password, other accounts and programs on this computer can also change recovery-key settings.</p>
  </>
}
