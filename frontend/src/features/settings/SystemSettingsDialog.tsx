import { useState } from 'react'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { Modal } from '../../components/Modal'
import { Switch } from '../../components/Switch'
import { apiClient } from '../../api/client'
import { downloadDiagnostics } from '../../lib/diagnostics'
import { OpenAISettings } from './OpenAISettings'
import { BackupSettings } from './BackupSettings'
import { PlaidSettings } from './PlaidSettings'
import { PasswordSettings } from './PasswordSettings'

export function SystemSettingsDialog({
  highlightBankDifferences,
  onHighlightBankDifferencesChange,
  showAccountIcons,
  onShowAccountIconsChange,
  compactMode,
  onCompactModeChange,
  showNewTransaction,
  onShowNewTransactionChange,
  reviewAfterEdit,
  onReviewAfterEditChange,
  onClose,
}: {
  highlightBankDifferences: boolean
  onHighlightBankDifferencesChange: (enabled: boolean) => void
  showAccountIcons: boolean
  onShowAccountIconsChange: (enabled: boolean) => void
  compactMode: boolean
  onCompactModeChange: (enabled: boolean) => void
  showNewTransaction: boolean
  onShowNewTransactionChange: (enabled: boolean) => void
  reviewAfterEdit: boolean
  onReviewAfterEditChange: (enabled: boolean) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'display' | 'behavior' | 'security' | 'ai' | 'plaid' | 'backup' | 'diagnostics'>('display')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [plaidBusy, setPlaidBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false)
  const [diagnosticsNotice, setDiagnosticsNotice] = useState<string | null>(null)
  const busy = backupBusy || aiBusy || plaidBusy || passwordBusy

  const downloadReport = async () => {
    setDiagnosticsBusy(true)
    setDiagnosticsNotice(null)
    try {
      const report = await apiClient.get<{ storage: string }>('/api/system/diagnostics', AbortSignal.timeout(10_000))
      downloadDiagnostics(report)
      setDiagnosticsNotice(report.storage === 'available' ? 'Server and browser diagnostics downloaded.' : 'Diagnostics downloaded. Server log storage is unavailable; the report includes available recent events.')
    } catch {
      downloadDiagnostics()
      setDiagnosticsNotice('Server diagnostics weren’t available. Browser-only diagnostics downloaded.')
    } finally {
      setDiagnosticsBusy(false)
    }
  }

  return (
    <Modal size="lg" labelledBy="system-settings-title" onRequestClose={() => { if (!busy) onClose() }}>
      <DialogHeader titleId="system-settings-title" title="System settings" onClose={onClose} closeDisabled={busy} className="bp-dialog-header--tabbed" />
      <div className="bp-system-tabs">
        <div className="bp-tabs" role="tablist" aria-label="System settings sections">
          <button type="button" role="tab" id="system-tab-display" aria-controls={tab === 'display' ? 'system-panel-display' : undefined} aria-selected={tab === 'display'} className={tab === 'display' ? 'is-active' : undefined} disabled={busy} onClick={() => setTab('display')}>Display</button>
          <button type="button" role="tab" id="system-tab-behavior" aria-controls={tab === 'behavior' ? 'system-panel-behavior' : undefined} aria-selected={tab === 'behavior'} className={tab === 'behavior' ? 'is-active' : undefined} disabled={busy} onClick={() => setTab('behavior')}>Behavior</button>
          <button type="button" role="tab" id="system-tab-security" aria-controls={tab === 'security' ? 'system-panel-security' : undefined} aria-selected={tab === 'security'} className={tab === 'security' ? 'is-active' : undefined} disabled={busy} onClick={() => setTab('security')}>Security</button>
          <button type="button" role="tab" id="system-tab-ai" aria-controls={tab === 'ai' ? 'system-panel-ai' : undefined} aria-selected={tab === 'ai'} className={tab === 'ai' ? 'is-active' : undefined} disabled={busy} onClick={() => setTab('ai')}>AI</button>
          <button type="button" role="tab" id="system-tab-plaid" aria-controls={tab === 'plaid' ? 'system-panel-plaid' : undefined} aria-selected={tab === 'plaid'} className={tab === 'plaid' ? 'is-active' : undefined} disabled={busy} onClick={() => setTab('plaid')}>Plaid</button>
          <button type="button" role="tab" id="system-tab-backup" aria-controls={tab === 'backup' ? 'system-panel-backup' : undefined} aria-selected={tab === 'backup'} className={tab === 'backup' ? 'is-active' : undefined} disabled={busy} onClick={() => setTab('backup')}>Backup &amp; restore</button>
          <button type="button" role="tab" id="system-tab-diagnostics" aria-controls={tab === 'diagnostics' ? 'system-panel-diagnostics' : undefined} aria-selected={tab === 'diagnostics'} className={tab === 'diagnostics' ? 'is-active' : undefined} disabled={busy} onClick={() => setTab('diagnostics')}>Diagnostics</button>
        </div>
      </div>
      {tab === 'display' ? <div className="bp-dialog-body" role="tabpanel" id="system-panel-display" aria-labelledby="system-tab-display">
        <p className="bp-note">Stored in this browser only. Changes apply immediately.</p>
        <div className="bp-dialog-section">
          <div className="bp-account-settings-row">
            <div>
              <strong>Show new transaction after saving</strong>
              <small>Scroll to the saved transaction and briefly highlight it when it is in the loaded view. Keep your filters and sort order.</small>
            </div>
            <Switch label="Show new transaction after saving" checked={showNewTransaction} onChange={onShowNewTransactionChange} />
          </div>
        </div>
        <div className="bp-dialog-section">
          <div className="bp-account-settings-row">
            <div>
              <strong>Show account icons</strong>
              <small>Show account icons and bank logos in the account list, including All Accounts.</small>
            </div>
            <Switch label="Show account icons" checked={showAccountIcons} onChange={onShowAccountIconsChange} />
          </div>
        </div>
        <div className="bp-dialog-section">
          <div className="bp-account-settings-row">
            <div>
              <strong>Highlight bank differences</strong>
              <small>Show a warning triangle and yellow background on accounts whose cleared balance differs from the bank-reported balance.</small>
            </div>
            <Switch label="Highlight bank differences" checked={highlightBankDifferences} onChange={onHighlightBankDifferencesChange} />
          </div>
        </div>
        <div className="bp-dialog-section">
          <div className="bp-account-settings-row">
            <div>
              <strong>Compact mode</strong>
              <small>Show each account on one line in the account list. Hover an account to see its type.</small>
            </div>
            <Switch label="Compact mode" checked={compactMode} onChange={onCompactModeChange} />
          </div>
        </div>
      </div> : tab === 'behavior' ? <div className="bp-dialog-body" role="tabpanel" id="system-panel-behavior" aria-labelledby="system-tab-behavior">
        <p className="bp-note">Stored in this browser only. Changes apply to future saves.</p>
        <div className="bp-account-settings-row">
          <div>
            <strong>Mark reviewed when I edit a bank transaction</strong>
            <small>Saving a Payee, Category or Memo change on a bank transaction that needs review also marks it Reviewed. This includes saves when you leave the row.</small>
          </div>
          <Switch label="Mark reviewed when I edit a bank transaction" checked={reviewAfterEdit} onChange={onReviewAfterEditChange} />
        </div>
        <p className="bp-note">Applies to individual bank transactions only. Pending and split warnings remain independent.</p>
      </div> : tab === 'security' ? <div className="bp-dialog-body" role="tabpanel" id="system-panel-security" aria-labelledby="system-tab-security">
        <PasswordSettings onBusyChange={setPasswordBusy} />
      </div> : tab === 'ai' ? <div className="bp-dialog-body" role="tabpanel" id="system-panel-ai" aria-labelledby="system-tab-ai">
        <OpenAISettings onBusyChange={setAiBusy} />
      </div> : tab === 'plaid' ? <div className="bp-dialog-body" role="tabpanel" id="system-panel-plaid" aria-labelledby="system-tab-plaid">
        <PlaidSettings onBusyChange={setPlaidBusy} />
      </div> : tab === 'backup' ? <div className="bp-dialog-body" role="tabpanel" id="system-panel-backup" aria-labelledby="system-tab-backup">
        <BackupSettings onBusyChange={setBackupBusy} />
      </div> : <div className="bp-dialog-body" role="tabpanel" id="system-panel-diagnostics" aria-labelledby="system-tab-diagnostics">
        <p className="bp-note">Download recent server events and this page’s browser events to help investigate a failure. Reports include error codes, request references, timing, and stack locations without credentials, account details, or financial values.</p>
        <p className="bp-note">Server logs have a size limit. Browser events disappear on reload. Nothing is uploaded automatically; keep the downloaded report private.</p>
        <div className="bp-dialog-section"><Button size="lg" busy={diagnosticsBusy} disabled={diagnosticsBusy} onClick={() => void downloadReport()}>{diagnosticsBusy ? 'Preparing diagnostics…' : 'Download diagnostics'}</Button></div>
        {diagnosticsNotice && <p className="bp-note" role="status">{diagnosticsNotice}</p>}
      </div>}
      <div className="bp-dialog-footer"><Button size="lg" variant="primary" disabled={busy} onClick={onClose}>Close</Button></div>
    </Modal>
  )
}
