import type { AccountScope } from '../../lib/accountScope'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ScheduleGuard } from './ScheduledPane'
import type { useLedgerEditor, EditorTransferIntent } from './useLedgerEditor'
import type { useLedgerCommands } from './useLedgerCommands'
import type { useMatchWorkflow } from './useMatchWorkflow'
import type { usePendingLifecycleWorkflow } from './usePendingLifecycleWorkflow'
import type { useTransferWorkflow } from './useTransferWorkflow'
import { useLedgerHistory, type LedgerHistoryGuard } from './useLedgerHistory'

type WorkspaceDialogs = {
  loanDialogOpen: boolean
  accountDialog: boolean
  conversion: { open: boolean; outcomeUnknown: boolean } | null
  categoryDialogOpen: boolean
  payeeDialogOpen: boolean
  payeeRecoveryActive: boolean
  exportDialogOpen: boolean
  newTransactionChooserOpen: boolean
  systemSettingsOpen: boolean
  startingBalanceAccountId: number | null
  defaultSuggestionDialog: boolean
  reveal: boolean
}

type WorkspaceEditor = Pick<ReturnType<typeof useLedgerEditor>,
  | 'splitHasChanges' | 'splitSessionActive' | 'cancelEditing' | 'editingRef'
  | 'quickCreateBlocked' | 'requestExit' | 'writePending' | 'manualClearRecovery'
  | 'ordinaryEditorDirty' | 'creatingTransaction'
>

export function useLedgerWorkspace({
  selectedAccountId, accountName, accounts, viewKey, query, editor, commands,
  matchWorkflow, pendingWorkflow, transferWorkflow, dialogs, bulkStaged,
  initializationPending, scheduleLoading, onTransferIntent, onNotice: showNotice,
}: {
  selectedAccountId: AccountScope | null
  accountName: string | null
  accounts: Array<{ id: number; name: string }>
  viewKey: string
  query: { isFetching: boolean; isSuccess: boolean }
  editor: WorkspaceEditor
  commands: Pick<ReturnType<typeof useLedgerCommands>, 'anyPending' | 'recovery' | 'awaitReconciliation'>
  matchWorkflow: Pick<ReturnType<typeof useMatchWorkflow>, 'dialog'>
  pendingWorkflow: Pick<ReturnType<typeof usePendingLifecycleWorkflow>, 'active'>
  transferWorkflow: Pick<ReturnType<typeof useTransferWorkflow>, 'dialog' | 'queueActive'>
  dialogs: WorkspaceDialogs
  bulkStaged: boolean
  initializationPending: boolean
  scheduleLoading: boolean
  onTransferIntent: (intent: EditorTransferIntent) => void
  onNotice: (message: string) => void
}) {
  const {
    loanDialogOpen, accountDialog, conversion, categoryDialogOpen, payeeDialogOpen, payeeRecoveryActive,
    exportDialogOpen, newTransactionChooserOpen, systemSettingsOpen,
    startingBalanceAccountId, defaultSuggestionDialog, reveal,
  } = dialogs
  const [scheduleGuard, setScheduleGuard] = useState<ScheduleGuard>({ blocked: false, recoveryOwned: false })
  const [tableHistoryGuard, setTableHistoryGuard] = useState<LedgerHistoryGuard>({ blocked: false, recoveryOwned: false })
  const [leaveSplitAction, setLeaveSplitAction] = useState<(() => void) | null>(null)
  const scheduleGuardRef = useRef(scheduleGuard)
  scheduleGuardRef.current = scheduleGuard
  const entryRecoveryBlocked = useRef(false)
  const remainingWorkRef = useRef(false)
  const workspaceLeavingRef = useRef<{ action: () => void } | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; workspaceLeavingRef.current = null } }, [])
  const transferIntentRef = useRef(onTransferIntent)
  transferIntentRef.current = onTransferIntent
  const scheduleViewRef = useRef(selectedAccountId)
  useLayoutEffect(() => { scheduleViewRef.current = selectedAccountId }, [selectedAccountId])
  const currentViewRef = useRef(viewKey)
  currentViewRef.current = viewKey

  const historyBlocked = Boolean(
    initializationPending
    || scheduleGuard.blocked
    || scheduleLoading
    || tableHistoryGuard.blocked
    || editor.writePending
    || commands.anyPending
    || commands.recovery !== null
    || matchWorkflow.dialog
    || pendingWorkflow.active
    || transferWorkflow.dialog
    || transferWorkflow.queueActive
    || accountDialog
    || conversion?.open
    || conversion?.outcomeUnknown
    || categoryDialogOpen
    || payeeDialogOpen
    || exportDialogOpen
    || newTransactionChooserOpen
    || systemSettingsOpen
    || loanDialogOpen || startingBalanceAccountId !== null
    || leaveSplitAction
    || reveal
    || defaultSuggestionDialog,
  )
  const workflowOwnsRecovery = (
    scheduleGuard.recoveryOwned
    || tableHistoryGuard.recoveryOwned
    || Boolean(editor.manualClearRecovery
    || transferWorkflow.dialog?.outcomeUnknown
    || payeeRecoveryActive
    || loanDialogOpen || startingBalanceAccountId !== null
    || conversion?.outcomeUnknown)
  )
  const history = useLedgerHistory({
    accountName,
    accounts,
    blocked: historyBlocked,
    recoveryOwned: workflowOwnsRecovery,
    onNotice: showNotice,
  })
  entryRecoveryBlocked.current = Boolean(commands.recovery || history.recovery || history.recoveryRequired || history.reloadRequired || editor.manualClearRecovery)
  remainingWorkRef.current = Boolean(editor.editingRef.current || editor.writePending || commands.anyPending || commands.recovery || bulkStaged || matchWorkflow.dialog || pendingWorkflow.active || transferWorkflow.dialog || transferWorkflow.queueActive || loanDialogOpen || startingBalanceAccountId !== null)
  const { splitHasChanges, splitSessionActive, cancelEditing: cancelEditorSession, editingRef, quickCreateBlocked, requestExit: requestManualExit } = editor
  const continuationDialogRef = useRef(false)
  continuationDialogRef.current = Boolean(accountDialog || conversion?.open || categoryDialogOpen || payeeDialogOpen || exportDialogOpen || newTransactionChooserOpen || systemSettingsOpen || loanDialogOpen || startingBalanceAccountId !== null || defaultSuggestionDialog || matchWorkflow.dialog || pendingWorkflow.active || transferWorkflow.dialog || transferWorkflow.queueActive)
  const requestAction = useCallback((action: () => void) => {
    if (loanDialogOpen) { showNotice('Finish or cancel loan review first.'); return }
    if (workspaceLeavingRef.current) { workspaceLeavingRef.current.action = action; return }
    if (scheduleLoading) { showNotice('Wait for the current update to finish.'); return }
    if (quickCreateBlocked) { showNotice('Wait for payee creation to finish.'); return }
    if (splitHasChanges) { setLeaveSplitAction(() => action); return }
    if (splitSessionActive) {
      if (!cancelEditorSession()) { showNotice('Wait for the current update to finish.'); return }
      action()
      return
    }
    const schedule = scheduleGuardRef.current
    const manual = editingRef.current
    if (!schedule.blocked && !manual) { action(); return }
    if (!schedule.blocked && manual && !manual.isNew && !editor.ordinaryEditorDirty) {
      if (!cancelEditorSession()) { showNotice('Wait for the current update to finish.'); return }
      action()
      return
    }
    if (entryRecoveryBlocked.current) { showNotice('Inspect the current update before leaving this entry.'); return }
    const originView = viewKey
    const request = { action }
    workspaceLeavingRef.current = request
    void (async () => {
      try {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (!mountedRef.current || workspaceLeavingRef.current !== request) return
        if (schedule.blocked && (!schedule.requestLeave || await schedule.requestLeave() !== 'finished')) {
          const current = scheduleGuardRef.current
          if (mountedRef.current && current.blocked && !current.existingEntry && !current.newEntry && !current.dismissible) showNotice(current.blockedReason ?? 'Save, cancel, or inspect the schedule first.')
          return
        }
        if (editingRef.current && await requestManualExit('leave', (intent) => transferIntentRef.current(intent)) !== 'finished') return
        if (!await commands.awaitReconciliation()) { if (mountedRef.current) showNotice('Wait for the current update to finish, or inspect the register before continuing.'); return }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (!mountedRef.current || workspaceLeavingRef.current !== request || scheduleViewRef.current !== selectedAccountId || currentViewRef.current !== originView || entryRecoveryBlocked.current || editingRef.current || scheduleGuardRef.current.blocked || continuationDialogRef.current) return
        workspaceLeavingRef.current = null
        request.action()
      } finally { if (workspaceLeavingRef.current === request) workspaceLeavingRef.current = null }
    })()
  }, [loanDialogOpen, cancelEditorSession, commands, editingRef, editor.ordinaryEditorDirty, quickCreateBlocked, requestManualExit, viewKey, scheduleLoading, selectedAccountId, showNotice, splitHasChanges, splitSessionActive])

  const discardSplitAndContinue = useCallback(() => {
    const action = leaveSplitAction
    if (!cancelEditorSession()) { showNotice('Wait for the current update to finish.'); return }
    setLeaveSplitAction(null)
    action?.()
  }, [cancelEditorSession, leaveSplitAction, showNotice])

  const suggestionSettling = commands.anyPending || editor.writePending || query.isFetching
  const suggestionBlocked = Boolean(
    scheduleGuard.blocked
    || commands.anyPending
    || commands.recovery !== null
    || editor.writePending
    || editor.manualClearRecovery
    || query.isFetching
    || !query.isSuccess
    || editor.ordinaryEditorDirty
    || editor.splitHasChanges
    || editor.splitSessionActive
    || editor.quickCreateBlocked
    || tableHistoryGuard.recoveryOwned
    || bulkStaged
    || history.busy
    || history.fetching
    || history.recovery
    || matchWorkflow.dialog
    || pendingWorkflow.active
    || transferWorkflow.dialog
    || transferWorkflow.queueActive
    || payeeDialogOpen
    || categoryDialogOpen
    || accountDialog
    || exportDialogOpen
    || newTransactionChooserOpen
    || systemSettingsOpen
    || loanDialogOpen || startingBalanceAccountId !== null
    || leaveSplitAction
    || reveal,
  )
  const suggestionInterrupted = commands.anyPending || editor.writePending || history.busy
  const defaultSuggestionAdmission = useCallback((phase: 'settling' | 'ready') => {
    if (phase === 'settling') return suggestionSettling ? 'wait' : 'advance'
    if (suggestionBlocked) return suggestionInterrupted ? 'discard' : 'wait'
    return 'fetch'
  }, [suggestionBlocked, suggestionInterrupted, suggestionSettling])
  const scheduleEntryAllowed = (
    !scheduleLoading
    && !initializationPending
    && !editor.quickCreateBlocked
    && !editor.writePending
    && !commands.anyPending
    && !bulkStaged
    && !history.busy
    && !entryRecoveryBlocked.current
    && history.ready
    && !matchWorkflow.dialog
    && !pendingWorkflow.active
    && !transferWorkflow.dialog
    && !transferWorkflow.queueActive
  )
  const scheduleBlocked = Boolean(
    scheduleLoading
    || initializationPending
    || tableHistoryGuard.blocked && !tableHistoryGuard.ordinaryEditorOnly
    || editor.ordinaryEditorDirty && editor.editingRef.current?.isNew
    || editor.splitSessionActive
    || editor.quickCreateBlocked
    || editor.writePending
    || commands.anyPending
    || commands.recovery
    || history.busy
    || history.recovery
    || history.reloadRequired
    || !history.ready
    || matchWorkflow.dialog
    || pendingWorkflow.active
    || transferWorkflow.dialog
    || transferWorkflow.queueActive
    || accountDialog
    || categoryDialogOpen
    || payeeDialogOpen
    || systemSettingsOpen
    || exportDialogOpen
    || newTransactionChooserOpen
    || loanDialogOpen || startingBalanceAccountId !== null
    || conversion?.open,
  )
  const newEntryDisabled = editor.creatingTransaction || bulkStaged || transferWorkflow.queueActive || history.busy || history.recovery !== null
  const systemSettingsBlocked = Boolean(history.busy || history.fetching || history.recovery || tableHistoryGuard.recoveryOwned)
  const rowCommandsBlocked = Boolean(scheduleGuard.blocked && !scheduleGuard.existingEntry || initializationPending || matchWorkflow.dialog || pendingWorkflow.active || transferWorkflow.dialog || loanDialogOpen || startingBalanceAccountId !== null)
  const hasRemainingWork = useCallback(() => remainingWorkRef.current || scheduleGuardRef.current.blocked || workspaceLeavingRef.current !== null, [])
  const isCurrentAccount = useCallback((accountId: AccountScope | null) => scheduleViewRef.current === accountId, [])
  const keepEditing = useCallback(() => setLeaveSplitAction(null), [])
  const dispatchTransferIntent = useCallback((intent: EditorTransferIntent) => transferIntentRef.current(intent), [])

  return {
    history,
    workflowOwnsRecovery,
    dispatchTransferIntent,
    requestAction,
    splitLeavePending: leaveSplitAction !== null,
    keepEditing,
    discardSplitAndContinue,
    entryRecoveryBlocked: entryRecoveryBlocked.current,
    hasRemainingWork,
    isCurrentAccount,
    reportScheduleGuard: setScheduleGuard,
    reportTableGuard: setTableHistoryGuard,
    registerBlockedBySchedule: scheduleGuard.blocked && !scheduleGuard.newEntry && !scheduleGuard.existingEntry && !scheduleGuard.dismissible || scheduleLoading,
    rowCommandsBlocked,
    defaultSuggestionAdmission,
    newEntryDisabled,
    scheduleEntryAllowed,
    scheduleBlocked,
    systemSettingsBlocked,
  }
}
