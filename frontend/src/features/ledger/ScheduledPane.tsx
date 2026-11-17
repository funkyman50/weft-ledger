import { accountInScope, isCombinedScope, type AccountScope } from '../../lib/accountScope'
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft, ArrowUpFromDot, CalendarPlus, Check, ChevronDown, ChevronRight, ChevronUp, Ghost, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, apiClient } from '../../api/client'
import { localDate } from '../../lib/date'
import { invalidateAccountAndTransactionQueries, useCreatePayee } from '../../api/hooks'
import type { Account, CategoryTree, LedgerHistoryInspection, LedgerRow, Payee, ScheduleBatchRequest, ScheduleBulkChanges, ScheduleDefinition, ScheduleFrequency, ScheduleLookAhead, SchedulePage, ScheduledTransaction } from '../../api/types'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { ActionMenu, ActionMenuItem } from '../../components/ActionMenu'
import { STAGED_CHANGES_NOTICE } from './LedgerBulkControls'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import { usePickerPosition } from '../../components/pickerPosition'
import { money } from '../../lib/money'
import { isComposingKey, navigateActionMenu } from '../../lib/keyboard'
import { LedgerAmountInput, LedgerEditorActions, LedgerCategoryPicker, LedgerDatePicker, LedgerDirectionalAmountInput, LedgerMemoInput, LedgerOptionPicker, LedgerTransferPicker, NewEntryExitDialog } from './LedgerEditors'
import { clickedLedgerCell, enterLedgerCell, focusEntryField, focusNextLedgerCell, useCleanEditorDismiss, useEditorClickAway } from './ledgerFocus'
import { ScheduledBulkToolbar } from './ScheduledBulkToolbar'
import { nativeLedgerShortcutOwner } from './useLedgerHistory'
import { TransferPopover } from './TransferPopover'
import { SCHEDULE_FREQUENCIES, scheduleFrequencyLabel } from './scheduleFrequency'
import { emptyCell as stub, transferDirection } from './transactionDisplay'
import { canAutofillPayeeCategory, ledgerPayeeOptions, payeeEntryCategory } from './payeeCategory'
import { newEntryIssues, parseLedgerAmount, useNewEntryExit, validEntryDate, type EditorCompletion } from './useLedgerEditor'
import { isRowControl, rowKeyAction, selectRowIds, selectionGesture, type SelectionGesture } from './ledgerSelection'

const LOOK_AHEAD_OPTIONS: { value: ScheduleLookAhead; label: string }[] = [
  { value: 'off', label: 'Off' }, { value: 'end_of_month', label: 'End of month' },
  { value: '4_weeks', label: '4 weeks' }, { value: '12_weeks', label: '12 weeks' },
]

const PROJECTED_BALANCE_DESCRIPTION = 'Working balance after this occurrence, including entered transactions and remaining schedules.'

function lookAheadThrough(today: string, lookAhead: ScheduleLookAhead): string | null {
  if (lookAhead === 'off') return null
  const [year, month, day] = today.split('-').map(Number)
  const through = lookAhead === 'end_of_month' ? Date.UTC(year, month, 0) : Date.UTC(year, month - 1, day + (lookAhead === '4_weeks' ? 28 : 84))
  return new Date(through).toISOString().slice(0, 10)
}

type Draft = { definition: ScheduleDefinition; amount: string; tolerance: string; original: ScheduledTransaction | null; baseline?: ScheduleDefinition; categoryProtected?: boolean; categoryAutofilled?: boolean; payeeSuggestionKey?: string; entryOrigin?: 'schedule' | 'transfer'; chooseAccountFirst?: boolean; entryColumn?: string }
type RowMenu = { row: ScheduledTransaction; left: number; top: number; origin: HTMLElement }
export type ScheduleGuard = { blocked: boolean; blockedReason?: string; recoveryOwned: boolean; newEntry?: boolean; existingEntry?: boolean; dismissible?: boolean; requestLeave?: () => Promise<EditorCompletion> }

function scheduleRowKey(row: ScheduledTransaction): string { return `${row.id}${row.mirror ? '-mirror' : ''}` }

function definitionFromRow(row: ScheduledTransaction): ScheduleDefinition {
  return { account_id: row.account_id, next_date: row.next_date, frequency: row.frequency, anchor_day: row.anchor_day, payee_id: row.payee_id, transfer_account_id: row.transfer_account_id, category_id: row.category_id, memo: row.memo, amount_cents: row.amount_cents, match_tolerance_cents: row.match_tolerance_cents, end_date: row.end_date }
}

const TOLERANCE_TITLE = 'Maximum dollar difference for matching the same Payee. Zero requires an exact amount.'

function hasScheduleWork({ definition, amount, tolerance, original, baseline }: Draft): boolean {
  if (original) return parseLedgerAmount(tolerance) !== original.match_tolerance_cents || parseLedgerAmount(amount) !== original.amount_cents || Object.entries(definitionFromRow(original)).some(([key, value]) => definition[key as keyof ScheduleDefinition] !== value)
  return !baseline || Boolean(amount.trim() || parseLedgerAmount(tolerance) !== 0 || definition.payee_id !== null || definition.transfer_account_id !== null || definition.category_id !== null || definition.memo.trim() || definition.next_date !== baseline.next_date || definition.account_id !== baseline.account_id || definition.frequency !== baseline.frequency || definition.end_date !== baseline.end_date)
}

export function ScheduledPane({ accountId, accounts, payees, categories, page, loadError, visible, height, lookAhead, onLookAheadChange, showProjectedBalance, onProjectedBalanceChange, balancePending, blocked, separateAmountColumns, seed, onSeedConsumed, onToggle, onHeightChange, onGuardChange, onNotice, onInspect, onEntered, onRefresh, onOpenAccount, onEditPayee, formatDate, canRequestEntry, onRequestWorkspaceAction, selectionSlot, registerSelected, onSelectionChange }: {
  accountId: AccountScope
  accounts: Account[]
  payees: Payee[]
  categories: CategoryTree[]
  page?: SchedulePage
  loadError: boolean
  visible: boolean
  height: number
  lookAhead: ScheduleLookAhead
  onLookAheadChange: (value: ScheduleLookAhead) => void
  showProjectedBalance: boolean
  onProjectedBalanceChange: (value: boolean) => void
  balancePending: boolean
  blocked: boolean
  canRequestEntry: boolean
  onRequestWorkspaceAction: (action: () => void) => void
  selectionSlot: HTMLElement | null
  registerSelected: boolean
  onSelectionChange: (selected: boolean) => void
  separateAmountColumns: boolean
  seed: ScheduleDefinition | null
  onSeedConsumed: () => void
  onToggle: () => void
  onHeightChange: (height: number, persist?: boolean) => void
  onGuardChange: (guard: ScheduleGuard) => void
  onNotice: (message: string) => void
  onInspect: () => Promise<LedgerHistoryInspection>
  onEntered: (row: LedgerRow) => Promise<unknown>
  onRefresh: () => Promise<unknown>
  onOpenAccount: (accountId: number) => void
  onEditPayee: (id: number) => void
  formatDate: (value: string) => string
}) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<{ saved: boolean; selectionToClear: string | null } | null>(null)
  const [createPending, setCreatePending] = useState(false)
  const [createRecovery, setCreateRecovery] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const createPendingRef = useRef(false)
  const createRecoveryRef = useRef(false)
  const [deleting, setDeleting] = useState<ScheduledTransaction | null>(null)
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const selectedRef = useRef(selectedKeys)
  const anchorKey = useRef<string | null>(null)
  const [bulkChanges, setBulkChanges] = useState<ScheduleBulkChanges>({})
  const [bulkConfirmation, setBulkConfirmation] = useState<{ payload: ScheduleBatchRequest; title: string; copy: string; message: string } | null>(null)
  const hasBulkChanges = Object.keys(bulkChanges).length > 0
  const writeSelection = (keys: Set<string>) => { selectedRef.current = keys; setSelectedKeys(keys); if (!keys.size) { anchorKey.current = null; setBulkChanges({}) } }
  const clearSelection = () => writeSelection(new Set())
  const finishSelection = (key: string | null) => {
    if (key === 'all') { clearSelection(); setBulkConfirmation(null) }
    else if (key !== null) writeSelection(new Set([...selectedRef.current].filter((selected) => selected !== key)))
  }
  const dismissMenu = useCallback(() => setMenu(null), [])
  const [duplicate, setDuplicate] = useState<string | null>(null)
  const entryExit = useNewEntryExit(() => onNotice('Wait for the current update or inspect its result first.'))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const busyRef = useRef(false)
  const lockedRef = useRef(false)
  const duplicateResolve = useRef<((confirmed: boolean) => void) | null>(null)
  const leaveRef = useRef<() => Promise<EditorCompletion>>(() => Promise.resolve('retained'))
  const requestLeave = useCallback(() => leaveRef.current(), [])
  const draftRowRef = useRef<HTMLTableRowElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const draftKey = draft ? draft.original?.id ?? 'new' : null
  const queryClient = useQueryClient()
  const createPayee = useCreatePayee()
  const eligible = accounts.filter((account) => !account.closed && (!account.plaid_connection || account.starting_balance_initialized_at !== null))
  const eligibleSources = eligible.filter((account) => accountInScope(account, accountId))
  const sourceOptions = draft?.original ? eligible : eligible.filter((account) => accountInScope(account, accountId) || account.id === draft?.definition.account_id)
  const previewThrough = page ? lookAheadThrough(page.today, lookAhead) : null
  const balanceVisible = showProjectedBalance && previewThrough !== null && page?.projected_balance_available === true
  const balanceCell = (row: ScheduledTransaction) => {
    const cents = !pending && !recovery && !balancePending && !loadError && previewThrough !== null && row.next_date <= previewThrough ? row.projected_balance_cents : null
    return balanceVisible && <td data-column="projected_balance_cents">{cents !== null && <span className={`bp-amount ${cents < 0 ? 'is-negative' : 'is-positive'}`} title={money(cents, true)}>{money(cents, true)}</span>}</td>
  }
  const displayRows = (page?.rows ?? []).filter((row) => !row.ghost || (previewThrough !== null && row.next_date <= previewThrough))
  const rows = displayRows.filter((row) => !row.ghost)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const tabRowKey = rows.some((row) => scheduleRowKey(row) === focusedRowKey) ? focusedRowKey : rows[0] ? scheduleRowKey(rows[0]) : null
  const selectedRows = rows.filter((row) => !row.mirror && selectedKeys.has(scheduleRowKey(row)))
  const commonDestinations = accounts.filter((account) => selectedRows.length > 0 && selectedRows.every((row) => page?.move_account_ids[row.id]?.includes(account.id)))
  const locallyLocked = pending || recovery !== null || createPending || createRecovery
  const locked = locallyLocked || blocked
  lockedRef.current = locked
  const cleanEditor = draft !== null && !hasScheduleWork(draft)
  const dismissible = cleanEditor && !locked && deleting === null && duplicate === null
  const showAccount = isCombinedScope(accountId)
  const paneClosed = typeof accountId === 'number' && Boolean(accounts.find((account) => account.id === accountId)?.closed)
  useEffect(() => {
    if (!page || loadError || pending || recovery || bulkConfirmation) return
    const available = new Set(rows.filter((row) => accountInScope(accounts.find((account) => account.id === row.account_id), accountId)).map(scheduleRowKey))
    const next = new Set([...selectedRef.current].filter((key) => available.has(key)))
    if (next.size !== selectedRef.current.size) {
      writeSelection(next)
      onNotice('Selection changed because some schedules are no longer available.')
    }
  }, [accountId, accounts, bulkConfirmation, loadError, onNotice, page, pending, recovery, rows])
  const hasSelection = selectedKeys.size > 0
  useEffect(() => {
    onSelectionChange(hasSelection)
    return () => onSelectionChange(false)
  }, [hasSelection, onSelectionChange])
  useEffect(() => {
    if (registerSelected) clearSelection()
  }, [registerSelected])
  useLayoutEffect(() => {
    onGuardChange({ blocked: draft !== null || hasBulkChanges || bulkConfirmation !== null || pending || recovery !== null || createPending || createRecovery || deleting !== null || duplicate !== null, blockedReason: hasBulkChanges && !pending && recovery === null && bulkConfirmation === null ? STAGED_CHANGES_NOTICE : undefined, recoveryOwned: recovery !== null || createRecovery, newEntry: draft !== null && draft.original === null, existingEntry: Boolean(draft?.original && !locallyLocked && deleting === null && duplicate === null), dismissible, requestLeave })
  }, [bulkConfirmation, createPending, createRecovery, deleting, dismissible, draft, duplicate, hasBulkChanges, locallyLocked, onGuardChange, pending, recovery, requestLeave])
  useEffect(() => {
    if (!seed) return
    clearSelection()
    setDraft({ definition: seed, amount: (seed.amount_cents / 100).toFixed(2), tolerance: (seed.match_tolerance_cents / 100).toFixed(2), original: null })
    setError(null)
    setCreateError(null)
    onSeedConsumed()
  }, [onSeedConsumed, seed])
  useEffect(() => {
    if (draftKey === null) return
    const current = draftRef.current
    if (current?.original === null && current.entryOrigin === 'transfer') {
      const trigger = draftRowRef.current?.querySelector<HTMLButtonElement>(current.chooseAccountFirst ? 'td[data-column="account"] button:not(:disabled)' : 'td[data-column="payee"] button[data-transfer-picker]:not(:disabled)')
      if (trigger?.getAttribute('aria-expanded') === 'false') trigger.click()
    } else if (!current?.entryColumn || !enterLedgerCell(draftRowRef.current, current.entryColumn)) draftRowRef.current?.querySelector<HTMLElement>('td.has-cell-editor button:not(:disabled), td.has-cell-editor input:not(:disabled)')?.focus({ preventScroll: true })
  }, [draftKey])
  const editorOpen = draft !== null || hasBulkChanges
  useEffect(() => {
    if (!editorOpen) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [editorOpen])

  const change = (changes: Partial<ScheduleDefinition>) => setDraft((current) => {
    if (!current) return null
    const next = { ...current, definition: { ...current.definition, ...changes } }
    if ('category_id' in changes) {
      next.categoryProtected = true
      next.categoryAutofilled = false
    }
    if ('transfer_account_id' in changes && changes.transfer_account_id !== null && current.categoryAutofilled) {
      next.definition.category_id = null
      next.categoryAutofilled = false
    }
    if ('transfer_account_id' in changes && changes.transfer_account_id !== current.definition.transfer_account_id && current.payeeSuggestionKey) {
      next.definition.payee_id = null
      next.payeeSuggestionKey = undefined
    }
    if ('payee_id' in changes) next.payeeSuggestionKey = undefined
    if (!('category_id' in changes) && 'payee_id' in changes && changes.payee_id !== current.definition.payee_id && next.definition.transfer_account_id === null && !current.original && canAutofillPayeeCategory(current.definition.category_id, current.categoryProtected, current.categoryAutofilled)) {
      next.definition.category_id = payeeEntryCategory(changes.payee_id ?? null, payees, categories)
      next.categoryAutofilled = next.definition.category_id !== null
    }
    return next
  })
  const selectCreatedPayee = (origin: Draft, payee: Payee) => {
    if (draftRef.current !== origin) return false
    const next = { ...origin, definition: { ...origin.definition, payee_id: payee.id }, payeeSuggestionKey: undefined }
    if (next.definition.transfer_account_id === null && !origin.original && canAutofillPayeeCategory(origin.definition.category_id, origin.categoryProtected, origin.categoryAutofilled)) {
      next.definition.category_id = payeeEntryCategory(payee.id, [payee], categories)
      next.categoryAutofilled = next.definition.category_id !== null
    }
    draftRef.current = next
    setDraft(next)
    return true
  }
  const createQuickPayee = async (name: string) => {
    const origin = draftRef.current
    if (!origin || lockedRef.current || createPendingRef.current || createRecoveryRef.current) return false
    createPendingRef.current = true
    setCreatePending(true)
    setCreateError(null)
    try {
      return selectCreatedPayee(origin, await createPayee.mutateAsync({ name }))
    } catch (caught) {
      const conflict = caught instanceof ApiError && caught.code === 'payee_name_conflict'
        ? (caught.detail as { payee?: Payee } | undefined)?.payee : undefined
      if (conflict) {
        queryClient.setQueryData<Payee[]>(['payees'], (current) => [...(current ?? []).filter((payee) => payee.id !== conflict.id), conflict].sort((left, right) => left.name.localeCompare(right.name)))
        void queryClient.invalidateQueries({ queryKey: ['payees'] }).catch(() => undefined)
        return selectCreatedPayee(origin, conflict)
      }
      if (!(caught instanceof ApiError) || caught.status >= 500) {
        createRecoveryRef.current = true
        setCreateRecovery(true)
      } else setCreateError(caught.message)
      return false
    } finally {
      createPendingRef.current = false
      setCreatePending(false)
    }
  }
  const recoverQuickCreate = async () => {
    if (!createRecoveryRef.current || createPendingRef.current) return
    createPendingRef.current = true
    setCreatePending(true)
    setCreateError(null)
    try {
      await onInspect()
      queryClient.setQueryData(['payees'], await apiClient.get<Payee[]>('/api/payees'))
      createRecoveryRef.current = false
      setCreateRecovery(false)
    } catch { setCreateError('Refresh failed. Create remains blocked until it can be inspected.') }
    finally { createPendingRef.current = false; setCreatePending(false) }
  }
  const editPayee = (id: number) => {
    const origin = document.activeElement
    const current = draftRef.current
    const rowId = current?.original?.id
    const returnControl = current?.original === null ? document.querySelector<HTMLElement>(`[data-new-schedule-control="${current.entryOrigin ?? 'schedule'}"]`) : null
    onRequestWorkspaceAction(() => {
      if (document.activeElement !== document.body && document.activeElement !== origin && document.activeElement !== returnControl) return
      if (rowId !== undefined) areaRef.current?.querySelector<HTMLElement>(`[data-schedule-row-key="${rowId}"]`)?.focus({ preventScroll: true })
      onEditPayee(id)
    })
  }
  const dismissTransferShortcut = () => setDraft((current) => current ? { ...current, chooseAccountFirst: false } : null)
  const suggestionDirection = draft ? Math.sign(parseLedgerAmount(draft.amount) ?? 0) || -1 : -1
  useEffect(() => {
    const current = draftRef.current
    if (!current || current.original || current.definition.transfer_account_id === null || !validEntryDate(current.definition.next_date)) return
    const key = `${current.definition.account_id}:${current.definition.transfer_account_id}:${current.definition.next_date}:${suggestionDirection}`
    if (current.payeeSuggestionKey === key) return
    if (current.payeeSuggestionKey) { setDraft({ ...current, definition: { ...current.definition, payee_id: null }, payeeSuggestionKey: undefined }); return }
    if (current.definition.payee_id !== null) return
    const controller = new AbortController()
    const params = new URLSearchParams({ account_id: String(current.definition.account_id), transfer_account_id: String(current.definition.transfer_account_id), direction: String(suggestionDirection), on_date: current.definition.next_date })
    void apiClient.get<{ payee_id: number | null }>(`/api/transactions/transfer-payee-suggestion?${params}`, controller.signal).then(({ payee_id }) => {
      const latest = draftRef.current
      if (controller.signal.aborted || createPendingRef.current || !latest || latest.original || latest.definition.payee_id !== null || latest.definition.account_id !== current.definition.account_id || latest.definition.transfer_account_id !== current.definition.transfer_account_id || latest.definition.next_date !== current.definition.next_date || (Math.sign(parseLedgerAmount(latest.amount) ?? 0) || -1) !== suggestionDirection || payee_id === null) return
      setDraft({ ...latest, definition: { ...latest.definition, payee_id }, payeeSuggestionKey: key })
    }).catch(() => undefined)
    return () => controller.abort()
  }, [draft?.definition.account_id, draft?.definition.transfer_account_id, draft?.definition.next_date, draft?.definition.payee_id, draft?.payeeSuggestionKey, suggestionDirection])
  const chooseAccount = (value: string) => {
    const current = draftRef.current
    const row = draftRowRef.current
    const trigger = row?.querySelector<HTMLButtonElement>('td[data-column="account"] button')
    change({ account_id: Number(value) })
    if (!current?.chooseAccountFirst || !row || !trigger) return
    setDraft((current) => current ? { ...current, chooseAccountFirst: false } : null)
    requestAnimationFrame(() => {
      if (draftRowRef.current !== row || !row.isConnected || document.activeElement !== trigger || lockedRef.current || document.querySelector('.bp-modal-overlay')) return
      const transfer = row.querySelector<HTMLButtonElement>('td[data-column="payee"] button[data-transfer-picker]:not(:disabled)')
      if (transfer?.getAttribute('aria-expanded') === 'false') transfer.click()
    })
  }
  const restoreEntryFocus = () => {
    const origin = draft?.entryOrigin ?? 'schedule'
    const savedId = draft?.original?.id
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) document.querySelector<HTMLElement>(savedId !== undefined ? `[data-schedule-row-key="${savedId}"]` : `[data-new-schedule-control="${origin}"]`)?.focus({ preventScroll: true })
    })
  }
  const cancelDraft = (restoreFocus = true) => {
    if (busyRef.current || recovery || createPendingRef.current || createRecoveryRef.current) return false
    draftRef.current = null
    setDraft(null)
    setError(null)
    setCreateError(null)
    if (restoreFocus) restoreEntryFocus()
    return true
  }
  useCleanEditorDismiss(dismissible ? 'schedule' : null, () => cancelDraft(false), draft?.original === null ? '[data-new-schedule-control]' : undefined)
  useEditorClickAway(draft && !cleanEditor && !locked && deleting === null && duplicate === null ? 'schedule' : null, draft?.original ? () => onRequestWorkspaceAction(() => {}) : undefined)
  const requestRowAction = (row: ScheduledTransaction, action: (current: ScheduledTransaction) => void, permission?: ScheduledTransaction['allowed_actions'][number]) => {
    onRequestWorkspaceAction(() => {
      if (lockedRef.current || draftRef.current || bulkConfirmation) { onNotice('Finish or inspect the current schedule update first.'); return }
      if (hasBulkChanges) { onNotice(STAGED_CHANGES_NOTICE); return }
      const current = rowsRef.current.find((candidate) => scheduleRowKey(candidate) === scheduleRowKey(row))
      if (!current || permission && !current.allowed_actions.includes(permission)) { onNotice('That schedule is no longer available for this action.'); return }
      action(current)
    })
  }
  const beginNew = (entryOrigin: 'schedule' | 'transfer') => {
    if (draftRef.current?.original === null) { focusEntryField('schedule'); return }
    onRequestWorkspaceAction(() => {
      if (lockedRef.current || draftRef.current || !page || !eligibleSources.length || entryOrigin === 'transfer' && eligible.length < 2) { onNotice('A new schedule is not available in the current state.'); return }
      const day = new Date(`${page.today}T12:00:00`)
      day.setDate(day.getDate() + 1)
      const tomorrow = localDate(day)
      const definition: ScheduleDefinition = { account_id: typeof accountId === 'number' ? accountId : eligibleSources[0].id, next_date: tomorrow, frequency: 'monthly', payee_id: null, transfer_account_id: null, category_id: null, memo: '', amount_cents: 0, match_tolerance_cents: 0, end_date: null }
      clearSelection()
      setDraft({ original: null, amount: '', tolerance: '0', definition, baseline: definition, entryOrigin, chooseAccountFirst: entryOrigin === 'transfer' && showAccount })
      setError(null)
      setCreateError(null)
    })
  }
  const beginEdit = (row: ScheduledTransaction, entryColumn?: string) => {
    requestRowAction(row, (current) => {
      setError(null)
      setCreateError(null)
      clearSelection()
      setDraft({ original: current, definition: definitionFromRow(current), amount: (current.amount_cents / 100).toFixed(2), tolerance: (current.match_tolerance_cents / 100).toFixed(2), entryColumn })
    }, 'edit')
  }

  const refresh = async () => {
    await invalidateAccountAndTransactionQueries(queryClient)
    await onRefresh()
  }
  const execute = async (write: () => Promise<unknown>, message: string, { entered = false, restoreFocus = true, selectionToClear = null }: { entered?: boolean; restoreFocus?: boolean; selectionToClear?: string | null } = {}): Promise<EditorCompletion> => {
    if (lockedRef.current || busyRef.current) return 'retained'
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selectionKeys = [...selectedRef.current]
    const area = areaRef.current
    busyRef.current = true
    setPending(true)
    setError(null)
    let saved = false
    try {
      const result = await write()
      saved = true
      draftRef.current = null
      setDraft(null)
      setDeleting(null)
      finishSelection(selectionToClear)
      await refresh()
      onNotice(message)
      if (entered) {
        const row = (result as { rows: LedgerRow[] }).rows.find((row) => accountInScope(accounts.find((account) => account.id === row.account_id), accountId))
        if (row) await onEntered(row)
      }
      if (restoreFocus) restoreEntryFocus()
      if (selectionToClear === 'all') requestAnimationFrame(() => {
        if (!area?.isConnected || document.activeElement !== document.body || document.querySelector('.bp-modal-overlay')) return
        const target = selectionKeys.map((key) => area.querySelector<HTMLElement>(`[data-schedule-row-key="${key}"]`)).find(Boolean)
        const focusTarget = target ?? area.querySelector<HTMLElement>('[data-schedule-row-key], [data-new-schedule-control]')
        focusTarget?.focus({ preventScroll: true })
      })
      return 'finished'
    } catch (caught) {
      if (saved || !(caught instanceof ApiError) || caught.status >= 500 || ['history_request_stale', 'history_expired', 'history_epoch_stale', 'ledger_outcome_inspection_required'].includes(caught.code)) {
        setRecovery({ saved, selectionToClear })
        setError(saved ? 'Saved. Refresh to inspect the current schedule and register.' : 'The save result needs inspection. Refresh before trying another write.')
      } else {
        setError(caught.message)
        requestAnimationFrame(() => { if (document.activeElement === document.body) focusEntryField('schedule', undefined, previous) })
      }
      return 'retained'
    } finally { busyRef.current = false; setPending(false) }
  }
  const recover = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setPending(true)
    try {
      const state = await onInspect()
      await refresh()
      if (recovery?.saved || state.outcome?.status === 'committed') { draftRef.current = null; setDraft(null); setDeleting(null); finishSelection(recovery?.selectionToClear ?? null) }
      setBulkConfirmation(null)
      setRecovery(null)
      setError(null)
    } catch { setError('Refresh failed. Schedule writes remain blocked until inspection succeeds.') }
    finally { busyRef.current = false; setPending(false) }
  }
  const finishDuplicate = (confirmed: boolean) => {
    setDuplicate(null)
    duplicateResolve.current?.(confirmed)
    duplicateResolve.current = null
  }
  useEffect(() => () => { duplicateResolve.current?.(false) }, [])
  const duplicateCandidate = (definition: ScheduleDefinition, originalId?: number) => {
    const targetAccountId = definition.transfer_account_id
    return targetAccountId ? page?.duplicate_transfer_candidates.find((candidate) => candidate.account_id === targetAccountId && candidate.target_account_id === definition.account_id && candidate.amount_cents === -definition.amount_cents && candidate.id !== originalId) : undefined
  }
  const confirmDuplicate = async (definition: ScheduleDefinition, originalId?: number): Promise<boolean> => {
    if (duplicateResolve.current) return false
    const existing = duplicateCandidate(definition, originalId)
    if (!existing) return true
    setDuplicate(existing.account_name)
    return new Promise<boolean>((resolve) => { duplicateResolve.current = resolve })
  }
  const persistDraft = async (current: Draft, reason: 'save' | 'leave' = 'save'): Promise<EditorCompletion> => {
    const amount = parseLedgerAmount(current.amount)
    if (amount === null || !Number.isSafeInteger(amount)) { setError('Enter a valid amount with no more than two decimal places.'); return 'retained' }
    const tolerance = parseLedgerAmount(current.tolerance)
    if (tolerance === null || !Number.isSafeInteger(tolerance) || tolerance < 0) { setError('Enter a nonnegative +/- Match amount with no more than two decimal places.'); return 'retained' }
    if (tolerance > 0 && amount === 0) { setError('+/- Match requires a nonzero amount.'); return 'retained' }
    const definition = { ...current.definition, amount_cents: amount, match_tolerance_cents: tolerance }
    const original = current.original
    const needsReview = Boolean(duplicateCandidate(definition, original?.id))
    if (!await confirmDuplicate(definition, original?.id) || draftRef.current !== current) { focusEntryField('schedule'); return 'retained' }
    const completion = await execute(() => original ? apiClient.put(`/api/schedules/${original.id}`, { ...definition, edit_token: original.edit_token }) : apiClient.post('/api/schedules', definition), original ? 'Schedule updated.' : 'Schedule created.', { restoreFocus: reason !== 'leave' })
    return reason === 'leave' && needsReview ? 'retained' : completion
  }
  const sendToAccount = async (row: ScheduledTransaction, destination: Account) => {
    if (lockedRef.current || busyRef.current || draftRef.current) return
    const definition = { ...definitionFromRow(row), account_id: destination.id }
    if (!await confirmDuplicate(definition, row.id) || draftRef.current) return
    await execute(() => apiClient.put(`/api/schedules/${row.id}`, { ...definition, edit_token: row.edit_token }), `Schedule sent to ${destination.name}.`, { selectionToClear: scheduleRowKey(row) })
  }
  const requestExit = (reason: 'save' | 'leave' | 'cancel'): Promise<EditorCompletion> => {
    if (hasBulkChanges || bulkConfirmation) return Promise.resolve('retained')
    const current = draftRef.current
    if (!current) return Promise.resolve(pending || recovery ? 'retained' : 'finished')
    if (lockedRef.current || busyRef.current || duplicate || createPendingRef.current || createRecoveryRef.current) return Promise.resolve('retained')
    if (current.original) {
      if (reason === 'cancel' || !hasScheduleWork(current)) return Promise.resolve(cancelDraft(reason !== 'leave') ? 'finished' : 'retained')
      return persistDraft(current, reason)
    }
    const { definition } = current
    const issues = newEntryIssues({ date: definition.next_date, payeeId: definition.payee_id, transferAccountId: definition.transfer_account_id, categoryId: definition.category_id, amount: current.amount, accountId: definition.account_id }, categories, payees, accounts)
    if (!eligible.some((account) => account.id === definition.account_id)) issues.unshift({ field: 'account', message: 'Choose an open, initialized source account.' })
    if (validEntryDate(definition.next_date) && (!page || definition.next_date <= page.today)) issues.push({ field: 'date', message: 'Choose a next date of tomorrow or later.' })
    if (definition.end_date !== null && (!validEntryDate(definition.end_date) || definition.end_date < definition.next_date)) issues.push({ field: 'end_date', message: 'Choose an end date on or after the next date, or remove it.' })
    if (!SCHEDULE_FREQUENCIES.some((frequency) => frequency.value === definition.frequency)) issues.push({ field: 'frequency', message: 'Choose a valid frequency.' })
    if (definition.anchor_day != null && ['monthly', 'every_two_months', 'every_three_months', 'every_four_months', 'twice_yearly', 'yearly', 'every_two_years'].includes(definition.frequency) && validEntryDate(definition.next_date)) {
      const day = new Date(`${definition.next_date}T12:00:00`)
      const monthEnd = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate()
      if (day.getDate() !== Math.min(definition.anchor_day, monthEnd)) issues.push({ field: 'date', message: 'Choose a next date matching the recurrence day.' })
    }
    const tolerance = parseLedgerAmount(current.tolerance)
    if (tolerance === null || !Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 0 && parseLedgerAmount(current.amount) === 0) issues.push({ field: 'match_tolerance_cents', message: 'Enter a nonnegative +/- Match amount; zero amounts require 0.' })
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return entryExit.request({ reason, hasWork: hasScheduleWork(current), issues, save: () => persistDraft(current), discard: () => !lockedRef.current && cancelDraft(), focus: () => focusEntryField('schedule', reason === 'save' ? issues[0]?.field : undefined, previous) })
  }
  leaveRef.current = () => requestExit('leave')
  const save = () => { void requestExit('save') }
  const requestCancel = () => { void requestExit('cancel') }
  const enterNow = (row: ScheduledTransaction) => requestRowAction(row, (current) => { void execute(() => apiClient.post(`/api/schedules/${current.id}/enter-now`, { edit_token: current.edit_token }), 'Occurrence entered.', { entered: true, selectionToClear: scheduleRowKey(current) }) }, 'enter_now')
  const skip = (row: ScheduledTransaction) => requestRowAction(row, (current) => { void execute(() => apiClient.post(`/api/schedules/${current.id}/skip`, { edit_token: current.edit_token }), 'Occurrence skipped.', { selectionToClear: scheduleRowKey(current) }) }, 'skip')
  const actionsBlocked = locked || hasBulkChanges || bulkConfirmation !== null || draft?.original === null
  const removeTransfer = (row: ScheduledTransaction) => requestRowAction(row, (current) => { void execute(() => apiClient.put(`/api/schedules/${current.id}`, { ...definitionFromRow(current), transfer_account_id: null, edit_token: current.edit_token }), 'Transfer removed from schedule.', { selectionToClear: scheduleRowKey(current) }) }, 'edit')

  const changeSelection = (action: () => void) => {
    if (lockedRef.current || busyRef.current || bulkConfirmation) return
    if (hasBulkChanges) action()
    else onRequestWorkspaceAction(() => { if (!lockedRef.current && !draftRef.current) action() })
  }
  const selectRows = (row: ScheduledTransaction, gesture: SelectionGesture) => {
    if (gesture === 'one' && hasBulkChanges) { onNotice(STAGED_CHANGES_NOTICE); return }
    const key = scheduleRowKey(row)
    changeSelection(() => {
      const ordered = rowsRef.current.filter((item) => !item.mirror).map(scheduleRowKey)
      if (!rowsRef.current.some((item) => scheduleRowKey(item) === key)) { onNotice('That schedule is no longer available.'); return }
      const current = new Set([...selectedRef.current].filter((item) => ordered.includes(item)))
      const next = selectRowIds(current, ordered, key, anchorKey.current, gesture)
      if (gesture === 'one') anchorKey.current = key
      else if (gesture === 'toggle') anchorKey.current = next.size ? key : null
      else if (anchorKey.current === null || !ordered.includes(anchorKey.current)) anchorKey.current = key
      writeSelection(next)
      if (document.activeElement === document.body) document.querySelector<HTMLElement>(`[data-schedule-row-key="${key}"]`)?.focus({ preventScroll: true })
    })
  }
  const submitBatch = (payload: ScheduleBatchRequest, message: string) => {
    if (lockedRef.current || busyRef.current) return
    setBulkConfirmation(null)
    void execute(() => apiClient.post('/api/schedules/batch', payload), message, { restoreFocus: false, selectionToClear: 'all' })
  }
  const runBatch = (action: ScheduleBatchRequest['action'], destination?: Account) => {
    if (lockedRef.current || busyRef.current || draftRef.current || bulkConfirmation || loadError || !selectedRows.length) return
    if (action !== 'update' && hasBulkChanges) { onNotice(STAGED_CHANGES_NOTICE); return }
    const current = rowsRef.current.filter((row) => !row.mirror && selectedRef.current.has(scheduleRowKey(row)))
    const permission = action === 'enter_now' || action === 'skip' ? action : 'edit'
    if (current.length !== selectedRef.current.size || !current.every((row) => row.allowed_actions.includes(permission))) { onNotice('Every selected schedule must allow this action.'); return }
    if (action === 'send_to' && (!destination || !current.every((row) => page?.move_account_ids[row.id]?.includes(destination.id)))) { onNotice('Choose a destination valid for every selected schedule.'); return }
    const payload: ScheduleBatchRequest = { action, targets: current.map(({ id, edit_token }) => ({ id, edit_token })), ...(action === 'update' ? { changes: { ...bulkChanges } } : {}), ...(destination ? { destination_account_id: destination.id } : {}) }
    const occurrences = `${current.length} occurrence${current.length === 1 ? '' : 's'}`
    const definitions = `${current.length} schedule${current.length === 1 ? '' : 's'}`
    const message = action === 'enter_now' ? `${occurrences} entered.` : action === 'skip' ? `${occurrences} skipped.` : action === 'send_to' ? `${definitions} sent to ${destination!.name}.` : `${definitions} updated.`
    const overwrite = action === 'update' && bulkChanges.memo ? current.filter((row) => row.memo && row.memo !== bulkChanges.memo).length : 0
    const duplicates = action === 'send_to' && destination ? current.filter((row) => duplicateCandidate({ ...definitionFromRow(row), account_id: destination.id }, row.id)).length : 0
    if (overwrite || duplicates) {
      setBulkConfirmation({ payload: overwrite ? { ...payload, memo_overwrite_confirmed: true } : payload, message, title: overwrite ? 'Replace existing schedule memos?' : 'Save duplicate transfers?', copy: overwrite ? `Applying replaces existing memos on ${overwrite} selected schedule${overwrite === 1 ? '' : 's'}.` : `${duplicates} selected schedule${duplicates === 1 ? '' : 's'} may duplicate transfers already scheduled. Both schedules post both sides and may count the transfer twice in each account.` })
      return
    }
    submitBatch(payload, message)
  }

  const amountCells = (row: ScheduledTransaction) => separateAmountColumns
    ? <><td data-column="outflow">{row.amount_cents < 0 && <span className="bp-amount is-negative">{money(-row.amount_cents)}</span>}</td><td data-column="inflow">{row.amount_cents >= 0 && <span className="bp-amount is-positive">{money(row.amount_cents)}</span>}</td></>
    : <td data-column="amount_cents"><span className={`bp-amount ${row.amount_cents < 0 ? 'is-negative' : 'is-positive'}`}>{money(row.amount_cents, true)}</span></td>
  const keyActions = (event: ReactKeyboardEvent) => {
    if (isComposingKey(event.nativeEvent)) return
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyT') { event.preventDefault(); event.stopPropagation(); draftRowRef.current?.querySelector<HTMLButtonElement>('button[data-transfer-picker]')?.click(); return }
    if (event.defaultPrevented || (event.target as Element).closest('.bp-picker-popover, .bp-modal-overlay')) return
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); save() } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); requestCancel() }
  }

  const editorChanged = Boolean(draft && (!draft.original || hasScheduleWork(draft)))
  const editor = draft && <tr ref={draftRowRef} data-ledger-edit-session="schedule" className="is-editing" inert={pending || createPending || createRecovery} aria-busy={pending || createPending} onKeyDownCapture={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter' && event.repeat) { event.preventDefault(); event.stopPropagation() } }} onKeyDown={keyActions}>
    {/* FilterSelect requires onAdvance for Enter/Tab acceptance, even when chooseAccount owns the initial Payee continuation. */}
    {showAccount && <td className="has-cell-editor bp-schedule-select" data-column="account"><FilterSelect ariaLabel="Schedule account" sessionId="schedule" onAdvance={draft.chooseAccountFirst ? () => undefined : focusNextLedgerCell} autoFocus={false} popupWidth={200} value={String(draft.definition.account_id)} options={sourceOptions.map((account) => ({ value: String(account.id), label: account.name }))} onChange={chooseAccount} /></td>}
    <td className="has-cell-editor bp-schedule-select" data-column="frequency"><FilterSelect ariaLabel="Schedule frequency" sessionId="schedule" onAdvance={focusNextLedgerCell} autoFocus={false} popupWidth={146} value={draft.definition.frequency} options={SCHEDULE_FREQUENCIES} onChange={(value) => change({ frequency: value as ScheduleFrequency })} /></td>
    <td className="has-cell-editor" data-column="date"><LedgerDatePicker onAdvance={focusNextLedgerCell} ariaLabel="Schedule next date" sessionId="schedule" value={draft.definition.next_date} onChange={(value) => change({ next_date: value, anchor_day: null, end_date: draft.definition.end_date !== null && draft.definition.end_date < value ? value : draft.definition.end_date })} /></td>
    <td className="has-cell-editor" data-column="end_date">{draft.definition.end_date === null
      ? <button className="bp-cell-picker" type="button" aria-label="Add an end date" onClick={() => change({ end_date: draft.definition.next_date })}><span className="is-empty">No end</span><CalendarPlus aria-hidden="true" /></button>
      : <span className="bp-schedule-end-edit"><LedgerDatePicker onAdvance={focusNextLedgerCell} ariaLabel="Schedule end date" sessionId="schedule" value={draft.definition.end_date} onChange={(value) => change({ end_date: value })} /><button className="bp-schedule-clear" type="button" aria-label="Remove end date" title="Remove end date" onClick={() => change({ end_date: null })}><X aria-hidden="true" /></button></span>}</td>
    <td className="has-cell-editor" data-column="payee"><span className="bp-payee-cell"><LedgerOptionPicker onAdvance={focusNextLedgerCell} ariaLabel="Schedule payee" sessionId="schedule" value={draft.definition.payee_id} options={ledgerPayeeOptions(payees, draft.definition.payee_id)} emptyLabel="Choose payee" allowEmpty={false} onChange={(payeeId) => { dismissTransferShortcut(); change({ payee_id: payeeId }) }} onEditPayee={editPayee} onCreatePayee={createQuickPayee} createPending={createPending} createError={createError} createRecovery={createRecovery} onRecoverCreate={recoverQuickCreate} onCreateQueryChange={() => setCreateError(null)} /><LedgerTransferPicker ariaLabel="Schedule transfer" sessionId="schedule" accounts={accounts} sourceAccountId={draft.definition.account_id} value={draft.definition.transfer_account_id} onChange={(transfer_account_id) => { dismissTransferShortcut(); change({ transfer_account_id }) }} tabIndex={draft.entryOrigin === 'schedule' ? -1 : undefined} onAdvance={() => focusEntryField('schedule', 'payee')} /></span></td>
    <td className="has-cell-editor" data-column="category"><LedgerCategoryPicker onAdvance={focusNextLedgerCell} ariaLabel="Schedule category" sessionId="schedule" value={draft.definition.category_id} categories={categories} emptyLabel="Uncategorized" onChange={(categoryId) => change({ category_id: categoryId })} /></td>
    <td className="has-cell-editor" data-column="memo"><LedgerMemoInput value={draft.definition.memo} onChange={(memo) => change({ memo })} onCommit={() => save()} onCancel={requestCancel} /></td>
    {separateAmountColumns
      ? (['outflow', 'inflow'] as const).map((direction) => <td key={direction} className="has-cell-editor" data-column={direction}><LedgerDirectionalAmountInput aria-label={`Schedule ${direction}`} value={draft.amount} direction={direction} onChange={(amount) => setDraft((current) => current ? { ...current, amount } : null)} /></td>)
      : <td className="has-cell-editor" data-column="amount_cents"><LedgerAmountInput value={draft.amount} onChange={(amount) => setDraft((current) => current ? { ...current, amount } : null)} onCommit={() => save()} onCancel={requestCancel} /></td>}
    <td className="has-cell-editor" data-column="match_tolerance_cents" title={TOLERANCE_TITLE}><LedgerAmountInput ariaLabel="Schedule +/- Match" value={draft.tolerance} onChange={(tolerance) => setDraft((current) => current ? { ...current, tolerance } : null)} onCommit={() => save()} onCancel={requestCancel} /></td>
    {balanceVisible && <td data-column="projected_balance_cents" />}
    <td data-column="actions"><LedgerEditorActions noun="schedule" isNew={!draft.original} disabled={locked} unchanged={!editorChanged} onSave={save} onCancel={requestCancel} /></td>
  </tr>

  const openRowMenu = (row: ScheduledTransaction, origin: HTMLElement, left: number, top: number) => {
    const open = (current: ScheduledTransaction) => {
      if (!selectedRef.current.has(scheduleRowKey(current))) { anchorKey.current = scheduleRowKey(current); writeSelection(new Set([scheduleRowKey(current)])) }
      const currentOrigin = origin.isConnected ? origin : document.querySelector<HTMLElement>(`[data-schedule-row-key="${scheduleRowKey(current)}"]`)
      if (currentOrigin) setMenu({ row: current, left, top, origin: currentOrigin })
    }
    if (hasBulkChanges && selectedRef.current.has(scheduleRowKey(row)) && !locked && !bulkConfirmation) open(row)
    else requestRowAction(row, open)
  }

  const bulkMenu = menu !== null && selectedRows.length > 1 && selectedKeys.has(scheduleRowKey(menu.row))
  let body: ReactNode = displayRows.map((row) => {
    const transferAccountName = row.mirror?.account_name ?? accounts.find((account) => account.id === row.transfer_account_id)?.name ?? 'Unavailable account'
    const transferLabel = `${transferDirection(row.amount_cents)} ${transferAccountName}`
    return row.ghost ? <tr key={`${scheduleRowKey(row)}-ghost-${row.next_date}`} className={`bp-schedule-ghost${row.mirror ? ' is-mirror' : ''}`}>
    {showAccount && <td data-column="account">{row.account_name}</td>}
    <td data-column="frequency">{scheduleFrequencyLabel(row.frequency)}</td>
    <td data-column="date">{formatDate(row.next_date)}</td>
    <td data-column="end_date">{row.end_date ? formatDate(row.end_date) : stub}</td>
    <td data-column="payee">{row.transfer_account_id === null ? row.payee_name ?? stub : <span className="bp-payee-cell"><span>{row.payee_name ?? stub}</span><ArrowRightLeft className="bp-schedule-ghost-transfer" role="img" aria-label={transferLabel}><title>{transferLabel}</title></ArrowRightLeft></span>}</td>
    <td data-column="category">{row.category_name ?? stub}</td>
    <td data-column="memo">{row.memo || stub}</td>
    {amountCells(row)}
    <td data-column="match_tolerance_cents"><span className="bp-amount">{money(row.match_tolerance_cents)}</span></td>
    {balanceCell(row)}
    <td data-column="actions"><span className="bp-schedule-ghost-icon" role="img" aria-label="Future occurrence preview" title="Future occurrence preview"><Ghost aria-hidden="true" /></span></td>
  </tr> : draft?.original?.id === row.id && !row.mirror ? <Fragment key={row.id}>{editor}</Fragment> : <tr
    tabIndex={scheduleRowKey(row) === tabRowKey ? 0 : -1}
    aria-selected={selectedKeys.has(scheduleRowKey(row))}
    data-schedule-row-key={scheduleRowKey(row)}
    onFocus={() => setFocusedRowKey(scheduleRowKey(row))}
    key={scheduleRowKey(row)}
    className={[row.mirror ? 'is-mirror' : row.pause_reason ? 'is-paused' : '', selectedKeys.has(scheduleRowKey(row)) ? 'is-selected' : ''].filter(Boolean).join(' ') || undefined}
    title={row.mirror ? `Scheduled in ${row.mirror.account_name}. Right-click to go there.` : undefined}
    onMouseDown={(event) => {
      if (selectionGesture(event) !== 'one' && !isRowControl(event.target)) {
        event.preventDefault()
        if (!draftRef.current) event.currentTarget.focus({ preventScroll: true })
      }
    }}
    onClick={(event) => {
      if ((event.target as Element).closest('button')) return
      const gesture = selectionGesture(event)
      if (gesture !== 'one') {
        event.preventDefault()
        if (!row.mirror) selectRows(row, gesture)
        return
      }
      if (selectedKeys.size === 1 && selectedKeys.has(scheduleRowKey(row)) && !row.mirror) { beginEdit(row, clickedLedgerCell(event.target)?.column); return }
      selectRows(row, 'one')
    }}
    onContextMenu={(event) => {
      event.preventDefault()
      const origin = (event.target as Element).closest<HTMLButtonElement>('button:not(:disabled)') ?? event.currentTarget
      openRowMenu(row, origin, event.clientX, event.clientY)
    }}
    onKeyDown={(event) => {
      if (isComposingKey(event.nativeEvent) || event.defaultPrevented) return
      const keyAction = rowKeyAction(event)
      if (keyAction === 'menu') {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        const origin = (event.target as Element).closest<HTMLButtonElement>('button:not(:disabled)') ?? event.currentTarget
        const rect = event.currentTarget.getBoundingClientRect()
        openRowMenu(row, origin, rect.left + Math.min(24, rect.width / 2), rect.top + Math.min(24, rect.height / 2))
        return
      }
      if (event.target !== event.currentTarget) return
      if (keyAction === 'previous' || keyAction === 'next') {
        event.preventDefault()
        event.stopPropagation()
        const siblings = [...event.currentTarget.parentElement!.querySelectorAll<HTMLTableRowElement>('tr[data-schedule-row-key]')]
        const index = siblings.indexOf(event.currentTarget)
        siblings[Math.max(0, Math.min(siblings.length - 1, index + (keyAction === 'next' ? 1 : -1)))]?.focus()
      } else if (keyAction === 'edit') {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        if (row.mirror) requestRowAction(row, (current) => { if (current.mirror) onOpenAccount(current.mirror.account_id) })
        else beginEdit(row)
      }
    }}
  >
    {showAccount && <td data-column="account">{row.account_name}</td>}
    <td data-column="frequency">{scheduleFrequencyLabel(row.frequency)}</td>
    <td data-column="date">{paneClosed ? stub : row.pause_reason ? <span className="bp-schedule-paused" title={`${row.pause_reason}. Missed dates are skipped when this schedule resumes.`}><i aria-hidden="true" />Paused</span> : formatDate(row.next_date)}</td>
    <td data-column="end_date">{row.end_date ? formatDate(row.end_date) : stub}</td>
    <td data-column="payee">{row.transfer_account_id === null ? row.payee_name ?? stub : <span className="bp-payee-cell"><span>{row.payee_name ?? stub}</span><ScheduleTransferBadge onRequestOpen={(open) => requestRowAction(row, () => open())} row={row} accountName={transferAccountName} blocked={actionsBlocked} onGoToSchedule={(ownerId) => onRequestWorkspaceAction(() => onOpenAccount(ownerId))} onRemove={() => { void removeTransfer(row) }} /></span>}</td>
    <td data-column="category">{row.category_name ?? stub}</td>
    <td data-column="memo">{row.memo || stub}</td>
    {amountCells(row)}
    <td data-column="match_tolerance_cents" title={row.mirror ? `+/- Match applies to the ${row.mirror.account_name} side.` : TOLERANCE_TITLE}><span className="bp-amount">{money(row.match_tolerance_cents)}</span></td>
    {balanceCell(row)}
    <td data-column="actions"><span className="bp-row-actions">
      {row.mirror ? <><span className="bp-match-button-placeholder" aria-hidden="true" /><span className="bp-match-button-placeholder" aria-hidden="true" /></> : <>
        <button className="bp-row-command" type="button" aria-label="Enter this occurrence" title={row.pause_reason ?? 'Enter this occurrence'} disabled={actionsBlocked || !row.allowed_actions.includes('enter_now')} onClick={() => enterNow(row)}><ArrowUpFromDot aria-hidden="true" /></button>
        <button className="bp-row-command" type="button" aria-label="Skip this occurrence" title={row.pause_reason ?? 'Skip this occurrence'} disabled={actionsBlocked || !row.allowed_actions.includes('skip')} onClick={() => skip(row)}><ArrowUpFromDot className="bp-icon-flipped" aria-hidden="true" /></button>
      </>}
    </span></td>
  </tr>
  })
  if (draft && !rows.some((row) => row.id === draft.original?.id && !row.mirror)) body = <>{editor}{body}</>
  const bulkToolbar = visible && (selectedRows.length > 1 || selectedRows.length > 0 && (hasBulkChanges || recovery !== null || bulkConfirmation !== null)) && <ScheduledBulkToolbar rows={selectedRows} selectableCount={rows.filter((row) => !row.mirror).length} changes={bulkChanges} accounts={commonDestinations} payees={payees} categories={categories} disabled={locked || bulkConfirmation !== null || loadError} cancelDisabled={locked || bulkConfirmation !== null} onChange={(changes) => changeSelection(() => setBulkChanges(changes))} onSave={() => runBatch('update')} onEnter={() => runBatch('enter_now')} onSkip={() => runBatch('skip')} onSend={(account) => runBatch('send_to', account)} onCancel={clearSelection} />

  return <div ref={areaRef} className="bp-scheduled-area" onKeyDownCapture={(event) => {
    if (isComposingKey(event.nativeEvent)) {
      if (['Enter', ' '].includes(event.key) && !((event.target as Element).closest('input, textarea, [contenteditable]'))) { event.preventDefault(); event.stopPropagation() }
      return
    }
    if (event.repeat && (event.key === 'Enter' || event.key === ' ' && !(event.target as Element).closest('input, textarea, [contenteditable]'))) { event.preventDefault(); event.stopPropagation(); return }
    if (event.defaultPrevented || event.repeat || event.altKey) return
    const target = event.target as Element
    if (!event.currentTarget.contains(target) || nativeLedgerShortcutOwner(target) || document.querySelector('.bp-modal-overlay')) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      if (locked || draft?.original === null || menu || bulkConfirmation) return
      event.preventDefault(); event.stopPropagation()
      changeSelection(() => writeSelection(new Set(rowsRef.current.filter((row) => !row.mirror).map(scheduleRowKey))))
    }
  }} onKeyDown={(event) => {
    if (isComposingKey(event.nativeEvent) || event.defaultPrevented) return
    if (event.repeat && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); return }
  }}>
    {visible && <div className="bp-schedule-grip" role="separator" aria-label="Resize scheduled pane" aria-orientation="horizontal" aria-valuenow={height} aria-valuemin={120} aria-valuemax={500} tabIndex={0} onDoubleClick={onToggle} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); onHeightChange(height + (event.key === 'ArrowUp' ? 20 : -20)) } }} onPointerDown={(event) => {
      if (event.detail > 1) return
      const grip = event.currentTarget, start = event.clientY, initial = height
      grip.setPointerCapture(event.pointerId)
      let next = initial
      const move = (pointer: PointerEvent) => { next = initial + start - pointer.clientY; onHeightChange(next, false) }
      const end = () => { onHeightChange(next); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end) }
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end)
    }}><span /></div>}
    <section hidden={!visible} className="bp-scheduled-pane" style={{ height }} aria-label="Scheduled transactions">
      <div className="bp-ledger-action-row bp-schedule-bar">
        {(['schedule', 'transfer'] as const).map((entryOrigin) => <div className="bp-new-transaction-wrap" key={entryOrigin}><Button data-new-schedule-control={entryOrigin} size="md" variant="quiet" disabled={!canRequestEntry || pending || recovery !== null || !page || (typeof accountId === 'number' ? !eligible.some((account) => account.id === accountId) : !eligibleSources.length) || entryOrigin === 'transfer' && eligible.length < 2} title={entryOrigin === 'transfer' && eligible.length < 2 ? 'Add another open, initialized account before scheduling a transfer.' : undefined} onMouseDown={(event) => { if (event.button === 0 && draftRef.current?.original === null) event.preventDefault() }} onClick={() => beginNew(entryOrigin)}>{entryOrigin === 'transfer' ? '+ New Transfer' : '+ New Scheduled'}</Button></div>)}
        <div className="bp-schedule-controls">
          <ScheduleLookAheadMenu value={lookAhead} onChange={onLookAheadChange} showProjectedBalance={showProjectedBalance} onProjectedBalanceChange={onProjectedBalanceChange} balanceAvailable={page?.projected_balance_available === true} disabled={pending || recovery !== null || !page} onRequestAction={onRequestWorkspaceAction} />
          <div className="bp-new-transaction-wrap bp-schedule-toggle"><Button size="md" variant="quiet" title="Hide scheduled transactions" aria-expanded disabled={pending || recovery !== null} onClick={onToggle}>Scheduled Transactions: {rows.length}<ChevronDown aria-hidden="true" /></Button></div>
        </div>
      </div>
      {bulkToolbar && (selectionSlot ? createPortal(bulkToolbar, selectionSlot) : bulkToolbar)}
      {loadError && !recovery && <div className="bp-schedule-error" role="alert">Schedules could not be refreshed.<Button size="sm" disabled={pending} onClick={() => { void onRefresh().catch(() => setError('Schedules could not be loaded. Try Refresh again.')) }}>Refresh schedules</Button></div>}
      {error && <div className="bp-schedule-error" role="alert">{error}<Button size="sm" disabled={pending} onClick={() => { if (recovery) void recover(); else void onRefresh().then(() => setError(null)).catch(() => setError('Schedules could not be refreshed. Try again.')) }}>Refresh schedules</Button></div>}
      <div className="bp-schedule-scroll" tabIndex={-1} onMouseDownCapture={(event) => {
        const target = event.target as Element
        if (event.button === 0 && !draftRef.current && !target.closest('button, input, select, textarea, [contenteditable], tr[data-schedule-row-key]')) event.currentTarget.focus({ preventScroll: true })
      }}>
        <table className={`bp-table${showAccount ? ' has-account' : ''}`}>
          <colgroup>
            {showAccount && <col style={{ width: 150 }} />}
            <col style={{ width: 122 }} />
            <col style={{ width: 86 }} />
            <col style={{ width: 86 }} />
            <col />
            <col />
            <col />
            {separateAmountColumns ? <><col style={{ width: 94 }} /><col style={{ width: 94 }} /></> : <col style={{ width: 94 }} />}
            <col style={{ width: 94 }} />
            {balanceVisible && <col style={{ width: 112 }} />}
            <col style={{ width: 50 }} />
          </colgroup>
          <thead><tr>
            {showAccount && <th>Account</th>}
            <th>Frequency</th>
            <th>Next date</th>
            <th>End date</th>
            <th>Payee</th>
            <th>Category</th>
            <th>Memo</th>
            {separateAmountColumns ? <><th className="bp-schedule-amount-head">Outflow</th><th className="bp-schedule-amount-head">Inflow</th></> : <th className="bp-schedule-amount-head">Amount</th>}
            <th className="bp-schedule-amount-head">+/- Match</th>
            {balanceVisible && <th className="bp-schedule-amount-head" data-column="projected_balance_cents" title={PROJECTED_BALANCE_DESCRIPTION} aria-description={PROJECTED_BALANCE_DESCRIPTION}>Projected</th>}
            <th data-column="actions"><span className="bp-visually-hidden">Actions</span></th>
          </tr></thead>
          <tbody>{body}</tbody>
        </table>
        {!rows.length && !draft && <div className="bp-grid-empty-results" role="status">{page
          ? <><strong>No scheduled transactions yet</strong><span>Schedule a recurring bill, paycheck, or transfer to get started.</span></>
          : <span>{loadError ? 'Schedules unavailable' : 'Loading schedules…'}</span>}</div>}
      </div>
      {paneClosed && rows.length > 0 && <div className="bp-schedule-stamp" aria-hidden="true"><div><strong>Paused</strong><span>Reopen account to resume; missed dates are skipped.</span></div></div>}
    </section>
    {!visible && <div className="bp-ledger-action-row bp-schedule-bar bp-schedule-collapsed">
      <div className="bp-schedule-controls">
        <ScheduleLookAheadMenu value={lookAhead} onChange={onLookAheadChange} showProjectedBalance={showProjectedBalance} onProjectedBalanceChange={onProjectedBalanceChange} balanceAvailable={page?.projected_balance_available === true} disabled={pending || recovery !== null || !page} onRequestAction={onRequestWorkspaceAction} />
        <div className="bp-new-transaction-wrap bp-schedule-toggle"><Button size="md" variant="quiet" title="Show scheduled transactions" aria-expanded={false} onClick={onToggle}>Scheduled Transactions: {rows.length}<ChevronUp aria-hidden="true" /></Button></div>
      </div>
    </div>}
    {entryExit.dialog && <NewEntryExitDialog noun="schedule" issues={entryExit.dialog.issues} onContinue={entryExit.continueEditing} onDiscard={entryExit.discard} />}
    {menu && <ScheduleRowMenu menu={menu} bulk={bulkMenu ? { count: selectedRows.length, blocked: actionsBlocked, blockedReason: hasBulkChanges ? STAGED_CHANGES_NOTICE : 'Finish or cancel the active ledger work first.', canEnter: selectedRows.every((row) => row.allowed_actions.includes('enter_now')), canSkip: selectedRows.every((row) => row.allowed_actions.includes('skip')), onEnter: () => runBatch('enter_now'), onSkip: () => runBatch('skip'), onSend: (account) => runBatch('send_to', account) } : undefined} accounts={bulkMenu ? commonDestinations : accounts.filter((account) => page?.move_account_ids[menu.row.id]?.includes(account.id))} onDismiss={dismissMenu} onSend={(row, destination) => requestRowAction(row, (current) => { void sendToAccount(current, destination) })} onEnterNow={enterNow} onSkip={skip} onEdit={beginEdit} onDelete={(row) => requestRowAction(row, (current) => setDeleting(current), 'delete')} onOpenAccount={onOpenAccount} />}
    {bulkConfirmation && <Modal size="sm" role="alertdialog" labelledBy="schedule-bulk-confirm-title" onRequestClose={() => { if (!pending && !recovery) setBulkConfirmation(null) }}><DialogHeader titleId="schedule-bulk-confirm-title" title={bulkConfirmation.title} subtitle={`${bulkConfirmation.payload.targets.length} selected schedules will change.`} closeDisabled={pending || recovery !== null} onClose={() => setBulkConfirmation(null)} /><div className="bp-dialog-body"><p className="bp-dialog-copy">{bulkConfirmation.copy}</p></div><div className="bp-dialog-footer"><Button size="lg" disabled={pending || recovery !== null} onClick={() => setBulkConfirmation(null)}>Cancel</Button><Button size="lg" variant="danger" disabled={locked} onClick={() => submitBatch(bulkConfirmation.payload, bulkConfirmation.message)}>Apply changes</Button></div></Modal>}
    {duplicate && <Modal size="sm" role="alertdialog" labelledBy="schedule-duplicate-title" onRequestClose={() => finishDuplicate(false)}><DialogHeader titleId="schedule-duplicate-title" title="Save a duplicate transfer?" subtitle={`${duplicate} already schedules this transfer.`} onClose={() => finishDuplicate(false)} /><div className="bp-dialog-body"><p className="bp-dialog-copy">That schedule posts both sides. Saving another will likely count the transfer twice in each account.</p></div><div className="bp-dialog-footer"><Button size="lg" onClick={() => finishDuplicate(false)}>Cancel</Button><Button size="lg" variant="danger" disabled={locked} onClick={() => finishDuplicate(true)}>Save anyway</Button></div></Modal>}
    {deleting && <Modal size="sm" role="alertdialog" labelledBy="schedule-delete-title" onRequestClose={() => { if (!pending && !recovery) setDeleting(null) }}><DialogHeader titleId="schedule-delete-title" title="Delete schedule?" subtitle="This removes all future occurrences." closeDisabled={pending || recovery !== null} onClose={() => setDeleting(null)} /><div className="bp-dialog-body"><p className="bp-dialog-copy">Transactions already entered from this schedule remain in the register.</p>{error && <div className="bp-callout bp-callout--error" role="alert"><p>{error}</p>{recovery && <div className="bp-callout-actions"><Button size="md" disabled={pending} onClick={() => void recover()}>Refresh schedules</Button></div>}</div>}</div><div className="bp-dialog-footer"><Button size="lg" disabled={pending || recovery !== null} onClick={() => setDeleting(null)}>Cancel</Button><Button size="lg" variant="danger" busy={pending} disabled={locked} onClick={() => void execute(() => apiClient.post(`/api/schedules/${deleting.id}/delete`, { edit_token: deleting.edit_token }), 'Schedule deleted.', { selectionToClear: scheduleRowKey(deleting) })}>{pending ? 'Deleting…' : 'Delete schedule'}</Button></div></Modal>}
  </div>
}

function ScheduleLookAheadMenu({ value, onChange, showProjectedBalance, onProjectedBalanceChange, balanceAvailable, disabled, onRequestAction }: { value: ScheduleLookAhead; onChange: (value: ScheduleLookAhead) => void; showProjectedBalance: boolean; onProjectedBalanceChange: (value: boolean) => void; balanceAvailable: boolean; disabled: boolean; onRequestAction: (action: () => void) => void }) {
  const balanceUnavailable = value === 'off' ? 'Choose a Look ahead period to show projected balances.' : !balanceAvailable ? 'Choose one initialized account to show projected balances.' : null
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const initialIndex = useRef<number | null>(null)
  const menuId = useId()
  const position = usePickerPosition(open, anchorRef, menuRef, 0, 'attached')
  const dismiss = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }) }
  const show = (index: number | null = null) => onRequestAction(() => { initialIndex.current = index; setOpen(true) })
  useLayoutEffect(() => {
    if (!open) return
    const index = initialIndex.current ?? LOOK_AHEAD_OPTIONS.findIndex((option) => option.value === value)
    menuRef.current?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus({ preventScroll: true })
  }, [open, value])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside) }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <div ref={anchorRef} className="bp-new-transaction-wrap bp-schedule-look-ahead">
    <Button ref={triggerRef} size="md" variant="quiet" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => { if (open) dismiss(); else show() }} onKeyDown={(event) => {
      if (isComposingKey(event.nativeEvent) || event.repeat) { if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) event.preventDefault(); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); show(event.key === 'ArrowDown' ? 0 : LOOK_AHEAD_OPTIONS.length) }
    }}>Look ahead: {LOOK_AHEAD_OPTIONS.find((option) => option.value === value)?.label}<ChevronDown aria-hidden="true" /></Button>
    {open && createPortal(<div ref={menuRef} id={menuId} className="bp-schedule-look-ahead-menu" style={position} role="menu" aria-label="Look ahead" onKeyDown={(event) => {
      if (isComposingKey(event.nativeEvent) || event.repeat) { if (['Enter', ' '].includes(event.key)) event.preventDefault(); return }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() }
      else if (event.key === 'Tab') dismiss()
      else navigateActionMenu(event)
    }}>
      {LOOK_AHEAD_OPTIONS.map((option) => <button key={option.value} type="button" role="menuitemradio" aria-checked={option.value === value} onClick={() => { dismiss(); onRequestAction(() => onChange(option.value)) }}>{option.label}{option.value === value && <Check aria-hidden="true" />}</button>)}
      <span role="separator" />
      <button type="button" role="menuitemcheckbox" aria-checked={showProjectedBalance} aria-disabled={balanceUnavailable !== null || undefined} aria-description={balanceUnavailable ?? undefined} title={balanceUnavailable ?? undefined} onClick={() => { if (!balanceUnavailable) onRequestAction(() => onProjectedBalanceChange(!showProjectedBalance)) }}>Projected balance<span className="bp-switch" aria-hidden="true"><span /></span></button>
    </div>, document.body)}
  </div>
}

function ScheduleTransferBadge({ row, accountName, blocked, onGoToSchedule, onRemove, onRequestOpen }: { onRequestOpen: (open: () => void) => void; row: ScheduledTransaction; accountName: string; blocked: boolean; onGoToSchedule: (ownerId: number) => void; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const mirror = row.mirror
  return <TransferPopover onRequestOpen={onRequestOpen} triggerLabel={`Transfer with ${accountName}; scheduled`} direction={transferDirection(row.amount_cents)} accountName={accountName} onOpen={() => setConfirming(false)}>{(close) => mirror
    ? <div className="bp-transfer-popover-actions"><Button size="md" onClick={() => { close(false); onGoToSchedule(mirror.account_id) }}>Go to schedule</Button></div>
    : <div className={`bp-transfer-popover-actions${confirming ? ' is-confirming' : ''}`}>{confirming
      ? <><p className="bp-callout bp-callout--danger">Future occurrences will post only in {row.account_name} and stop creating a linked transaction in {accountName}. Payee and Category stay.</p><Button size="md" onClick={() => setConfirming(false)}>Cancel</Button><Button size="md" variant="danger" disabled={blocked} onClick={() => { close(false); onRemove() }}>Remove</Button></>
      : <Button size="md" variant="danger" disabled={blocked || !row.allowed_actions.includes('edit')} onClick={() => setConfirming(true)}>Remove</Button>}</div>}</TransferPopover>
}

function ScheduleRowMenu({ menu, bulk, accounts, onDismiss, onSend, onEnterNow, onSkip, onEdit, onDelete, onOpenAccount }: {
  menu: RowMenu
  bulk?: { count: number; blocked: boolean; blockedReason: string; canEnter: boolean; canSkip: boolean; onEnter: () => void; onSkip: () => void; onSend: (account: Account) => void }
  accounts: Account[]
  onDismiss: () => void
  onSend: (row: ScheduledTransaction, account: Account) => void
  onEnterNow: (row: ScheduledTransaction) => void
  onSkip: (row: ScheduledTransaction) => void
  onEdit: (row: ScheduledTransaction) => void
  onDelete: (row: ScheduledTransaction) => void
  onOpenAccount: (accountId: number) => void
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const [flyout, setFlyout] = useState(false)
  const { row } = menu
  const dismiss = () => { menu.origin.focus({ preventScroll: true }); onDismiss() }
  const openFlyout = (focus = false) => {
    if (!accounts.length || bulk?.blocked) return
    setFlyout(true)
    if (focus) queueMicrotask(() => flyoutRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
  }
  const closeFlyout = () => { setFlyout(false); sendRef.current?.focus() }
  const blockedReason = bulk?.blocked ? bulk.blockedReason : undefined
  const sendReason = blockedReason ?? (!accounts.length ? 'No other account can receive this schedule.' : undefined)
  const item = (label: string, action: (row: ScheduledTransaction) => void, allowed: boolean, reason?: string, danger = false) => <ActionMenuItem danger={danger} disabled={!allowed} title={allowed ? undefined : reason} onFocus={() => setFlyout(false)} onPointerEnter={() => setFlyout(false)} onClick={() => { dismiss(); action(row) }}>{label}</ActionMenuItem>
  return <>
    <span ref={anchorRef} className="bp-context-anchor" style={{ left: menu.left, top: menu.top }} aria-hidden="true" />
    <ActionMenu anchorRef={anchorRef} menuRef={menuRef} relatedRefs={[flyoutRef]} aria-label="Schedule actions" onDismiss={(reason) => {
      if (reason === 'outside') onDismiss()
      else if (reason === 'escape' && flyout) closeFlyout()
      else dismiss()
    }}>
      {row.mirror ? item(`Go to schedule in ${row.mirror.account_name}`, () => onOpenAccount(row.mirror!.account_id), true) : <>
        {item(bulk ? `Enter ${bulk.count} occurrences` : 'Enter this occurrence', bulk ? bulk.onEnter : onEnterNow, bulk ? !bulk.blocked && bulk.canEnter : row.allowed_actions.includes('enter_now'), blockedReason ?? row.pause_reason ?? 'Every selected schedule must allow entry.')}
        {item(bulk ? `Skip ${bulk.count} occurrences` : 'Skip this occurrence', bulk ? bulk.onSkip : onSkip, bulk ? !bulk.blocked && bulk.canSkip : row.allowed_actions.includes('skip'), blockedReason ?? row.pause_reason ?? 'Every selected schedule must allow skipping.')}
        {!bulk && item('Edit schedule', onEdit, row.allowed_actions.includes('edit'))}
        <ActionMenuItem ref={sendRef} aria-haspopup="menu" aria-expanded={flyout} disabled={!accounts.length || bulk?.blocked} title={sendReason} onPointerEnter={() => openFlyout()} onClick={() => openFlyout(true)} onKeyDown={(event) => {
          if (isComposingKey(event.nativeEvent)) return
          if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openFlyout(true) }
        }}>Send to account <ChevronRight aria-hidden="true" /></ActionMenuItem>
        <span role="separator" />
        {!bulk && item('Delete schedule…', onDelete, row.allowed_actions.includes('delete'), undefined, true)}
      </>}
    </ActionMenu>
    {flyout && <ActionMenu anchorRef={sendRef} menuRef={flyoutRef} relatedRefs={[menuRef]} width={220} placement="side" autoFocus={false} aria-label="Send schedule to account" onDismiss={(reason) => {
      if (reason === 'escape') closeFlyout()
      else if (reason === 'outside') onDismiss()
      else dismiss()
    }} onKeyDown={(event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); closeFlyout() }
    }}>
      {accounts.map((account) => <ActionMenuItem key={account.id} onClick={() => { dismiss(); if (bulk) bulk.onSend(account); else onSend(row, account) }}>{account.name}</ActionMenuItem>)}
    </ActionMenu>}
  </>
}
