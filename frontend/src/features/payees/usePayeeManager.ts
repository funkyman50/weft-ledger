import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import {
  invalidatePayeeQueries,
  useCategories,
  useCreatePayee,
  useDeletePayee,
  useDeleteUnusedPayees,
  useReplacePayee,
  usePayeeRules,
  usePayees,
  useUpdatePayee,
} from '../../api/hooks'
import type {
  Account,
  LedgerRow,
  Payee,
  PayeeReferences,
  PayeeScheduleAssignments,
  PayeeUnusedDeletionPreview,
  PayeeHistoryPage,
  PayeePreview,
  PayeeRuleTrace,
  PayeeRule,
  PayeeRuleDraft,
  PayeeRules,
} from '../../api/types'
import { canEditField } from '../ledger/rowPermissions'
import { usePayeeDefaultCategory } from './usePayeeDefaultCategory'
import { ruleReady } from './payeeRule'
import { matchesSearch, searchQuery } from '../../lib/search'

type Cursor = { date: string; id: number; order: number }
type HistoryScope = 'current' | 'all' | 'schedules' | 'matches'
export function ruleDraft(rule: PayeeRule): PayeeRuleDraft {
  return {
    id: rule.id,
    payee_id: rule.payee_id,
    category_id: rule.category_id,
    account_id: rule.account_id,
    amount: rule.amount ? { ...rule.amount } : null,
    text_conditions: rule.text_conditions.map((condition) => ({ ...condition })),
  }
}
function wire(rule: PayeeRuleDraft | null) {
  return JSON.stringify(rule)
}
function useDebounced<T>(value: T) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), 250)
    return () => clearTimeout(timer)
  }, [value])
  return settled
}
function toggle(current: Map<number, LedgerRow>, rows: LedgerRow[]) {
  const next = new Map(current)
  const all = rows.length > 0 && rows.every((row) => next.has(row.id))
  rows.forEach((row) => (all ? next.delete(row.id) : next.set(row.id, row)))
  return next
}

export function usePayeeManager(accounts: Account[], initialPayeeId: number | null = null, onPayeeReplaced?: (sourceId: number, destinationId: number) => void) {
  const client = useQueryClient()
  const payeesQuery = usePayees()
  const rulesQuery = usePayeeRules()
  const payees = (payeesQuery.data ?? []).filter((payee) => payee.kind === 'ordinary' || payee.kind === 'myself')
  const ordinaryPayees = payees.filter((payee) => payee.kind === 'ordinary')
  const { data: categories = [] } = useCategories()
  const rules = rulesQuery.data?.rules ?? []
  const token = rulesQuery.data?.rules_token ?? ''
  const createPayee = useCreatePayee()
  const renamePayee = useUpdatePayee()
  const deletePayee = useDeletePayee()
  const deleteUnusedPayees = useDeleteUnusedPayees()
  const replacePayee = useReplacePayee()
  const defaults = usePayeeDefaultCategory()
  const [mode, setMode] = useState<'payees' | 'rules'>('payees')
  const [selectedPayeeId, setSelectedPayeeId] = useState<number | null>(initialPayeeId)
  const selectedPayee = payees.find((payee) => payee.id === selectedPayeeId) ?? null
  const [payeeSearch, setPayeeSearch] = useState('')
  const [ruleSearch, setRuleSearch] = useState('')
  const [rulePayeeFilter, setRulePayeeFilter] = useState<number | null>(null)
  const [ruleCategoryFilter, setRuleCategoryFilter] = useState<number | null>(null)
  const [ruleAccountFilter, setRuleAccountFilter] = useState<number | null>(null)
  const filteredOrder = Boolean(
    ruleSearch.trim() ||
    rulePayeeFilter !== null ||
    ruleCategoryFilter !== null ||
    ruleAccountFilter !== null,
  )
  const [draft, setDraftState] = useState<PayeeRuleDraft | null>(null)
  const [historyScope, setHistoryScope] = useState<HistoryScope>('current')
  const lastTransactionScope = useRef<'current' | 'all'>('current')
  const draftRef = useRef(draft)
  const setDraft = (value: PayeeRuleDraft | null) => {
    draftRef.current = value
    setDraftState(value)
    if (value === null) setHistoryScope((scope) => scope === 'matches' ? lastTransactionScope.current : scope)
  }
  const [baseline, setBaseline] = useState<PayeeRuleDraft | null>(null)
  const [baselineToken, setBaselineToken] = useState('')
  const [editorKey, setEditorKey] = useState(0)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [nameMode, setNameMode] = useState<'create' | 'rename' | null>(null)
  const [nameConflict, setNameConflict] = useState<Payee | null>(null)
  const [defaultDraft, setDefaultDraft] = useState<number | null>(selectedPayee?.default_category_id ?? null)
  const [defaultBaseline, setDefaultBaseline] = useState<number | null>(selectedPayee?.default_category_id ?? null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [outcomeUnknown, setOutcomeUnknown] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicateRuleId, setDuplicateRuleId] = useState<number | null>(null)
  const [intent, setIntent] = useState<(() => void) | null>(null)
  const [referencesState, setReferencesState] = useState<{
    payeeId: number
    mode: 'delete' | 'replace'
    destinationId: number | null
    offset: number
  } | null>(null)
  const [referenceToken, setReferenceToken] = useState<string | null>(null)
  const replacementIntent = useRef<{ sourceId: number; destinationId: number } | null>(null)
  const [unusedDeletePreview, setUnusedDeletePreview] = useState<PayeeUnusedDeletionPreview | null>(null)
  const [ruleToDelete, setRuleToDelete] = useState<PayeeRule | null>(null)
  const [defaultPrompt, setDefaultPrompt] = useState<{
    payee: Payee
    categoryId: number | null
    expected: number | null
  } | null>(null)
  const defaultContinuation = useRef<(() => void) | null>(null)
  const [rulePrompt, setRulePrompt] = useState<{
    draft: PayeeRuleDraft
    rulesToken: string
    previewToken: string
    count: number
  } | null>(null)
  const [ruleSavingAction, setRuleSavingAction] = useState<'default' | 'history' | null>(null)
  const ruleContinuation = useRef<(() => void) | null>(null)
  const [historySearch, setHistorySearch] = useState('')
  const [historyAccountId, setHistoryAccountId] = useState<number | null>(null)
  const [scheduleOffset, setScheduleOffset] = useState(0)
  const [scheduleToken, setScheduleToken] = useState<string | null>(null)
  const [selectedScheduleIds, setSelectedScheduleIds] = useState<Set<number>>(new Set())
  const [scheduleDestinationId, setScheduleDestinationId] = useState<number | null>(null)
  const [hideAssigned, setHideAssigned] = useState(false)
  const [historyTrail, setHistoryTrail] = useState<Cursor[]>([])
  const [traceTransactionId, setTraceTransactionId] = useState<number | null>(null)
  const [previewTrail, setPreviewTrail] = useState<Cursor[]>([])
  const [selectedRows, setSelectedRows] = useState<Map<number, LedgerRow>>(new Map())
  const [previewSelection, setPreviewSelection] = useState<{ token: string; rows: Map<number, LedgerRow> }>({
    token: '',
    rows: new Map(),
  })
  const historyCursor = historyTrail.at(-1)
  const previewCursor = previewTrail.at(-1)
  const search = useDebounced(historySearch)
  const draftWire = wire(draft)
  const settledDraftWire = useDebounced(draftWire)
  const previewSettling = draftWire !== settledDraftWire
  const settledDraft = useMemo(
    () => JSON.parse(settledDraftWire) as PayeeRuleDraft | null,
    [settledDraftWire],
  )
  const ruleDirty = Boolean(
    draft &&
    (baseline
      ? wire(draft) !== wire(baseline)
      : draft.payee_id !== null ||
        draft.category_id !== null ||
        draft.account_id !== null ||
        draft.amount !== null ||
        draft.text_conditions.some((condition) => condition.value.trim())),
  )
  const nameDirty =
    nameDraft !== null && nameDraft.trim() !== (nameMode === 'rename' ? (selectedPayee?.name ?? '') : '')
  const defaultDirty = selectedPayee !== null && defaultDraft !== defaultBaseline
  const dirty = ruleDirty || nameDirty || defaultDirty
  const staleRule = ruleDirty && baselineToken !== token
  const busy =
    pending ||
    outcomeUnknown ||
    needsRefresh ||
    defaults.saving ||
    defaults.requiresRefresh ||
    defaults.outcomeUnknown
  const refreshPayees = () => void invalidatePayeeQueries(client)
  const applyRules = (value: PayeeRules) => {
    client.setQueryData(['payee-rules'], value)
    setPreviewSelection({ token: '', rows: new Map() })
    setPreviewTrail([])
    refreshPayees()
  }
  const runWrite = async (action: () => Promise<void>) => {
    if (pendingRef.current || busy) return false
    pendingRef.current = true
    setPending(true)
    setError(null)
    setDuplicateRuleId(null)
    try {
      await action()
      return true
    } catch (caught) {
      const uncertain = !(caught instanceof ApiError) || caught.status >= 500
      if (uncertain) setOutcomeUnknown(true)
      if (caught instanceof ApiError && caught.code === 'payee_name_conflict') {
        const conflict = (caught.detail as { payee: Payee }).payee
        setNameConflict(conflict)
      }
      if (caught instanceof ApiError && caught.code === 'payee_rule_duplicate')
        setDuplicateRuleId((caught.detail as { rule_id: number }).rule_id)
      if (
        caught instanceof ApiError &&
        (caught.code.includes('stale') || caught.code === 'bulk_selection_changed')
      )
        setNeedsRefresh(true)
      const rejected =
        caught instanceof ApiError && caught.code === 'bulk_selection_changed'
          ? (caught.detail as { rejected: { id: number }[] }).rejected
          : []
      const removed = rejected.length
        ? rejected.length
        : uncertain || (caught instanceof ApiError && caught.code === 'payee_preview_stale')
          ? selectedRows.size + previewRows.size
          : 0
      if (removed) {
        if (rejected.length)
          setSelectedRows((current) => {
            const next = new Map(current)
            rejected.forEach((row) => next.delete(row.id))
            return next
          })
        else {
          setSelectedRows(new Map())
          setPreviewSelection({ token: '', rows: new Map() })
        }
      }
      setError(
        (removed ? `${removed} selection${removed === 1 ? '' : 's'} removed. ` : '') +
          apiErrorMessage(
            caught,
            uncertain
              ? 'Save outcome is unknown. Refresh and inspect before another write.'
              : 'The change could not be saved.',
          ),
      )
      return false
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  useEffect(() => {
    if (payeesQuery.data && selectedPayeeId !== null && !selectedPayee) {
      setSelectedPayeeId(null)
      setDefaultDraft(null)
      setDefaultBaseline(null)
    }
  }, [payeesQuery.data, selectedPayee, selectedPayeeId])
  useEffect(() => {
    if (defaultPrompt || defaultDirty || !selectedPayee) return
    if (selectedPayee.default_category_id !== defaultBaseline) {
      setDefaultBaseline(selectedPayee.default_category_id)
      setDefaultDraft(selectedPayee.default_category_id)
    }
  }, [defaultBaseline, defaultDirty, defaultPrompt, selectedPayee])

  const browsing = mode === 'rules'
  const assignmentCounts = useQuery({
    queryKey: ['payee-transactions', 'assignment-counts'],
    enabled: !browsing,
    queryFn: ({ signal }) => apiClient.get<Record<number, number>>('/api/payees/assignment-counts', signal),
  })
  const references = useQuery({
    queryKey: ['payee-references', referencesState?.payeeId, referencesState?.destinationId, referencesState?.offset],
    enabled: referencesState !== null && payees.some((payee) => payee.id === referencesState.payeeId),
    queryFn: ({ signal }) => {
      const state = referencesState!
      const params = new URLSearchParams({ offset: String(state.offset) })
      if (state.destinationId !== null) params.set('destination_payee_id', String(state.destinationId))
      const action = state.destinationId === null ? 'references' : 'replacement-preview'
      return apiClient.get<PayeeReferences>(`/api/payees/${state.payeeId}/${action}?${params}`, signal)
    },
  })
  useEffect(() => {
    if (!references.data || references.isFetching || !referencesState) return
    if (referencesState.offset > 0 && referenceToken !== references.data.preview_token) {
      setReferencesState((state) => state ? { ...state, offset: 0 } : null)
      setError('References changed. Review the first page again before confirming.')
    } else setReferenceToken(references.data.preview_token)
  }, [references.data, references.isFetching, referencesState, referenceToken])
  const scheduleAssignments = useQuery({
    queryKey: ['payee-schedules', selectedPayeeId, scheduleOffset],
    enabled: !browsing && selectedPayee !== null && (selectedPayee.schedule_count > 0 || historyScope === 'schedules'),
    queryFn: ({ signal }) => apiClient.get<PayeeScheduleAssignments>(`/api/payees/${selectedPayeeId}/schedules?offset=${scheduleOffset}`, signal),
  })
  useEffect(() => {
    const data = scheduleAssignments.data
    if (!data || scheduleAssignments.isFetching || data.payee.id !== selectedPayeeId) return
    if (scheduleToken !== data.preview_token) setSelectedScheduleIds(new Set())
    if (scheduleOffset > 0 && scheduleToken !== data.preview_token) {
      setScheduleOffset(0)
      if (historyScope === 'schedules') setError('Schedules changed. Review the first page again.')
    } else setScheduleToken(data.preview_token)
  }, [scheduleAssignments.data, scheduleAssignments.isFetching, scheduleOffset, scheduleToken, selectedPayeeId, historyScope])
  const clearScheduleSelection = () => setSelectedScheduleIds(new Set())
  const scope = historyScope
  const schedulesSelected = !browsing && scope === 'schedules'
  useEffect(() => {
    if (historyScope === 'schedules' && (!selectedPayee || selectedPayee.schedule_count === 0) && !payeesQuery.isFetching && !payeesQuery.isError)
      setHistoryScope(lastTransactionScope.current)
  }, [historyScope, selectedPayee, payeesQuery.isFetching, payeesQuery.isError])
  const changeHistoryScope = (value: HistoryScope) => {
    if (value === 'current' || value === 'all') lastTransactionScope.current = value
    setHistoryScope(value)
    setHistoryTrail([])
  }
  const previewing = scope === 'matches' && draft !== null
  const historyPayeeId = browsing ? null : selectedPayeeId
  const historyFilter = browsing ? 'all' : scope
  const effectiveHideAssigned = !browsing && hideAssigned
  const history = useQuery({
    queryKey: [
      'payee-transactions',
      search,
      historyAccountId,
      historyPayeeId,
      historyFilter,
      effectiveHideAssigned,
      historyCursor,
    ],
    enabled: !previewing && !schedulesSelected && (browsing || scope !== 'current' || selectedPayee !== null),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (search) params.set('q', search)
      if (historyAccountId !== null) params.set('account_id', String(historyAccountId))
      if (historyFilter === 'current' && historyPayeeId !== null) params.set('payee_id', String(historyPayeeId))
      if (historyFilter === 'all' && effectiveHideAssigned && historyPayeeId !== null)
        params.set('exclude_payee_id', String(historyPayeeId))
      if (historyCursor) {
        params.set('before_date', historyCursor.date)
        params.set('before_id', String(historyCursor.id))
        params.set('before_order', String(historyCursor.order))
      }
      return apiClient.get<PayeeHistoryPage>(`/api/payees/transactions?${params}`, signal)
    },
  })
  const previewEnabled = previewing && ruleReady(settledDraft) && Boolean(token) && !previewSettling
  const trace = useQuery({
    queryKey: ['payee-rule-trace', traceTransactionId, token],
    enabled: browsing && traceTransactionId !== null,
    retry: false,
    queryFn: ({ signal }) =>
      apiClient.get<PayeeRuleTrace>(`/api/payees/rules/trace?transaction_id=${traceTransactionId}`, signal),
  })
  const preview = useQuery({
    queryKey: ['payee-previews', settledDraftWire, token, previewCursor],
    enabled: previewEnabled,
    retry: false,
    queryFn: ({ signal }) =>
      apiClient.postQuery<PayeePreview>(
        '/api/payees/rules/preview',
        {
          rule: settledDraft,
          expected_rules_token: token,
          ...(previewCursor ? { before_date: previewCursor.date, before_id: previewCursor.id, before_order: previewCursor.order } : {}),
        },
        signal,
      ),
  })
  const previewIdentity =
    previewEnabled && preview.data ? `${draftWire}:${token}:${preview.data.preview_token}` : ''
  const previewRows =
    previewSelection.token === previewIdentity ? previewSelection.rows : new Map<number, LedgerRow>()
  const changeDraft = (value: PayeeRuleDraft) => {
    setDraft(value)
    setPreviewTrail([])
    setPreviewSelection({ token: '', rows: new Map() })
    setDuplicateRuleId(null)
  }
  const [editorOpen, setEditorOpen] = useState(false)
  const loadRule = (rule: PayeeRule | null, value?: PayeeRuleDraft) => {
    const next = value ?? (rule ? ruleDraft(rule) : null)
    setDraft(next)
    if (next === null) setEditorOpen(false)
    setBaseline(rule ? ruleDraft(rule) : null)
    setBaselineToken(token)
    setEditorKey((key) => key + 1)
    setPreviewTrail([])
    setPreviewSelection({ token: '', rows: new Map() })
    setError(null)
    setDuplicateRuleId(null)
  }
  const discard = () => {
    if (nameMode === 'rename') setNameDraft(null)
    else {
      setNameDraft(null)
      setNameMode(null)
    }
    setDraft(baseline)
    setDefaultDraft(defaultBaseline)
    setEditorKey((key) => key + 1)
    setPreviewSelection({ token: '', rows: new Map() })
    setError(null)
  }
  const request = (action: () => void) => {
    if (busy || intent || referencesState || unusedDeletePreview || ruleToDelete || defaultPrompt || rulePrompt) return
    if (dirty) setIntent(() => action)
    else {
      discard()
      action()
    }
  }
  const selectPayeeNow = (id: number) => {
    const payee = payees.find((item) => item.id === id)
    if (!payee) return
    setSelectedPayeeId(id)
    setScheduleOffset(0)
    setScheduleToken(null)
    clearScheduleSelection()
    setScheduleDestinationId(null)
    setDefaultDraft(payee.default_category_id)
    setDefaultBaseline(payee.default_category_id)
    setNameDraft(null)
    setNameMode(null)
    setNameConflict(null)
    setSelectedRows(new Map())
    setHistoryTrail([])
    setHistorySearch('')
    setError(null)
  }
  const writeRule = (saving: PayeeRuleDraft, rulesToken: string, applyPreviewToken?: string) =>
    runWrite(async () => {
      const saved = await apiClient.post<PayeeRules>('/api/payees/rules', {
        rule: saving,
        expected_rules_token: rulesToken,
        ...(applyPreviewToken ? { apply_preview_token: applyPreviewToken } : {}),
      })
      applyRules(saved)
      const rule = saving.id === undefined ? saved.rules[0] : saved.rules.find((item) => item.id === saving.id)
      if (rule) {
        if (rule.payee_id !== selectedPayeeId) selectPayeeNow(rule.payee_id)
        setDraft(ruleDraft(rule))
        setBaseline(ruleDraft(rule))
        setBaselineToken(saved.rules_token)
        setEditorOpen(false)
        changeHistoryScope('matches')
      }
    })
  const saveRule = async (continuation?: () => void) => {
    if (!ruleReady(draft) || staleRule || !draft || !payees.some((payee) => payee.id === draft.payee_id)) return false
    if (pendingRef.current || busy) return false
    pendingRef.current = true
    setPending(true)
    setError(null)
    let applicable: PayeePreview | null = null
    try {
      applicable = await apiClient.postQuery<PayeePreview>('/api/payees/rules/preview', { rule: draft, expected_rules_token: baselineToken })
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.code === 'payee_rule_evaluation_failed')) {
        if (caught instanceof ApiError && caught.code.includes('stale')) setNeedsRefresh(true)
        setError(apiErrorMessage(caught, 'Matching transactions could not be loaded. Try saving again.'))
        return false
      }
    } finally {
      pendingRef.current = false
      setPending(false)
    }
    if (applicable && applicable.counts.applicable > 0) {
      ruleContinuation.current = continuation ?? null
      setRulePrompt({ draft, rulesToken: baselineToken, previewToken: applicable.preview_token, count: applicable.counts.applicable })
      return false
    }
    const saved = await writeRule(draft, baselineToken)
    if (saved) continuation?.()
    return saved
  }
  const completeRule = async (apply: boolean) => {
    if (!rulePrompt || busy) return
    setRuleSavingAction(apply ? 'history' : 'default')
    const saved = await writeRule(rulePrompt.draft, rulePrompt.rulesToken, apply ? rulePrompt.previewToken : undefined)
    setRuleSavingAction(null)
    if (!saved) return
    setRulePrompt(null)
    const action = ruleContinuation.current
    ruleContinuation.current = null
    action?.()
  }
  const saveName = async () => {
    if (!nameDirty || nameDraft === null || !nameDraft.trim()) return !nameDirty
    if (nameMode === 'rename' && selectedPayee?.kind !== 'ordinary') return false
    return runWrite(async () => {
      const saved =
        nameMode === 'create'
          ? await createPayee.mutateAsync({ name: nameDraft.trim() })
          : await renamePayee.mutateAsync({ id: selectedPayee!.id, name: nameDraft.trim() })
      client.setQueryData<Payee[]>(['payees'], (current) =>
        [...(current ?? []).filter((item) => item.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      )
      setSelectedPayeeId(saved.id)
      setScheduleOffset(0)
      setScheduleToken(null)
      clearScheduleSelection()
      setScheduleDestinationId(null)
      setNameDraft(null)
      setNameMode(null)
      setNameConflict(null)
      setDefaultBaseline(saved.default_category_id)
      setDefaultDraft(saved.default_category_id)
    })
  }
  const saveDefault = async (continuation?: () => void) => {
    if (selectedPayee?.kind !== 'ordinary' || !defaultDirty || busy) return false
    if (pendingRef.current) return false
    pendingRef.current = true
    setPending(true)
    try {
      const targets = await defaults.preview(selectedPayee, defaultDraft, defaultBaseline)
      if (targets === null) return false
      if (targets.length) {
        defaultContinuation.current = continuation ?? null
        setDefaultPrompt({ payee: selectedPayee, categoryId: defaultDraft, expected: defaultBaseline })
        return false
      }
      const saved = await defaults.save(selectedPayee, defaultDraft, [], defaultBaseline)
      if (!saved) return false
      setDefaultBaseline(saved.default_category_id)
      continuation?.()
      return true
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  const completeDefault = async (update: boolean) => {
    if (!defaultPrompt || defaults.saving || defaults.requiresRefresh || defaults.outcomeUnknown) return
    const targets = update ? defaults.targets : []
    if (targets === null || (update && !targets.length)) return
    const saved = await defaults.save(
      defaultPrompt.payee,
      defaultPrompt.categoryId,
      targets,
      defaultPrompt.expected,
    )
    if (!saved) return
    setDefaultBaseline(saved.default_category_id)
    setDefaultDraft(saved.default_category_id)
    setDefaultPrompt(null)
    const action = defaultContinuation.current
    defaultContinuation.current = null
    action?.()
  }
  const saveThenContinue = async () => {
    const action = intent
    if (nameDirty && !(await saveName())) return
    const finish = async () => {
      if (defaultDirty) {
        await saveDefault(() => {
          setIntent(null)
          action?.()
        })
        return
      }
      setIntent(null)
      action?.()
    }
    if (ruleDirty) await saveRule(() => void finish())
    else await finish()
  }
  const moveRule = async (rule: PayeeRule, direction: 'up' | 'down') => {
    if (filteredOrder || ruleDirty) return
    const focused =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset.ruleMove === `${rule.id}-${direction}`
    await runWrite(async () => {
      const saved = await apiClient.post<PayeeRules>(`/api/payees/rules/${rule.id}/move`, {
        direction,
        expected_rules_token: token,
      })
      applyRules(saved)
      setBaselineToken(saved.rules_token)
    })
    if (focused)
      requestAnimationFrame(() => {
        const button = document.querySelector<HTMLButtonElement>(`[data-rule-move="${rule.id}-${direction}"]`)
        const target = button?.disabled
          ? button.closest('.bp-rule-row')?.querySelector<HTMLButtonElement>('button:not(:disabled)')
          : button
        target?.focus({ preventScroll: true })
      })
  }
  const apply = async () => {
    const targets = [...(previewing ? previewRows : selectedRows).values()].map((row) => ({
      id: row.id,
      edit_token: row.edit_token,
    }))
    if (
      !targets.length ||
      (!previewing && (mode !== 'payees' || schedulesSelected)) ||
      (previewing && (previewSettling || preview.isFetching || !preview.data || !draft)) ||
      (!previewing && !selectedPayee)
    )
      return
    await runWrite(async () => {
      if (previewing) {
        const payload = { rule: draft, expected_rules_token: token, preview_token: preview.data!.preview_token, targets }
        await apiClient.post('/api/payees/rules/apply', payload)
      } else await apiClient.post(`/api/payees/${selectedPayee!.id}/assign`, { targets })
      setSelectedRows(new Map())
      setPreviewSelection({ token: '', rows: new Map() })
      refreshPayees()
    })
  }
  const assignSchedules = async () => {
    const scheduleIds = [...selectedScheduleIds]
    if (!scheduleIds.length || !schedulesSelected || !selectedPayee || scheduleDestinationId === null || scheduleDestinationId === selectedPayeeId || scheduleToken === null || scheduleAssignments.isFetching || scheduleAssignments.isError || scheduleAssignments.data?.preview_token !== scheduleToken) return
    await runWrite(async () => {
      try {
        await apiClient.post(`/api/payees/${selectedPayee!.id}/schedules/assign`, {
          destination_payee_id: scheduleDestinationId,
          preview_token: scheduleToken,
          schedule_ids: scheduleIds,
        })
      } finally {
        clearScheduleSelection()
      }
      setScheduleOffset(0)
      refreshPayees()
    })
  }
  const clearDeletedSelection = (identifiers: number[]) => {
    if (selectedPayeeId === null || !identifiers.includes(selectedPayeeId)) return
    setSelectedPayeeId(null)
    setSelectedRows(new Map())
    setHistoryTrail([])
    setDefaultDraft(null)
    setDefaultBaseline(null)
    loadRule(null)
  }
  const finishDeletion = (identifiers: number[]) => {
    setReferencesState(null)
    setUnusedDeletePreview(null)
    clearDeletedSelection(identifiers)
    if (client.getQueryCache().findAll({ type: 'active' }).some((query) =>
      ['payees', 'payee-rules', 'transactions', 'schedules', 'accounts', 'payee-transactions'].includes(String(query.queryKey[0])) && query.state.status === 'error',
    )) {
      setNeedsRefresh(true)
      setError('Payee change saved. Refresh to reload the saved state.')
    }
  }
  const inspect = async () => {
    setPending(true)
    if (!browsing) void assignmentCounts.refetch()
    try {
      const freshPayees = (await payeesQuery.refetch({ throwOnError: true })).data ?? []
      await Promise.all([
        rulesQuery.refetch({ throwOnError: true }),
        ...(!browsing && freshPayees.some((payee) => payee.id === selectedPayeeId) ? [scheduleAssignments.refetch({ throwOnError: true })] : []),
        ...(browsing || !previewing && !schedulesSelected ? [history.refetch({ throwOnError: true })] : []),
        ...(previewEnabled ? [preview.refetch({ throwOnError: true })] : []),
        ...(browsing && traceTransactionId !== null ? [trace.refetch({ throwOnError: true })] : []),
      ])
      const replacement = replacementIntent.current
      const savedPayees = client.getQueryData<Payee[]>(['payees'])
      if (defaults.requiresRefresh || defaults.outcomeUnknown) {
        const fresh = await defaults.inspect()
        if (!fresh) return
        defaults.clearRecovery()
        setDefaultPrompt(null)
        defaultContinuation.current = null
        const payee = fresh.find((item) => item.id === selectedPayeeId)
        if (payee) setDefaultBaseline(payee.default_category_id)
      }
      setSelectedRows(new Map())
      setPreviewSelection({ token: '', rows: new Map() })
      clearScheduleSelection()
      setOutcomeUnknown(false)
      setNeedsRefresh(false)
      if ((unusedDeletePreview || referencesState) && selectedPayeeId !== null && !client.getQueryData<Payee[]>(['payees'])?.some((payee) => payee.id === selectedPayeeId)) {
        clearDeletedSelection([selectedPayeeId])
      }
      setReferencesState(null)
      setUnusedDeletePreview(null)
      setRuleToDelete(null)
      setRulePrompt(null)
      ruleContinuation.current = null
      setIntent(null)
      if (replacement && savedPayees && !savedPayees.some((payee) => payee.id === replacement.sourceId)) {
        onPayeeReplaced?.(replacement.sourceId, replacement.destinationId)
        selectPayeeNow(replacement.destinationId)
      }
      replacementIntent.current = null
      setError('Refreshed saved state. Review your draft and selections before another save.')
    } catch {
      setError('Refresh failed. Writes remain disabled until it succeeds.')
    } finally {
      setPending(false)
    }
  }
  const payeeQuery = searchQuery(payeeSearch)
  const ruleQuery = searchQuery(ruleSearch)
  const filteredRules = rules.filter((rule) => {
    if (
      (rulePayeeFilter !== null && rule.payee_id !== rulePayeeFilter) ||
      (ruleCategoryFilter !== null && rule.category_id !== ruleCategoryFilter) ||
      (ruleAccountFilter !== null && rule.account_id !== ruleAccountFilter)
    )
      return false
    const payee = payees.find((item) => item.id === rule.payee_id)
    const parent = categories.find((item) => item.children.some((child) => child.id === rule.category_id))
    const child = parent?.children.find((item) => item.id === rule.category_id)
    return matchesSearch(`${accounts.find((account) => account.id === rule.account_id)?.name ?? ''} ${payee?.name ?? ''} ${parent?.name ?? ''} ${child?.name ?? ''} ${JSON.stringify(rule.text_conditions)} ${rule.amount ? JSON.stringify(rule.amount) : ''}`, ruleQuery)
  })
  return {
    mode,
    setMode: (value: typeof mode) => request(() => setMode(value)),
    payees,
    categories,
    rules,
    filteredRules,
    busy,
    pending,
    error: error ?? defaults.error,
    queryError: payeesQuery.error ?? rulesQuery.error,
    assignmentCounts,
    rulesEvaluationError: rulesQuery.data?.evaluation_error ?? null,
    outcomeUnknown: outcomeUnknown || defaults.outcomeUnknown,
    needsRefresh: needsRefresh || defaults.requiresRefresh,
    inspect,
    request,
    intent,
    cancelIntent: () => setIntent(null),
    saveThenContinue,
    discardThenContinue: () => {
      const action = intent
      discard()
      setIntent(null)
      action?.()
    },
    payeeSearch,
    setPayeeSearch,
    filteredPayees: payees.filter((payee) =>
      matchesSearch(payee.name, payeeQuery),
    ),
    selectedPayee,
    selectedPayeeId,
    selectPayee: (id: number) =>
      request(() => {
        selectPayeeNow(id)
        loadRule(null)
      }),
    nameDraft,
    nameMode,
    setNameDraft,
    saveName,
    nameConflict,
    chooseNameConflict: () => {
      if (nameConflict && payees.some((payee) => payee.id === nameConflict.id)) {
        setNameDraft(null)
        setNameMode(null)
        selectPayeeNow(nameConflict.id)
      }
    },
    beginName: (value: 'create' | 'rename') =>
      request(() => {
        if (value === 'rename' && selectedPayee?.kind !== 'ordinary') return
        setNameMode(value)
        setNameDraft(value === 'rename' ? (selectedPayee?.name ?? '') : '')
        setNameConflict(null)
      }),
    cancelName: () => {
      setNameDraft(null)
      setNameMode(null)
      setNameConflict(null)
    },
    defaultDraft,
    setDefaultDraft,
    defaultDirty,
    defaultPrompt,
    saveDefault,
    completeDefault,
    defaultTargets: defaults.targets,
    defaultSavingAction: defaults.savingAction,
    rulePrompt,
    ruleSavingAction,
    completeRule,
    cancelRulePrompt: () => {
      if (!busy) {
        setRulePrompt(null)
        setIntent(null)
        ruleContinuation.current = null
      }
    },
    cancelDefault: () => {
      if (!busy) {
        setDefaultPrompt(null)
        setIntent(null)
        defaultContinuation.current = null
        defaults.reset()
      }
    },
    referencesState,
    references,
    closeReferences: () => setReferencesState(null),
    setReferenceMode: (mode: 'delete' | 'replace') => {
      setReferenceToken(null)
      setReferencesState((state) => state ? { ...state, mode, destinationId: null, offset: 0 } : null)
    },
    setReplacementDestination: (destinationId: number | null) => {
      setReferenceToken(null)
      setReferencesState((state) => state ? { ...state, destinationId, offset: 0 } : null)
    },
    setReferencesOffset: (offset: number) => setReferencesState((state) => state ? { ...state, offset } : null),
    requestPayeePreview: (id: number | null, mode: 'delete' | 'replace') =>
      request(() => {
        if (id === null || pendingRef.current || !payees.some((payee) => payee.id === id)) return
        if (id !== selectedPayeeId) {
          selectPayeeNow(id)
          loadRule(null)
        }
        setReferenceToken(null)
        setError(null)
        setReferencesState({ payeeId: id, mode, destinationId: null, offset: 0 })
      }),
    confirmDelete: () => {
      if (referencesState && references.data && !references.isFetching)
        void runWrite(async () => {
          await deletePayee.mutateAsync({
            id: referencesState.payeeId,
            preview_token: references.data.preview_token,
          })
          finishDeletion([referencesState.payeeId])
        })
    },
    confirmReplacement: () => {
      const state = referencesState
      const preview = references.data
      if (!state?.destinationId || !preview?.destination || references.isFetching || preview.destination.id !== state.destinationId) return
      const destinationId = state.destinationId
      void runWrite(async () => {
        replacementIntent.current = { sourceId: state.payeeId, destinationId }
        try {
          await replacePayee.mutateAsync({ id: state.payeeId, destination_payee_id: destinationId, preview_token: preview.preview_token })
        } catch (caught) {
          if (caught instanceof ApiError && caught.status < 500 && !['history_request_stale', 'ledger_response_superseded'].includes(caught.code)) replacementIntent.current = null
          throw caught
        }
        onPayeeReplaced?.(state.payeeId, destinationId)
        replacementIntent.current = null
        finishDeletion([state.payeeId])
        selectPayeeNow(destinationId)
      })
    },
    unusedPayeeCount: assignmentCounts.isFetching || assignmentCounts.isError || !assignmentCounts.data ? undefined
      : ordinaryPayees.filter((payee) => (assignmentCounts.data![payee.id] ?? 0) === 0 && payee.schedule_count === 0).length,
    unusedDeletePreview,
    cancelUnusedDelete: () => setUnusedDeletePreview(null),
    requestUnusedDelete: () => request(() => {
      if (pendingRef.current) return
      pendingRef.current = true
      setPending(true)
      setError(null)
      void apiClient.get<PayeeUnusedDeletionPreview>('/api/payees/unused/deletion-preview')
        .then(setUnusedDeletePreview)
        .catch((caught) => setError(apiErrorMessage(caught, 'Unused payees could not be loaded.')))
        .finally(() => { pendingRef.current = false; setPending(false) })
    }),
    confirmUnusedDelete: () => {
      if (unusedDeletePreview?.payees.length)
        void runWrite(async () => {
          const identifiers = unusedDeletePreview.payees.map((payee) => payee.id)
          await deleteUnusedPayees.mutateAsync({ preview_token: unusedDeletePreview.preview_token, payee_ids: identifiers })
          finishDeletion(identifiers)
        })
    },
    ruleSearch,
    setRuleSearch,
    rulePayeeFilter,
    setRulePayeeFilter,
    ruleCategoryFilter,
    setRuleCategoryFilter,
    ruleAccountFilter,
    setRuleAccountFilter,
    filteredOrder,
    clearRuleFilters: () => {
      setRuleSearch('')
      setRulePayeeFilter(null)
      setRuleCategoryFilter(null)
      setRuleAccountFilter(null)
    },
    draft,
    changeDraft,
    editorKey,
    ruleDirty,
    staleRule,
    duplicateRuleId,
    saveRule,
    editorOpen,
    selectRule: (rule: PayeeRule) =>
      request(() => {
        if (!payees.some((payee) => payee.id === rule.payee_id)) return
        loadRule(rule)
        setEditorOpen(true)
        changeHistoryScope('matches')
        setHistoryTrail([])
      }),
    viewRule: (rule: PayeeRule) =>
      request(() => {
        if (!payees.some((payee) => payee.id === rule.payee_id)) return
        if (draftRef.current?.id === rule.id && !editorOpen) {
          loadRule(null)
          return
        }
        loadRule(rule)
        setEditorOpen(false)
        changeHistoryScope('matches')
        setHistoryTrail([])
      }),
    editRule: (rule: PayeeRule) =>
      request(() => {
        if (!payees.some((payee) => payee.id === rule.payee_id)) return
        setMode('payees')
        selectPayeeNow(rule.payee_id)
        loadRule(rule)
        setEditorOpen(true)
        changeHistoryScope('matches')
      }),
    newGlobalRule: () => request(() => {
      setMode('rules')
      loadRule(null, { payee_id: null, category_id: null, account_id: null, amount: null, text_conditions: [{ field: 'description', operator: 'contains', value: '' }] })
      setEditorOpen(true)
      changeHistoryScope('matches')
    }),
    newRule: () =>
      request(() => {
        if (!selectedPayee) return
        if (historyScope === 'schedules') changeHistoryScope(lastTransactionScope.current)
        loadRule(null, {
          payee_id: selectedPayee.id,
          category_id: null,
          account_id: null,
          amount: null,
          text_conditions: [{ field: 'description', operator: 'contains', value: '' }],
        })
        setEditorOpen(true)
      }),
    duplicateRule: () =>
      request(() => {
        if (!draftRef.current) return
        const value = { ...draftRef.current }
        delete value.id
        loadRule(null, value)
        setEditorOpen(true)
        changeHistoryScope('matches')
      }),
    cancelRule: () => {
      if (busy) return
      const saved = rules.find((rule) => rule.id === draft?.id) ?? null
      loadRule(saved)
      setEditorOpen(false)
    },
    traceTransactionId,
    setTraceTransactionId,
    trace,
    requestRuleDelete: () => {
      const rule = rules.find((item) => item.id === draft?.id)
      if (rule) request(() => setRuleToDelete(rule))
    },
    ruleToDelete,
    cancelRuleDelete: () => setRuleToDelete(null),
    confirmRuleDelete: () => {
      if (ruleToDelete)
        void runWrite(async () => {
          const saved = await apiClient.delete<PayeeRules>(`/api/payees/rules/${ruleToDelete.id}`, {
            expected_rules_token: token,
          })
          applyRules(saved)
          setRuleToDelete(null)
          loadRule(null)
        })
    },
    keepDraft: () => {
      const saved = rules.find((rule) => rule.id === draft?.id)
      setBaselineToken(token)
      setBaseline(saved ? ruleDraft(saved) : null)
      if (draft && !saved) {
        const next = { ...draft }
        delete next.id
        changeDraft(next)
      }
      setError(null)
    },
    useSavedRule: () => loadRule(rules.find((rule) => rule.id === draft?.id) ?? null),
    moveRule,
    history,
    historySearch,
    setHistorySearch: (value: string) => {
      setHistorySearch(value)
      setHistoryTrail([])
    },
    historyAccountId,
    setHistoryAccountId: (id: number | null) => {
      setHistoryAccountId(id)
      setHistoryTrail([])
    },
    historyScope: scope,
    previewing,
    schedulesSelected,
    scheduleAssignments,
    setScheduleOffset,
    selectedScheduleIds,
    toggleSchedules: (keys: number[]) => {
      if (scheduleToken === null || scheduleAssignments.isFetching || scheduleAssignments.isError || scheduleAssignments.data?.preview_token !== scheduleToken) return
      const next = new Set(selectedScheduleIds)
      const adding = keys.some((key) => !next.has(key))
      keys.forEach((key) => (adding ? next.add(key) : next.delete(key)))
      setSelectedScheduleIds(next)
    },
    scheduleDestinationId,
    setScheduleDestinationId,
    assignSchedules,
    setHistoryScope: changeHistoryScope,
    hideAssigned,
    setHideAssigned: (value: boolean) => {
      setHideAssigned(value)
      setHistoryTrail([])
    },
    selectedRows,
    toggleFind: (rows: LedgerRow[]) =>
      setSelectedRows((current) =>
        toggle(
          current,
          rows.filter((row) => canEditField(row, 'payee_id')),
        ),
      ),
    historyBack: () => setHistoryTrail((value) => value.slice(0, -1)),
    historyNext: (cursor: Cursor) => setHistoryTrail((value) => [...value, cursor]),
    historyCursor,
    preview,
    previewEnabled,
    previewSettling,
    previewRows,
    togglePreview: (rows: LedgerRow[], header = false) =>
      setPreviewSelection({
        token: previewIdentity,
        rows: toggle(
          previewRows,
          rows.filter(
            (row) =>
              preview.data?.decisions[String(row.id)]?.eligible &&
              (!header || preview.data.decisions[String(row.id)].earlier_rule_id === null),
          ),
        ),
      }),
    previewBack: () => setPreviewTrail((value) => value.slice(0, -1)),
    previewNext: (cursor: Cursor) => setPreviewTrail((value) => [...value, cursor]),
    previewCursor,
    apply,
  }
}
