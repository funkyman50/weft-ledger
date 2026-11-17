import { accountInScope, type AccountScope } from '../../lib/accountScope'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { ApiError, apiClient } from '../../api/client'
import { localDate } from '../../lib/date'
import { formatCents } from '../../lib/money'
import {
  invalidateAccountAndTransactionQueries,
  useBulkApplyTransactions,
  useCreatePayee,
} from '../../api/hooks'
import type {
  LedgerEditCommand,
  LedgerBulkApplyCommand,
  LedgerRow,
  LedgerTarget,
  ManualEntryCommand,
  TransactionFlag,
  Account,
  CategoryTree,
  Payee,
  TransferReviewProposal,
  TransactionCategorization,
} from '../../api/types'
import { statusLabel } from './transactionDisplay'
import { useLedgerCommands } from './useLedgerCommands'
import type { SplitDraft } from './LedgerSplitEditor'
import { focusEntryField } from './ledgerFocus'
import { canAutofillPayeeCategory, payeeEntryCategory } from './payeeCategory'

interface ManualEntryDraft {
  readonly is_draft: true
  readonly entryOrigin: 'transaction' | 'transfer'
  transferShortcutActive: boolean
  duplicate_source_id?: number
  id: number
  account_id: number
  date: string
  description: string
  payee_id: number | null
  transfer_account_id: number | null
  category_id: number | null
  memo: string
  amount_cents: number
  status: 'uncleared'
  manually_cleared: false
  approved: true
  source: 'manual'
  flag: TransactionFlag
  payee_name?: string | null
  category_name?: string | null
  subcategory_name?: string | null
  missing_pending: false
  editable_fields: string[]
  allocations: LedgerRow['allocations']
  category_assigned: boolean
  edit_token: ''
}

export function splitAmountText(cents: number): string {
  return formatCents(cents, { symbol: true }).replace(/^-/, '−')
}

export function parseLedgerAmount(value: string): number | null {
  const normalized = value.trim().replace(/[$,\s]/g, '').replace(/^−/, '-')
  if (!/^[+-]?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return null
  const amount = Number(normalized)
  return Number.isFinite(amount) ? Math.round(amount * 100) : null
}

export type EntryIssue = { field: string; message: string }

export function validEntryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) === 0) return false
  const day = new Date(`${value}T12:00:00`)
  return Number.isFinite(day.getTime()) && day.getFullYear() === Number(value.slice(0, 4)) && day.getMonth() + 1 === Number(value.slice(5, 7)) && day.getDate() === Number(value.slice(8, 10))
}

export function newEntryIssues(entry: { date: string; payeeId: number | null; transferAccountId: number | null; categoryId: number | null; accountId: number; amount: string }, categories: CategoryTree[], payees: Payee[], accounts: Account[]): EntryIssue[] {
  const issues: EntryIssue[] = []
  const category = categories.flatMap((parent) => parent.children).find((child) => child.id === entry.categoryId)
  const payee = payees.find((item) => item.id === entry.payeeId)
  const transfer = entry.transferAccountId !== null
  const amount = parseLedgerAmount(entry.amount)
  if (!validEntryDate(entry.date)) issues.push({ field: 'date', message: 'Choose a valid date.' })
  if (!payee) issues.push({ field: 'payee', message: 'Choose a saved payee for the transaction.' })
  if (entry.categoryId !== null && (!category || category.archived || categories.some((parent) => parent.archived && parent.children.includes(category)))) issues.push({ field: 'category', message: 'Choose an available category, or leave it uncategorized.' })
  if (transfer) {
    const target = accounts.find((account) => account.id === entry.transferAccountId)
    if (!target || target.closed || target.id === entry.accountId || target.plaid_connection && target.starting_balance_initialized_at === null) issues.push({ field: 'transfer_account_id', message: 'Choose a different open, initialized transfer account.' })
  }
  if (amount === null || !Number.isSafeInteger(amount)) issues.push({ field: 'amount_cents', message: 'Enter a valid amount with no more than two decimal places.' })
  else if (transfer && amount === 0) issues.push({ field: 'amount_cents', message: 'Transfers require a nonzero amount.' })
  return issues
}

export function useNewEntryExit(onBlocked: () => void) {
  const [dialog, setDialog] = useState<{ issues: EntryIssue[]; discard: () => boolean; focus: () => void } | null>(null)
  const pending = useRef<{ promise: Promise<EditorCompletion>; resolve: (result: EditorCompletion) => void } | null>(null)
  const settle = useCallback((result: EditorCompletion) => {
    const request = pending.current
    pending.current = null
    setDialog(null)
    request?.resolve(result)
  }, [])
  useEffect(() => () => { pending.current?.resolve('retained'); pending.current = null }, [])
  const request = useCallback((options: { reason: 'leave' | 'save' | 'cancel'; hasWork: boolean; issues: EntryIssue[]; save: () => Promise<EditorCompletion>; discard: () => boolean; focus: () => void }): Promise<EditorCompletion> => {
    if (pending.current) return pending.current.promise
    if (options.reason !== 'save' && !options.hasWork) return Promise.resolve(options.discard() ? 'finished' : 'retained')
    let resolve!: (result: EditorCompletion) => void
    const promise = new Promise<EditorCompletion>((complete) => { resolve = complete })
    pending.current = { promise, resolve }
    if (options.reason !== 'save' || options.issues.length) setDialog({ issues: options.reason === 'save' ? options.issues : [], discard: options.discard, focus: options.focus })
    else {
      const complete = (result: EditorCompletion) => { if (pending.current?.promise === promise) settle(result) }
      void options.save().then(complete, () => complete('retained'))
    }
    return promise
  }, [settle])
  const continueEditing = () => {
    const focus = dialog?.focus
    settle('retained')
    requestAnimationFrame(() => focus?.())
  }
  const discard = () => {
    if (!dialog) return
    if (dialog.discard()) settle('finished')
    else onBlocked()
  }
  return { dialog, request, continueEditing, discard, reset: settle }
}

interface LedgerEditState {
  row: LedgerDisplayRow
  accountId: number
  id: number
  isNew: boolean
  duplicateSourceId?: number
  original: {
    date: string
    payeeId: number | null
    transferAccountId: number | null
    categoryId: number | null
    memo: string
    amountCents: number
    flag: TransactionFlag
    editToken: string
  }
  draft: {
    date: string
    payeeId: number | null
    payeeSuggestionKey?: string
    transferAccountId: number | null
    categoryId: number | null
    categoryTouched: boolean
    categoryProtected: boolean
    categoryAutofilled: boolean
    memo: string
    amount: string
    flag: TransactionFlag
  }
}

function newSplitDraft(row: LedgerDisplayRow, parentAmount: string, preserveIds = true): SplitDraft {
  const allocations = row.allocations.length
    ? row.allocations.map((allocation) => ({ key: `saved-${allocation.id}`, id: preserveIds ? allocation.id : undefined, categoryId: allocation.category_id, categoryTouched: true, memo: allocation.memo, amount: splitAmountText(allocation.amount_cents), unassigned: allocation.unassigned }))
    : [
        { key: 'initial-1', categoryId: row.category_id, categoryTouched: row.category_assigned, memo: '', amount: '', unassigned: false },
        { key: 'initial-2', categoryId: null, categoryTouched: false, memo: '', amount: '', unassigned: false },
      ]
  return { rowId: row.id, parentAmount, originalToken: row.edit_token, allocations }
}

function newManualDraft(accountId: number, source?: LedgerRow, entryOrigin: ManualEntryDraft['entryOrigin'] = 'transaction'): ManualEntryDraft {
  const date = localDate(new Date())
  return {
    is_draft: true,
    entryOrigin,
    transferShortcutActive: entryOrigin === 'transfer',
    id: -Date.now() * 1000,
    account_id: accountId,
    date,
    description: source?.description ?? '',
    duplicate_source_id: source?.id,
    payee_id: source?.payee_id ?? null,
    transfer_account_id: source?.transfer_account_id ?? null,
    category_id: source?.category_id ?? null,
    memo: source?.memo ?? '',
    amount_cents: source?.amount_cents ?? 0,
    status: 'uncleared',
    manually_cleared: false,
    approved: true,
    source: 'manual',
    flag: source?.flag ?? null,
    missing_pending: false,
    editable_fields: ['date', 'payee_id', 'transfer_account_id', 'category_id', 'memo', 'amount_cents', 'flag'],
    allocations: source?.allocations ?? [],
    category_assigned: source?.category_assigned ?? false,
    edit_token: '',
  }
}

export type LedgerDisplayRow = LedgerRow | ManualEntryDraft
export type EditorCompletion = 'finished' | 'retained'
export type EditorTransferIntent =
  | { kind: 'draft'; id: number; proposal: TransferReviewProposal }
  | { kind: 'proposal'; row: LedgerRow; proposal: TransferReviewProposal }
  | { kind: 'saved'; row: LedgerRow }
type EditorSaveResult = { kind: 'finished'; row?: LedgerRow } | { kind: 'retained' }

function amountInputValue(cents: number): string {
  return (cents / 100).toFixed(2)
}

function editState(row: LedgerDisplayRow): LedgerEditState {
  const original = {
    date: row.date, payeeId: row.payee_id, transferAccountId: row.transfer_account_id, categoryId: row.category_id,
    memo: row.memo, amountCents: row.amount_cents,
    flag: row.flag, editToken: row.edit_token,
  }
  return {
    row,
    id: row.id, accountId: row.account_id, isNew: 'is_draft' in row, duplicateSourceId: 'is_draft' in row ? row.duplicate_source_id : undefined, original,
    draft: {
      date: original.date, payeeId: original.payeeId, transferAccountId: original.transferAccountId, categoryId: original.categoryId,
      categoryTouched: 'is_draft' in row ? row.category_assigned : false,
      categoryProtected: row.category_assigned || row.category_id !== null,
      categoryAutofilled: false,
      memo: original.memo,
      amount: 'is_draft' in row && row.duplicate_source_id === undefined && row.amount_cents === 0 ? '' : amountInputValue(row.amount_cents),
      flag: original.flag,
    },
  }
}

function editPayload(current: LedgerEditState, amount: number): LedgerEditCommand {
  const payload: LedgerEditCommand = {}
  if (current.draft.date !== current.original.date) payload.date = current.draft.date
  if (current.draft.payeeId !== current.original.payeeId) payload.payee_id = current.draft.payeeId
  if (current.draft.transferAccountId !== current.original.transferAccountId) payload.transfer_account_id = current.draft.transferAccountId
  if (current.draft.categoryTouched || current.draft.categoryAutofilled || current.draft.categoryId !== current.original.categoryId) payload.categorization = { kind: 'single', category_id: current.draft.categoryId }
  if (current.draft.memo !== current.original.memo) payload.memo = current.draft.memo
  if (amount !== current.original.amountCents) payload.amount_cents = amount
  if (current.draft.flag !== current.original.flag) payload.flag = current.draft.flag
  return payload
}

function hasEditChanges(current: LedgerEditState): boolean {
  const amount = parseLedgerAmount(current.draft.amount)
  return amount === null || Object.keys(editPayload(current, amount)).length > 0
}

function hasNewEntryWork({ draft, original, duplicateSourceId }: LedgerEditState): boolean {
  return duplicateSourceId !== undefined || draft.date !== original.date || draft.payeeId !== null || draft.transferAccountId !== null || draft.categoryId !== null || Boolean(draft.memo.trim() || draft.amount.trim() || draft.flag)
}

function manualPayload(current: LedgerEditState, amount: number): ManualEntryCommand {
  return {
    account_id: current.accountId, date: current.draft.date, payee_id: current.draft.payeeId,
    transfer_account_id: current.draft.transferAccountId,
    ...(current.duplicateSourceId !== undefined ? { duplicate_source_id: current.duplicateSourceId } : {}),
    ...(current.draft.categoryTouched || current.draft.categoryAutofilled || current.draft.categoryId !== null ? { categorization: { kind: 'single' as const, category_id: current.draft.categoryId } } : {}),
    memo: current.draft.memo, amount_cents: amount, flag: current.draft.flag,
  }
}

export function useLedgerEditor({
  accountId,
  transactions,
  viewKey,
  refreshAfterApply,
  commands,
  onExplicitCategorySaved,
  showNewTransaction,
  reviewAfterEdit,
  onAnnounce,
  categories,
  payees,
  accounts,
  exitBlocked,
  onNotice,
}: {
  accountId: AccountScope | null
  transactions: LedgerRow[]
  viewKey: string
  refreshAfterApply: (originViewKey: string, reviewed: boolean) => Promise<boolean>
  commands: ReturnType<typeof useLedgerCommands>
  categories: CategoryTree[]
  payees: Payee[]
  accounts: Account[]
  exitBlocked: () => boolean
  onNotice: (message: string, tone?: 'error') => void
  onExplicitCategorySaved?: (row: LedgerRow) => void
  showNewTransaction: boolean
  reviewAfterEdit: boolean
  onAnnounce: (message: string) => void
}) {
  const queryClient = useQueryClient()
  const bulkApplyTransactions = useBulkApplyTransactions()
  const [editTransactionId, setEditTransactionId] = useState<number | null>(null)
  const [newTransactionDraft, setNewTransactionDraft] = useState<ManualEntryDraft | null>(null)
  const [newEntryReveal, setNewEntryReveal] = useState<{ id: number; draftId: number; viewKey: string; navigationRevision: number } | null>(null)
  const navigationRevisionRef = useRef(0)
  const [editing, setEditing] = useState<LedgerEditState | null>(null)
  const editingRef = useRef<LedgerEditState | null>(null)
  const [splitDraft, setSplitDraft] = useState<SplitDraft | null>(null)
  const [splitTouched, setSplitTouched] = useState(false)
  const splitDraftRef = useRef<SplitDraft | null>(null)
  const saveRef = useRef<Promise<EditorSaveResult> | null>(null)
  const entryExit = useNewEntryExit(() => onNotice('Wait for the current update or inspect its result first.'))
  const exitBlockedRef = useRef(exitBlocked)
  exitBlockedRef.current = exitBlocked
  const mountedRef = useRef(true)
  const currentViewRef = useRef(viewKey)
  currentViewRef.current = viewKey
  const currentScopeRef = useRef({ accountId, accounts })
  currentScopeRef.current = { accountId, accounts }
  const createPayee = useCreatePayee()
  const [quickCreatePending, setQuickCreatePending] = useState(false)
  const [quickCreateRecovery, setQuickCreateRecovery] = useState(false)
  const [quickCreateError, setQuickCreateError] = useState<string | null>(null)
  const quickCreatePendingRef = useRef(false)
  const quickCreateRecoveryRef = useRef(false)
  const [splitAnchorRow, setSplitAnchorRow] = useState<LedgerRow | null>(null)
  const creationRefreshed = useRef(true)
  const [creatingTransaction, setCreatingTransaction] = useState(false)
  const manualClearBusy = useRef(false)
  const [manualClearPending, setManualClearPending] = useState(false)
  const [manualClearRecovery, setManualClearRecovery] = useState<{ id: number; message: string } | null>(null)

  const beginManualTransaction = useCallback((explicitAccountId?: number, entryOrigin: ManualEntryDraft['entryOrigin'] = 'transaction') => {
    const draftAccountId = explicitAccountId ?? (typeof accountId === 'number' ? accountId : null)
    if (draftAccountId === null) return
    if (newTransactionDraft) {
      setEditTransactionId(newTransactionDraft.id)
      return
    }
    const draft = newManualDraft(draftAccountId, undefined, entryOrigin)
    setNewTransactionDraft(draft)
    setEditTransactionId(draft.id)
  }, [accountId, newTransactionDraft])

  const beginDuplicate = useCallback((source: LedgerRow) => {
    if (newTransactionDraft) return
    const draft = newManualDraft(source.account_id, source)
    setNewTransactionDraft(draft)
    setEditTransactionId(draft.id)
  }, [newTransactionDraft])

  const refreshCreated = useCallback(async (created: LedgerRow, originView: string, draftId: number, navigationRevision = navigationRevisionRef.current) => {
    let refreshed = false
    try {
      refreshed = await refreshAfterApply(originView, false)
    } catch {
      refreshed = false
    }
    if (!mountedRef.current || currentViewRef.current !== originView) return false
    if (!refreshed) {
      onNotice('Transaction saved, but the register could not refresh. Refresh the register to see it.')
      return false
    }
    if (created.source === 'plaid') onNotice('Transaction saved and matched with a bank transaction.')
    else onAnnounce('Transaction saved.')
    if (showNewTransaction && accountInScope(currentScopeRef.current.accounts.find((account) => account.id === created.account_id), currentScopeRef.current.accountId)) setNewEntryReveal({ id: created.id, draftId, viewKey: originView, navigationRevision })
    return true
  }, [onAnnounce, onNotice, refreshAfterApply, showNewTransaction])

  const completeNewEntryReveal = useCallback((found: boolean | null, hasMore = false) => {
    setNewEntryReveal(null)
    if (found === false) onNotice(hasMore
      ? 'Transaction saved outside the current view. Adjust filters or scroll to the top of the register to load earlier history.'
      : 'Transaction saved but hidden by the current filters. Adjust filters to see it.')
  }, [onNotice])

  const createTransaction = useCallback(async (payload: ManualEntryCommand, draftId: number) => {
    const navigationRevision = navigationRevisionRef.current
    setCreatingTransaction(true)
    try {
      const created = await apiClient.post<LedgerRow>('/api/transactions', payload)
      if (created.payee_category_memory) queryClient.setQueryData<Payee[]>(['payees'], (current) => current?.map((payee) => payee.id === created.payee_category_memory?.payee_id ? { ...payee, remembered_category_id: created.payee_category_memory.remembered_category_id } : payee))
      const refreshed = await refreshCreated(created, viewKey, draftId, navigationRevision)
      creationRefreshed.current = refreshed
      void invalidateAccountAndTransactionQueries(queryClient, { refetchLedger: false, refetchAccounts: true })
      if (refreshed && payload.categorization?.kind === 'single' && payload.categorization.category_id !== null) onExplicitCategorySaved?.(created)
      return created
    } finally {
      setCreatingTransaction(false)
    }
  }, [onExplicitCategorySaved, queryClient, refreshCreated, viewKey])

  const update = useCallback(async (id: number, payload: LedgerEditCommand) => {
    const row = transactions.find((transaction) => transaction.id === id)
    if (!row) throw new ApiError(409, { code: 'transaction_not_available', message: 'Refresh and try again.' })
    const saved = await commands.update(row, payload)
    if (saved.payee_category_memory) queryClient.setQueryData<Payee[]>(['payees'], (current) => current?.map((payee) => payee.id === saved.payee_category_memory?.payee_id ? { ...payee, remembered_category_id: saved.payee_category_memory.remembered_category_id } : payee))
    if (payload.categorization?.kind === 'single' && payload.categorization.category_id !== null && row.allocations.length === 0 && row.payee_kind === 'ordinary' && saved.allocations.length === 0 && saved.payee_kind === 'ordinary') onExplicitCategorySaved?.(saved)
    return saved
  }, [commands, onExplicitCategorySaved, queryClient, transactions])

  const review = useCallback(async (id: number, approved: boolean) => {
    const row = transactions.find((transaction) => transaction.id === id)
    if (!row) throw new ApiError(409, { code: 'transaction_not_available', message: 'Refresh and try again.' })
    await commands.review(row, approved)
  }, [commands, transactions])

  const bulkApply = useCallback(async (payload: LedgerBulkApplyCommand) => {
    const result = await bulkApplyTransactions.mutateAsync(payload)
    void queryClient.invalidateQueries({ queryKey: ['accounts'] })
    if ('category_id' in payload.changes) void queryClient.invalidateQueries({ queryKey: ['categories'] })
    return result
  }, [bulkApplyTransactions, queryClient])

  const toggleClearance = useCallback(async (transaction: LedgerRow) => {
    await commands.clearance(transaction)
  }, [commands])

  const runContextCommand = useCallback(async <T,>(path: string, payload: unknown): Promise<T> => {
    const result = await apiClient.post<T>(path, payload)
    await invalidateAccountAndTransactionQueries(queryClient)
    return result
  }, [queryClient])
  const moveMany = useCallback((targets: LedgerTarget[], destination_account_id: number) => runContextCommand<{ status: string }>('/api/transactions/bulk-move', { targets, destination_account_id }), [runContextCommand])
  const deleteMany = useCallback((targets: LedgerTarget[]) => runContextCommand<{ status: string }>('/api/transactions/bulk-delete', { targets }), [runContextCommand])
  const exclude = useCallback((target: LedgerTarget) => runContextCommand<LedgerRow>('/api/transactions/exclude', { targets: [target] }), [runContextCommand])
  const restore = useCallback((targets: LedgerTarget[]) => runContextCommand<{ status: string }>('/api/transactions/restore', { targets }), [runContextCommand])

  const refreshManualClear = useCallback(async () => {
    const freshAccounts = await apiClient.get<Account[]>('/api/accounts')
    queryClient.setQueryData(['accounts'], freshAccounts)
    if (!await refreshAfterApply(viewKey, false)) throw new Error('The register view changed. Refresh again to inspect the transaction.')
    void invalidateAccountAndTransactionQueries(queryClient, { refetchLedger: false })
  }, [queryClient, refreshAfterApply, viewKey])

  const manualClearance = useCallback(async (transaction: LedgerRow, intent: 'clear' | 'undo') => {
    if (manualClearBusy.current || manualClearRecovery) return
    manualClearBusy.current = true
    setManualClearPending(true)
    try {
      try {
        await apiClient.post<LedgerRow>(`/api/transactions/${transaction.id}/manual-clearance`, { intent, expected_edit_token: transaction.edit_token })
      } catch (error) {
        const knownFailure = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== 'unknown_error'
        if (!knownFailure || (error instanceof ApiError && error.status === 409)) {
          setManualClearRecovery({ id: transaction.id, message: knownFailure ? 'The transaction changed. Refresh and inspect it before trying again.' : 'The manual-clear outcome is unknown. Refresh and inspect the transaction before trying again.' })
        }
        throw error
      }
      try {
        await refreshManualClear()
      } catch {
        setManualClearRecovery({ id: transaction.id, message: 'Manual clearance saved, but the register could not be refreshed.' })
      }
    } finally {
      manualClearBusy.current = false
      setManualClearPending(false)
    }
  }, [manualClearRecovery, refreshManualClear])

  const recoverManualClear = useCallback(async () => {
    if (!manualClearRecovery || manualClearBusy.current) return ''
    manualClearBusy.current = true
    setManualClearPending(true)
    try {
      let inspected: LedgerRow | null
      try {
        inspected = await apiClient.get<LedgerRow>(`/api/transactions/${manualClearRecovery.id}`)
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error
        inspected = null
      }
      await refreshManualClear()
      setManualClearRecovery(null)
      return inspected ? `Transaction refreshed: ${statusLabel(inspected)}.` : 'The transaction is no longer available.'
    } finally {
      manualClearBusy.current = false
      setManualClearPending(false)
    }
  }, [manualClearRecovery, refreshManualClear])

  const ledgerTransactions = useMemo(() => {
    const anchorRow = splitAnchorRow ?? (editing && !editing.isNew ? editing.row : null)
    const rows = anchorRow
      ? transactions.some((row) => row.id === anchorRow.id)
        ? splitAnchorRow ? transactions.map((row) => row.id === anchorRow.id ? anchorRow : row) : transactions
        : [...transactions, anchorRow]
      : transactions
    return newTransactionDraft ? [...rows, newTransactionDraft] : rows
  }, [editing, newTransactionDraft, splitAnchorRow, transactions])
  const cancelNewTransaction = useCallback((id: number) => {
    setNewTransactionDraft((current) => current?.id === id ? null : current)
  }, [])
  const finishEditing = useCallback(() => setEditTransactionId(null), [])
  const replaceEditing = useCallback((next: LedgerEditState) => {
    editingRef.current = next
    setEditing(next)
  }, [])
  const replaceSplitDraft = useCallback((next: SplitDraft | null) => {
    splitDraftRef.current = next
    setSplitDraft(next)
  }, [])
  const clearEditing = useCallback((id?: number) => {
    if (id !== undefined && editingRef.current?.id !== id) return false
    editingRef.current = null
    setEditing(null)
    replaceSplitDraft(null)
    setSplitTouched(false)
    setSplitAnchorRow(null)
    return true
  }, [replaceSplitDraft])
  const cancelEditing = useCallback(() => {
    const current = editingRef.current
    if (!current) return true
    if (saveRef.current || quickCreatePendingRef.current || quickCreateRecoveryRef.current) return false
    clearEditing()
    if (current.isNew) cancelNewTransaction(current.id)
    return true
  }, [cancelNewTransaction, clearEditing])
  const finishTransferDraft = useCallback((id: number, saved?: LedgerRow) => {
    const originView = currentViewRef.current
    const isCurrent = editingRef.current?.id === id
    cancelNewTransaction(id)
    clearEditing(id)
    if (isCurrent && saved) void refreshCreated(saved, originView, id)
  }, [cancelNewTransaction, clearEditing, refreshCreated])
  const finishTransferSaved = useCallback((id: number) => {
    setEditTransactionId(null)
    clearEditing(id)
  }, [clearEditing])
  const reportError = useCallback((message: string, originView = viewKey, tone?: 'error') => {
    if (mountedRef.current && currentViewRef.current === originView) onNotice(message, tone)
  }, [onNotice, viewKey])
  const beginEditing = useCallback((row: LedgerDisplayRow) => {
    if (saveRef.current || quickCreatePendingRef.current || quickCreateRecoveryRef.current) return false
    if (editingRef.current?.id === row.id) return true
    if (editingRef.current || row.editable_fields.length === 0) return false
    const next = editState(row)
    replaceEditing(next)
    if (row.allocations.length) {
      setSplitAnchorRow('is_draft' in row ? null : row)
      replaceSplitDraft(newSplitDraft(row, next.draft.amount, !('is_draft' in row)))
      setSplitTouched(false)
    }
    return true
  }, [replaceEditing, replaceSplitDraft])
  const patchEditing = useCallback((patch: Partial<LedgerEditState['draft']>) => {
    if (saveRef.current || quickCreatePendingRef.current || quickCreateRecoveryRef.current) return
    const current = editingRef.current
    if (!current) return
    const draft = { ...current.draft, ...patch }
    if (patch.categoryTouched) {
      draft.categoryProtected = true
      draft.categoryAutofilled = false
    }
    if ('transferAccountId' in patch && patch.transferAccountId !== null && draft.categoryAutofilled) {
      draft.categoryId = null
      draft.categoryAutofilled = false
    }
    if ('transferAccountId' in patch && patch.transferAccountId !== current.draft.transferAccountId && draft.payeeSuggestionKey) {
      draft.payeeId = null
      draft.payeeSuggestionKey = undefined
    }
    if ('payeeId' in patch) draft.payeeSuggestionKey = undefined
    if ('payeeId' in patch && patch.payeeId !== current.draft.payeeId && draft.transferAccountId === null && !splitDraftRef.current && canAutofillPayeeCategory(draft.categoryId, draft.categoryProtected, draft.categoryAutofilled)) {
      const categoryId = payeeEntryCategory(draft.payeeId, payees, categories)
      draft.categoryId = categoryId
      draft.categoryAutofilled = categoryId !== null
      draft.categoryTouched = false
    }
    if (splitDraftRef.current) {
      setSplitTouched(true)
      if ('amount' in patch) replaceSplitDraft({ ...splitDraftRef.current, parentAmount: draft.amount })
    }
    replaceEditing({ ...current, draft })
  }, [categories, payees, replaceEditing, replaceSplitDraft])
  const transferProposal = useCallback((current: LedgerEditState, payeeId: number, amount: number): TransferReviewProposal => ({
    payee_id: payeeId,
    transfer_account_id: current.draft.transferAccountId!,
    draft: {
      date: current.draft.date,
      ...(current.duplicateSourceId !== undefined ? { duplicate_source_id: current.duplicateSourceId } : {}),
      amount_cents: amount,
      memo: current.draft.memo,
      flag: current.draft.flag,
      ...(current.draft.categoryTouched || current.draft.categoryAutofilled || current.draft.categoryId !== current.original.categoryId ? { categorization: { kind: 'single' as const, category_id: current.draft.categoryId } } : {}),
    },
  }), [])
  const dismissTransferShortcut = useCallback(() => {
    if (saveRef.current || quickCreatePendingRef.current || quickCreateRecoveryRef.current) return
    const id = editingRef.current?.isNew ? editingRef.current.id : null
    setNewTransactionDraft((current) => current?.id === id && current.transferShortcutActive ? { ...current, transferShortcutActive: false } : current)
  }, [])
  const chooseCategory = useCallback((categoryId: number | null) => {
    patchEditing({ categoryId, categoryTouched: true })
  }, [patchEditing])
  const choosePayee = useCallback((payeeId: number | null) => {
    if (saveRef.current || quickCreatePendingRef.current || quickCreateRecoveryRef.current) return
    dismissTransferShortcut()
    patchEditing({ payeeId })
  }, [dismissTransferShortcut, patchEditing])
  const chooseTransfer = useCallback((transferAccountId: number | null) => {
    dismissTransferShortcut()
    patchEditing({ transferAccountId })
  }, [dismissTransferShortcut, patchEditing])
  const suggestionDirection = editing ? Math.sign(parseLedgerAmount(editing.draft.amount) ?? 0) || -1 : -1
  useEffect(() => {
    const current = editingRef.current
    if (!current?.isNew || current.draft.transferAccountId === null || !validEntryDate(current.draft.date)) return
    const key = `${current.accountId}:${current.draft.transferAccountId}:${current.draft.date}:${suggestionDirection}`
    if (current.draft.payeeSuggestionKey === key) return
    if (current.draft.payeeSuggestionKey) {
      replaceEditing({ ...current, draft: { ...current.draft, payeeId: null, payeeSuggestionKey: undefined } })
      return
    }
    if (current.draft.payeeId !== null) return
    const controller = new AbortController()
    const params = new URLSearchParams({ account_id: String(current.accountId), transfer_account_id: String(current.draft.transferAccountId), direction: String(suggestionDirection), on_date: current.draft.date })
    void apiClient.get<{ payee_id: number | null }>(`/api/transactions/transfer-payee-suggestion?${params}`, controller.signal).then(({ payee_id }) => {
      const latest = editingRef.current
      if (controller.signal.aborted || !latest || latest.id !== current.id || latest.draft.payeeId !== null || latest.draft.transferAccountId !== current.draft.transferAccountId || latest.draft.date !== current.draft.date || (Math.sign(parseLedgerAmount(latest.draft.amount) ?? 0) || -1) !== suggestionDirection || payee_id === null) return
      replaceEditing({ ...latest, draft: { ...latest.draft, payeeId: payee_id, payeeSuggestionKey: key } })
    }).catch(() => undefined)
    return () => controller.abort()
  }, [editing?.accountId, editing?.draft.transferAccountId, editing?.draft.date, suggestionDirection, editing?.draft.payeeId, editing?.draft.payeeSuggestionKey, replaceEditing])
  const startSplit = useCallback((row: LedgerDisplayRow) => {
    if (saveRef.current || quickCreatePendingRef.current || quickCreateRecoveryRef.current) return
    const current = editingRef.current
    if (!current || current.id !== row.id) return
    dismissTransferShortcut()
    setSplitAnchorRow('is_draft' in row ? null : row)
    replaceSplitDraft(newSplitDraft({ ...row, category_id: current.draft.categoryId, category_assigned: current.draft.categoryTouched || row.category_assigned }, current.draft.amount))
    setSplitTouched(hasEditChanges(current))
  }, [dismissTransferShortcut, replaceSplitDraft])
  const changeSplit = useCallback((next: SplitDraft) => {
    if (saveRef.current || quickCreatePendingRef.current || quickCreateRecoveryRef.current || splitDraftRef.current?.rowId !== next.rowId) return
    replaceSplitDraft(next)
    setSplitTouched(true)
  }, [replaceSplitDraft])
  const reloadSplit = useCallback((row: LedgerRow) => {
    if (editingRef.current?.id !== row.id || splitDraftRef.current?.rowId !== row.id) return
    if (!row.allocations.length) { clearEditing(row.id); return }
    const next = editState(row)
    replaceEditing(next)
    setSplitAnchorRow(row)
    replaceSplitDraft(newSplitDraft(row, next.draft.amount))
    setSplitTouched(false)
  }, [clearEditing, replaceEditing, replaceSplitDraft])
  const unsplitDraft = useCallback((categoryId: number | null) => {
    if (saveRef.current || quickCreatePendingRef.current || quickCreateRecoveryRef.current) return
    replaceSplitDraft(null)
    setSplitTouched(false)
    setSplitAnchorRow(null)
    patchEditing({ categoryId, categoryTouched: true })
  }, [patchEditing, replaceSplitDraft])
  const upsertPayee = useCallback((payee: Payee) => {
    queryClient.setQueryData<Payee[]>(['payees'], (current) => [...(current ?? []).filter((item) => item.id !== payee.id), payee].sort((left, right) => left.name.localeCompare(right.name)))
    void queryClient.invalidateQueries({ queryKey: ['payees'] }).catch(() => undefined)
  }, [queryClient])
  const selectCreatedPayee = useCallback((origin: LedgerEditState, originView: string, payee: Payee) => {
    if (!mountedRef.current || currentViewRef.current !== originView || editingRef.current !== origin) return false
    if (splitDraftRef.current) setSplitTouched(true)
    const draft = { ...origin.draft, payeeId: payee.id }
    if (draft.transferAccountId === null && !splitDraftRef.current && canAutofillPayeeCategory(draft.categoryId, draft.categoryProtected, draft.categoryAutofilled)) {
      draft.categoryId = payeeEntryCategory(payee.id, [payee], categories)
      draft.categoryAutofilled = draft.categoryId !== null
      draft.categoryTouched = false
    }
    replaceEditing({ ...origin, draft })
    return true
  }, [categories, replaceEditing])
  const createQuickPayee = useCallback(async (name: string) => {
    const origin = editingRef.current
    const originView = currentViewRef.current
    if (!origin || saveRef.current || quickCreatePendingRef.current || quickCreateRecoveryRef.current) return false
    quickCreatePendingRef.current = true
    setQuickCreatePending(true)
    setQuickCreateError(null)
    try {
      const payee = await createPayee.mutateAsync({ name })
      return selectCreatedPayee(origin, originView, payee)
    } catch (error) {
      const conflict = error instanceof ApiError && error.code === 'payee_name_conflict'
        ? (error.detail as { payee?: Payee } | undefined)?.payee : undefined
      if (conflict) { upsertPayee(conflict); return selectCreatedPayee(origin, originView, conflict) }
      if (!(error instanceof ApiError) || error.status >= 500) {
        quickCreateRecoveryRef.current = true
        setQuickCreateRecovery(true)
        return false
      }
      setQuickCreateError(error.message)
      return false
    } finally {
      quickCreatePendingRef.current = false
      setQuickCreatePending(false)
    }
  }, [createPayee, selectCreatedPayee, upsertPayee])
  const recoverQuickCreate = useCallback(async (inspectHistory: () => Promise<unknown>) => {
    if (!quickCreateRecoveryRef.current || quickCreatePendingRef.current) return
    quickCreatePendingRef.current = true
    setQuickCreatePending(true)
    setQuickCreateError(null)
    try {
      await inspectHistory()
      const refreshed = await apiClient.get<Payee[]>('/api/payees')
      queryClient.setQueryData(['payees'], refreshed)
      quickCreateRecoveryRef.current = false
      setQuickCreateRecovery(false)
      setQuickCreateError(null)
    } catch {
      setQuickCreateError('Refresh failed. Create remains blocked until it can be inspected.')
    } finally {
      quickCreatePendingRef.current = false
      setQuickCreatePending(false)
    }
  }, [queryClient])
  const clearQuickCreateError = useCallback(() => setQuickCreateError(null), [])
  const runSave = useCallback((operation: () => Promise<EditorSaveResult>): Promise<EditorSaveResult> => {
    if (saveRef.current) return saveRef.current
    if (quickCreatePendingRef.current || quickCreateRecoveryRef.current) return Promise.resolve({ kind: 'retained' })
    if (editingRef.current && commands.pendingRowIds.has(editingRef.current.id)) {
      reportError('This transaction is still saving.')
      return Promise.resolve({ kind: 'retained' })
    }
    const promise = Promise.resolve().then(operation).finally(() => {
      if (saveRef.current === promise) saveRef.current = null
    })
    saveRef.current = promise
    return promise
  }, [commands.pendingRowIds, reportError])
  const currentSubmission = useCallback((origin: LedgerEditState, originView: string) => (
    mountedRef.current && currentViewRef.current === originView && editingRef.current?.id === origin.id
  ), [])
  const commitEditing = useCallback(async (onTransfer: (intent: EditorTransferIntent) => void): Promise<EditorCompletion> => {
    if (splitDraftRef.current) return 'retained'
    const originView = currentViewRef.current
    const result = await runSave(async () => {
      const current = editingRef.current
      if (!current) return { kind: 'finished' }
      const amount = parseLedgerAmount(current.draft.amount)
      const destination = current.draft.transferAccountId
      if (amount === 0 && destination !== null) {
        reportError('Transfers require a nonzero amount.', originView, 'error')
        return { kind: 'retained' }
      }
      if (current.isNew && (!current.draft.date || current.draft.payeeId === null || amount === null)) {
        reportError('A new transaction requires a date and valid amount.', originView)
        return { kind: 'retained' }
      }
      if (amount === null) {
        reportError('Enter a valid amount with no more than two decimal places.', originView)
        return { kind: 'retained' }
      }
      if (destination !== null && (current.isNew || destination !== current.original.transferAccountId)) {
        const proposal = transferProposal(current, current.draft.payeeId!, amount)
        if (current.isNew) onTransfer({ kind: 'draft', id: current.id, proposal })
        else {
          const row = transactions.find((transaction) => transaction.id === current.id)
          if (row) onTransfer({ kind: 'proposal', row, proposal })
        }
        return { kind: 'retained' }
      }
      const payload = editPayload(current, amount)
      if (!current.isNew && Object.keys(payload).length === 0) {
        clearEditing(current.id)
        return { kind: 'finished' }
      }
      const previousDestination = transactions.find((row) => row.id === current.id)?.transfer?.account_id ?? null
      try {
        const saved = current.isNew
          ? await createTransaction(manualPayload(current, amount), current.id)
          : await update(current.id, { ...payload, expected_edit_token: current.original.editToken, ...(reviewAfterEdit ? { review_after_edit: true } : {}) })
        if (current.isNew) cancelNewTransaction(current.id)
        if (!currentSubmission(current, originView)) return { kind: 'retained' }
        clearEditing(current.id)
        if (saved.transfer && (current.isNew || saved.transfer.account_id !== previousDestination)) {
          onTransfer({ kind: 'saved', row: saved })
          return { kind: 'retained' }
        }
        return { kind: current.isNew && !creationRefreshed.current ? 'retained' : 'finished', row: saved }
      } catch (error) {
        reportError(error instanceof ApiError ? error.message : current.isNew ? 'A new transaction could not be created.' : 'Transaction changes could not be saved.', originView)
        return { kind: 'retained' }
      }
    })
    return result.kind
  }, [cancelNewTransaction, clearEditing, createTransaction, currentSubmission, reportError, reviewAfterEdit, runSave, transactions, transferProposal, update])
  const requestEntryDecision = entryExit.request
  const requestExit = useCallback(async (reason: 'leave' | 'save' | 'cancel', onTransfer: (intent: EditorTransferIntent) => void): Promise<EditorCompletion> => {
    const current = editingRef.current
    if (!current) return 'finished'
    if (exitBlockedRef.current() || quickCreatePendingRef.current || quickCreateRecoveryRef.current) return 'retained'
    if (!current.isNew || splitDraftRef.current) {
      if (reason === 'cancel') return cancelEditing() ? 'finished' : 'retained'
      if (reason === 'leave') {
        if (splitDraftRef.current) { reportError('Save or cancel the current transaction first'); return 'retained' }
        if (hasEditChanges(current)) return commitEditing(onTransfer)
        return cancelEditing() ? 'finished' : 'retained'
      }
      return commitEditing(onTransfer)
    }
    const { draft } = current
    const issues = newEntryIssues({ date: draft.date, payeeId: draft.payeeId, transferAccountId: draft.transferAccountId, categoryId: draft.categoryId, accountId: current.accountId, amount: draft.amount }, categories, payees, accounts)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return requestEntryDecision({
      reason, hasWork: hasNewEntryWork(current), issues,
      save: () => commitEditing(onTransfer),
      discard: () => !exitBlockedRef.current() && editingRef.current?.id === current.id && cancelEditing(),
      focus: () => focusEntryField(String(current.id), reason === 'save' ? issues[0]?.field : undefined, previous),
    })
  }, [accounts, cancelEditing, categories, commitEditing, requestEntryDecision, payees, reportError])
  const saveSplit = useCallback(async (categorization: TransactionCategorization, expectedToken: string): Promise<LedgerRow | null> => {
    const originView = currentViewRef.current
    const result = await runSave(async () => {
      const current = editingRef.current
      if (!current || !splitDraftRef.current) return { kind: 'retained' }
      const amount = parseLedgerAmount(current.draft.amount)
      if (amount === null) { reportError('Enter a valid amount with no more than two decimal places.', originView); return { kind: 'retained' } }
      if (current.isNew && !current.draft.date) {
        reportError('A new transaction requires a date.', originView)
        return { kind: 'retained' }
      }
      const saved = current.isNew
        ? await createTransaction({ ...manualPayload(current, amount), categorization }, current.id)
        : await update(current.id, { ...editPayload(current, amount), categorization, expected_edit_token: expectedToken, ...(reviewAfterEdit ? { review_after_edit: true } : {}) })
      if (current.isNew) cancelNewTransaction(current.id)
      if (!currentSubmission(current, originView)) return { kind: 'retained' }
      clearEditing(current.id)
      return { kind: 'finished', row: saved }
    })
    return result.kind === 'finished' ? result.row ?? null : null
  }, [cancelNewTransaction, clearEditing, createTransaction, currentSubmission, reportError, reviewAfterEdit, runSave, update])
  const previousAccountRef = useRef(accountId)
  const resetEntryExit = entryExit.reset
  useLayoutEffect(() => {
    resetEntryExit('retained')
    clearEditing()
    setNewEntryReveal(null)
    saveRef.current = null
    if (previousAccountRef.current !== accountId) {
      setNewTransactionDraft(null)
      setEditTransactionId(null)
      previousAccountRef.current = accountId
    }
  }, [accountId, clearEditing, resetEntryExit, viewKey])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const editorOpen = editing !== null
  useEffect(() => {
    if (!editorOpen) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [editorOpen])
  const ordinaryEditorActive = editing !== null && splitDraft === null
  const ordinaryEditorDirty = Boolean(editing && !splitDraft && (editing.isNew || hasEditChanges(editing)))
  const ordinaryEditorHasWork = Boolean(editing && (editing.isNew ? hasNewEntryWork(editing) : hasEditChanges(editing)))
  const splitHasChanges = Boolean(splitDraft && editing && (splitAnchorRow?.allocations.length
    ? editing.draft.date !== editing.original.date
      || editing.draft.payeeId !== editing.original.payeeId
      || editing.draft.memo !== editing.original.memo
      || editing.draft.flag !== editing.original.flag
      || parseLedgerAmount(splitDraft.parentAmount) !== editing.original.amountCents
      || splitDraft.allocations.length !== splitAnchorRow.allocations.length
      || splitDraft.allocations.some((allocation, index) => {
        const saved = splitAnchorRow.allocations[index]
        return !saved || allocation.id !== saved.id || allocation.categoryId !== saved.category_id || allocation.memo !== saved.memo || parseLedgerAmount(allocation.amount) !== saved.amount_cents || allocation.unassigned !== saved.unassigned
      })
    : splitTouched))
  return {
    beginManualTransaction, beginDuplicate, beginEditing, patchEditing, chooseCategory, choosePayee, chooseTransfer, dismissTransferShortcut,
    cancelEditing, requestExit, entryExit, startSplit, changeSplit, saveSplit, reloadSplit, unsplitDraft,
    editing, editingRef, splitDraft, splitDraftRef, splitHasChanges, splitSessionActive: splitDraft !== null,
    ordinaryEditorActive, ordinaryEditorDirty, ordinaryEditorHasWork, editTransactionId, finishEditing,
    createQuickPayee, recoverQuickCreate, clearQuickCreateError, quickCreatePending, quickCreateRecovery, quickCreateError,
    finishTransferDraft, finishTransferSaved, ledgerTransactions,
    quickCreateBlocked: quickCreatePending || quickCreateRecovery,
    bulkApply, update, moveMany, deleteMany, exclude, restore, manualClearance, review, toggleClearance,
    creatingTransaction, manualClearPending, manualClearRecovery, recoverManualClear,
    newEntryReveal, completeNewEntryReveal, navigationRevisionRef,
    followScheduledEntry: (row: LedgerRow) => refreshCreated(row, viewKey, -1),
    writePending: creatingTransaction || bulkApplyTransactions.isPending || manualClearPending || manualClearRecovery !== null,
  }
}
