import { accountInScope, type AccountScope } from '../../lib/accountScope'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Download } from 'lucide-react'

import { ApiError, apiClient } from '../../api/client'
import { localDate } from '../../lib/date'
import { downloadFile } from '../../lib/download'
import type { Account } from '../../api/types'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'

type DateRange = 'all' | 'this-month' | 'last-month' | 'this-year' | 'last-year' | 'custom'

const dateOptions = [
  { value: 'all', label: 'All dates' },
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'this-year', label: 'This year' },
  { value: 'last-year', label: 'Last year' },
  { value: 'custom', label: 'Custom range' },
]

const splitOptions = [
  { value: 'transaction', label: 'One row per transaction' },
  { value: 'category', label: 'One row per category' },
]


function presetBounds(range: DateRange): { date_from?: string; date_to?: string } {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  if (range === 'all' || range === 'custom') return {}
  if (range === 'this-month') return { date_from: localDate(new Date(year, month, 1)), date_to: localDate(new Date(year, month + 1, 0)) }
  if (range === 'last-month') return { date_from: localDate(new Date(year, month - 1, 1)), date_to: localDate(new Date(year, month, 0)) }
  if (range === 'this-year') return { date_from: localDate(new Date(year, 0, 1)), date_to: localDate(new Date(year, 11, 31)) }
  return { date_from: localDate(new Date(year - 1, 0, 1)), date_to: localDate(new Date(year - 1, 11, 31)) }
}

export function ExportDialog({ accounts, currentAccountId, onClose }: { accounts: Account[]; currentAccountId: AccountScope; onClose: () => void }) {
  const [includeHistory, setIncludeHistory] = useState(true)
  const [includeSchedules, setIncludeSchedules] = useState(false)
  const [selected, setSelected] = useState(() => new Set(accounts.filter((account) => accountInScope(account, currentAccountId)).map((account) => account.id)))
  const [dateRange, setDateRange] = useState<DateRange>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [includePending, setIncludePending] = useState(true)
  const [splitMode, setSplitMode] = useState<'transaction' | 'category'>('transaction')
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const allSelected = selected.size === accounts.length
  const allToggle = useRef<HTMLInputElement>(null)
  const someSelected = selected.size > 0 && !allSelected
  useEffect(() => { if (allToggle.current) allToggle.current.indeterminate = someSelected }, [someSelected])
  const accountIds = useMemo(() => accounts.filter((account) => selected.has(account.id)).map((account) => account.id), [accounts, selected])

  const toggleAccount = (accountId: number) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
    setError(null)
  }

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(accounts.map((account) => account.id)))
    setError(null)
  }

  const submit = async () => {
    if (!includeHistory && !includeSchedules) {
      setError('Choose at least one export type.')
      return
    }
    if (accountIds.length === 0) {
      setError('Choose at least one account.')
      return
    }
    const bounds = !includeHistory ? {} : dateRange === 'custom'
      ? dateFrom && dateTo ? { date_from: dateFrom, date_to: dateTo } : null
      : presetBounds(dateRange)
    if (bounds === null) {
      setError('Enter both dates for a custom range.')
      return
    }
    if (bounds.date_from && bounds.date_to && bounds.date_from > bounds.date_to) {
      setError('The end date must be on or after the start date.')
      return
    }
    setError(null)
    setExporting(true)
    try {
      const { blob, filename } = await apiClient.postDownload('/api/exports', {
        account_ids: accountIds,
        include_history: includeHistory,
        include_schedules: includeSchedules,
        ...(includeHistory ? { include_pending: includePending, split_mode: splitMode, ...bounds } : {}),
      })
      downloadFile(blob, filename ?? (includeHistory && includeSchedules ? 'weft-export.zip' : includeHistory ? 'weft-transactions.csv' : 'weft-schedules.csv'))
      onClose()
    } catch (downloadError) {
      setError(downloadError instanceof ApiError ? downloadError.message : 'The export could not be downloaded. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  return <Modal size="lg" labelledBy="export-dialog-title" extraFocusSelector=".bp-filter-select-popover button:not(:disabled), .bp-filter-select-popover input:not(:disabled)" onRequestClose={() => { if (!exporting) onClose() }}>
    <DialogHeader titleId="export-dialog-title" title="Export" subtitle="Download transaction history, saved schedules, or both." closeDisabled={exporting} onClose={onClose} />
    <div className="bp-dialog-body">
      <div className="bp-export-body">
        <section aria-labelledby="export-accounts-title">
          <div className="bp-dialog-section-heading"><strong id="export-accounts-title">Accounts</strong><label className="bp-check"><input ref={allToggle} type="checkbox" checked={allSelected} disabled={exporting || accounts.length === 0} onChange={toggleAll} />All accounts</label></div>
          <div className="bp-list bp-list--scroll">
            {accounts.map((account) => <label className="bp-list-row" key={account.id}><input type="checkbox" checked={selected.has(account.id)} disabled={exporting} onChange={() => toggleAccount(account.id)} /><span>{account.name}</span>{account.closed && <small>Closed</small>}</label>)}
          </div>
        </section>
        <section aria-labelledby="export-include-title">
          <div className="bp-dialog-section-heading"><strong id="export-include-title">Include</strong></div>
          <label className={`bp-export-type${includeHistory ? ' is-selected' : ''}`}>
            <input type="checkbox" checked={includeHistory} disabled={exporting} onChange={(event) => { setIncludeHistory(event.target.checked); setError(null) }} />
            <span><strong>Transaction History</strong><small>Saved transactions with each account’s running balance.</small></span>
          </label>
          <label className={`bp-export-type${includeSchedules ? ' is-selected' : ''}`}>
            <input type="checkbox" checked={includeSchedules} disabled={exporting} onChange={(event) => { setIncludeSchedules(event.target.checked); setError(null) }} />
            <span><strong>Scheduled Transactions</strong><small>One row per saved schedule, including paused ones. A transfer schedule appears once, under its owning account, with the destination in Transfer account.</small></span>
          </label>
          {includeHistory && <div className="bp-dialog-section">
            <div className="bp-dialog-section-heading"><strong>Transaction History options</strong></div>
            <label className="bp-field">Date range
              <FilterSelect ariaLabel="Date range" value={dateRange} options={dateOptions} autoFocus={false} disabled={exporting} onChange={(value) => { setDateRange(value as DateRange); setError(null) }} />
            </label>
            {dateRange === 'custom' && <div className="bp-field-grid bp-field-grid--even">
              <label className="bp-field">From<input className="bp-control" type="date" value={dateFrom} disabled={exporting} onChange={(event) => { setDateFrom(event.target.value); setError(null) }} /></label>
              <label className="bp-field">To<input className="bp-control" type="date" value={dateTo} disabled={exporting} onChange={(event) => { setDateTo(event.target.value); setError(null) }} /></label>
            </div>}
            <label className="bp-field">Split representation
              <FilterSelect ariaLabel="Split representation" value={splitMode} options={splitOptions} autoFocus={false} disabled={exporting} onChange={(value) => { setSplitMode(value as typeof splitMode); setError(null) }} />
            </label>
            <div className="bp-export-check">
              <label className="bp-check"><input type="checkbox" checked={includePending} disabled={exporting} aria-describedby="export-pending-help" onChange={(event) => { setIncludePending(event.target.checked); setError(null) }} />Include bank-pending transactions</label>
              <p id="export-pending-help" className="bp-field-hint">When off, manually cleared transactions that are still pending at the bank are also left out, even though they count in Cleared.</p>
            </div>
            <p className="bp-field-hint">Balance always uses full account history, even when dates or pending transactions are left out. Split category rows repeat the balance after the whole transaction.</p>
          </div>}
        </section>
      </div>
      {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
    </div>
    <div className="bp-dialog-footer">
      <p className="bp-dialog-footer-start bp-note">{includeHistory && includeSchedules ? 'Downloads one ZIP containing both CSVs.' : includeHistory || includeSchedules ? 'Downloads one CSV. Select both types to get a ZIP.' : 'Select at least one type to export.'}</p>
      <Button size="lg" disabled={exporting} onClick={onClose}>Cancel</Button>
      <Button size="lg" variant="primary" busy={exporting} onClick={() => void submit()}><Download aria-hidden="true" />{exporting ? 'Exporting…' : 'Export'}</Button>
    </div>
  </Modal>
}
