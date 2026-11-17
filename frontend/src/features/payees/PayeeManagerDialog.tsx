import { useEffect, useRef } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, Copy, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react'
import type { Account, CategoryTree, LedgerRow, PayeePreview, PayeeRuleTrace } from '../../api/types'
import { Button } from '../../components/Button'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import { DialogHeader } from '../../components/DialogHeader'
import { money } from '../../lib/money'
import { isComposingKey } from '../../lib/keyboard'
import { canEditField } from '../ledger/rowPermissions'
import { PayeeRuleEditor } from './PayeeRuleEditor'
import { categoryResult, ruleReady } from './payeeRule'
import { PayeeRuleRow } from './PayeeRuleRow'
import { usePayeeManager } from './usePayeeManager'
import { PayeeGuard, PayeeSavePrompt } from './PayeeSavePrompt'
import { PayeeReferencesDialog } from './PayeeReferencesDialog'
import { PayeeDeletionEffects, PayeeReferencePagination } from './PayeeReferenceList'
import { scheduleFrequencyLabel } from '../ledger/scheduleFrequency'

export function PayeeManagerDialog({
  accounts,
  initialPayeeId,
  onClose,
  onInspectHistory,
  onRecoveryChange,
  onPayeeReplaced,
}: {
  accounts: Account[]
  initialPayeeId?: number | null
  onClose: () => void
  onInspectHistory: () => Promise<unknown>
  onRecoveryChange: (active: boolean) => void
  onPayeeReplaced: (sourceId: number, destinationId: number) => void
}) {
  const m = usePayeeManager(accounts, initialPayeeId, onPayeeReplaced)
  const searchRef = useRef<HTMLInputElement>(null)
  const previousHistoryScope = useRef(m.historyScope)
  useEffect(() => {
    const leftSchedules = previousHistoryScope.current === 'schedules' && m.historyScope !== 'schedules'
    previousHistoryScope.current = m.historyScope
    if (leftSchedules && document.activeElement === document.body)
      document.getElementById(`payee-history-tab-${m.historyScope}`)?.focus({ preventScroll: true })
  }, [m.historyScope])
  const nameRef = useRef<HTMLInputElement>(null)
  const guardCancelRef = useRef<HTMLButtonElement>(null)
  const namingCancelled = useRef(false)
  const naming = m.nameDraft !== null
  const rulesMode = m.mode === 'rules'
  const assignmentCounts = rulesMode || m.assignmentCounts.isFetching || m.assignmentCounts.isError ? undefined : m.assignmentCounts.data
  const assignedCount = !m.selectedPayee ? undefined : m.historyScope === 'current'
    ? m.history.data?.total_count
    : m.historyAccountId !== null || m.historySearch.trim() ? undefined
    : assignmentCounts ? assignmentCounts[m.selectedPayee.id] ?? 0 : undefined
  const unusedPayeeCount = m.unusedDeletePreview?.payees.length ?? 0
  const guarded = Boolean(m.intent || m.referencesState || m.unusedDeletePreview || m.ruleToDelete || m.defaultPrompt || m.rulePrompt)
  const close = () => {
    if (!m.busy) m.request(onClose)
  }
  useEffect(() => {
    onRecoveryChange(m.outcomeUnknown)
    return () => onRecoveryChange(false)
  }, [m.outcomeUnknown, onRecoveryChange])
  useEffect(() => {
    if (naming) {
      namingCancelled.current = false
      nameRef.current?.focus()
    }
  }, [m.nameMode, naming])
  const refresh = async () => {
    try {
      await onInspectHistory()
      await m.inspect()
    } catch {
      return
    }
  }
  const previewing = m.previewing
  const needsPayee = !rulesMode && m.historyScope === 'current' && !m.selectedPayee
  const page = needsPayee ? undefined : previewing ? m.preview.data : m.history.data
  const rows = previewing && !m.previewEnabled ? [] : (page?.rows ?? [])
  const selected = previewing ? m.previewRows : m.selectedRows
  const decisions = m.preview.data?.decisions ?? {}
  const hiddenSelected = [...selected.keys()].filter((id) => !rows.some((row) => row.id === id)).length
  const historyBusy =
    m.busy || (previewing && (m.previewSettling || m.preview.isFetching || !m.previewEnabled))
  const eligible = rows.filter((row) =>
    previewing
      ? decisions[String(row.id)]?.eligible && decisions[String(row.id)].earlier_rule_id === null
      : canEditField(row, 'payee_id'),
  )
  const ownedRules = m.rules.filter((rule) => rule.payee_id === m.selectedPayeeId)
  const selectedRule = m.draft?.id === undefined ? null : (m.rules.find((rule) => rule.id === m.draft?.id) ?? null)
  const matchCount = m.previewEnabled && m.preview.data ? m.preview.data.counts.matching : null
  const trace = rulesMode && m.traceTransactionId !== null ? m.trace.data : undefined
  const categoryOptions = m.categories.flatMap((parent) =>
    parent.children.map((child) => ({ value: String(child.id), label: `${parent.name}: ${child.name}` })),
  )
  const historyControls = (
    <div className="bp-payee-history-controls">
      <FilterSelect
        ariaLabel="Find account"
        autoFocus={false}
        value={m.historyAccountId === null ? '' : String(m.historyAccountId)}
        options={[
          { value: '', label: 'All accounts' },
          ...accounts.map((account) => ({ value: String(account.id), label: account.name })),
        ]}
        onChange={(value) => m.setHistoryAccountId(value ? Number(value) : null)}
      />
      <label className="bp-search">
        <Search aria-hidden="true" />
        <input
          aria-label="Find transactions"
          placeholder="Find transactions"
          value={m.historySearch}
          onChange={(event) => m.setHistorySearch(event.target.value)}
        />
      </label>
      {!rulesMode && m.historyScope === 'all' && (
        <label className="bp-check">
          <input
            type="checkbox"
            disabled={!m.selectedPayee}
            checked={m.hideAssigned}
            onChange={(event) => m.setHideAssigned(event.target.checked)}
          />
          Hide assigned
        </label>
      )}
    </div>
  )
  const pagination = (
    <div className="bp-payee-pagination">
      <Button
        size="md"
        disabled={historyBusy || !(previewing ? m.previewCursor : m.historyCursor)}
        onClick={previewing ? m.previewBack : m.historyBack}
      >
        <ChevronLeft aria-hidden="true" />
        Prev
      </Button>
      <Button
        size="md"
        disabled={historyBusy || !page?.has_more}
        onClick={() => {
          if (page?.next_before_date && page.next_before_id && page.next_before_order !== null)
            (previewing ? m.previewNext : m.historyNext)({ date: page.next_before_date, id: page.next_before_id, order: page.next_before_order })
        }}
      >
        Next
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  )
  return (
    <Modal
      size="workbench"
      className="bp-payee-dialog"
      labelledBy="payee-manager-title"
      initialFocusRef={searchRef}
      inactive={guarded}
      onRequestClose={(reason) => {
        if (reason === 'escape' && !rulesMode && m.draft && m.editorOpen && !guarded && !m.busy) m.cancelRule()
        else close()
      }}
    >
      <DialogHeader titleId="payee-manager-title" title="Payee management" subtitle={`${m.payees.length} payees · ${m.rules.length} rules`} closeDisabled={m.busy} onClose={close} />
      <div className="bp-tabs bp-payee-tabs" role="tablist" aria-label="Payee management view">
        {(['payees', 'rules'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            id={`payee-tab-${mode}`}
            aria-controls={m.mode === mode ? `payee-panel-${mode}` : undefined}
            aria-selected={m.mode === mode}
            className={m.mode === mode ? 'is-active' : ''}
            disabled={m.busy}
            onClick={() => m.setMode(mode)}
          >
            {mode === 'payees' ? 'Payees' : 'All Rules'}
          </button>
        ))}
      </div>
      <div className="bp-dialog-body bp-dialog-body--flush">
        <div className={`bp-payee-manager-body${rulesMode ? ' is-rules-mode' : ''}`} role="tabpanel" id={`payee-panel-${m.mode}`} aria-labelledby={`payee-tab-${m.mode}`}>
          {rulesMode ? (
            <section className="bp-payee-pane bp-payee-rail">
              <div className="bp-pane-head bp-payee-rail-head">
                <label className="bp-search">
                  <Search aria-hidden="true" />
                  <input
                    ref={searchRef}
                    aria-label="Find rules"
                    placeholder="Find rules"
                    value={m.ruleSearch}
                    onChange={(event) => m.setRuleSearch(event.target.value)}
                  />
                </label>
              </div>
              <div className="bp-rule-filters">
                <FilterSelect
                  ariaLabel="Filter rules by payee"
                  autoFocus={false}
                  searchable
                  value={m.rulePayeeFilter === null ? '' : String(m.rulePayeeFilter)}
                  options={[
                    { value: '', label: 'All payees' },
                    ...m.payees.map((payee) => ({ value: String(payee.id), label: payee.name })),
                  ]}
                  onChange={(value) => m.setRulePayeeFilter(value ? Number(value) : null)}
                />
                <FilterSelect
                  ariaLabel="Filter rules by category"
                  autoFocus={false}
                  searchable
                  value={m.ruleCategoryFilter === null ? '' : String(m.ruleCategoryFilter)}
                  options={[{ value: '', label: 'All categories' }, ...categoryOptions]}
                  onChange={(value) => m.setRuleCategoryFilter(value ? Number(value) : null)}
                />
                <FilterSelect
                  ariaLabel="Filter rules by account"
                  autoFocus={false}
                  value={m.ruleAccountFilter === null ? '' : String(m.ruleAccountFilter)}
                  options={[
                    { value: '', label: 'All accounts' },
                    ...accounts.map((account) => ({ value: String(account.id), label: account.name })),
                  ]}
                  onChange={(value) => m.setRuleAccountFilter(value ? Number(value) : null)}
                />
              </div>
              <div className="bp-rule-order-note">
                <span className="bp-label">
                  Checked top to bottom. The first match decides.
                  {trace && ' Marks show how they apply to the picked transaction.'}
                </span>
                {m.filteredOrder && (
                  <Button size="sm" variant="quiet" onClick={m.clearRuleFilters}>
                    Clear filters to reorder
                  </Button>
                )}
              </div>
              <div className="bp-pane-head bp-rule-section-head"><span className="bp-label">Rules</span><Button size="sm" disabled={m.busy} onClick={m.newGlobalRule}><Plus aria-hidden="true" />New rule</Button></div>
              <div className="bp-rail-list bp-payee-list">
                {m.filteredRules.map((rule) => (
                  <PayeeRuleRow
                    key={rule.id}
                    rule={rule}
                    accounts={accounts}
                    payees={m.payees}
                    categories={m.categories}
                    disabled={m.busy}
                    first={rule.position === 1}
                    last={rule.position === m.rules.length}
                    moveDisabled={m.filteredOrder || m.ruleDirty}
                    mark={
                      trace
                        ? trace.deciding_rule_id === rule.id
                          ? 'decides'
                          : trace.matching_rule_ids.includes(rule.id)
                            ? 'matches'
                            : 'dim'
                        : null
                    }
                    onEdit={() => m.editRule(rule)}
                    onMove={(direction) => void m.moveRule(rule, direction)}
                  />
                ))}
                {!m.filteredRules.length && (
                  <div className="bp-empty">{m.rules.length ? 'No matching rules.' : 'No rules yet.'}</div>
                )}
              </div>
              {m.draft && m.editorOpen && <div className="bp-rule-global-editor">
                <PayeeRuleEditor key={m.editorKey} draft={m.draft} accounts={accounts} payees={m.payees} categories={m.categories} disabled={m.busy} onChange={m.changeDraft} />
                {m.staleRule && <p className="bp-callout bp-callout--warning">Rules changed. Refresh or compare before saving.</p>}
                <div className="bp-pane-footer"><Button size="md" disabled={m.busy} onClick={m.cancelRule}>Cancel</Button><Button size="md" variant="primary" disabled={m.busy || !m.ruleDirty || m.staleRule || !ruleReady(m.draft)} onClick={() => void m.saveRule()}><Save aria-hidden="true" />Save rule</Button></div>
              </div>}
              <div className="bp-pane-footer">
                <span className="bp-field-hint bp-pane-footer-note">
                  Moves save immediately and affect future imports only.
                </span>
              </div>
            </section>
          ) : (
            <>
              <aside className="bp-payee-pane bp-payee-rail bp-rail">
                <div className="bp-pane-head bp-payee-rail-head">
                  <label className="bp-search">
                    <Search aria-hidden="true" />
                    <input
                      ref={searchRef}
                      aria-label="Search payees"
                      placeholder="Search payees"
                      value={m.payeeSearch}
                      onChange={(event) => m.setPayeeSearch(event.target.value)}
                    />
                  </label>
                </div>
                <div className="bp-rail-list bp-payee-list">
                  {m.filteredPayees.map((payee) => (
                    <div key={payee.id} className="bp-payee-row">
                      <button
                        type="button"
                        className={`bp-rail-row${m.selectedPayeeId === payee.id ? ' is-selected' : ''}`}
                        disabled={m.busy}
                        onClick={() => m.selectPayee(payee.id)}
                      >
                        <span>{payee.name}</span>
                        <b>{assignmentCounts ? assignmentCounts[payee.id] ?? 0 : '—'}</b>
                      </button>
                      {payee.kind === 'ordinary' && assignmentCounts !== undefined && (assignmentCounts[payee.id] ?? 0) === 0 && payee.schedule_count === 0 && (
                        <Button
                          size="sm"
                          variant="danger"
                          iconOnly
                          aria-label={`Delete ${payee.name}`}
                          title="Delete unused payee"
                          disabled={m.busy}
                          onClick={() => m.requestPayeePreview(payee.id, 'delete')}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="bp-pane-footer">
                  <Button size="lg" disabled={m.busy} onClick={() => m.beginName('create')}>
                    <Plus aria-hidden="true" />
                    New payee
                  </Button>
                  {Boolean(m.unusedPayeeCount) && (
                    <Button size="lg" variant="danger" disabled={m.busy}
                      onMouseDown={(event) => { if (event.button === 0 && naming) event.preventDefault() }}
                      onClick={() => { if (naming) namingCancelled.current = true; m.requestUnusedDelete() }}>
                      <Trash2 aria-hidden="true" />
                      Delete unused payees ({m.unusedPayeeCount})
                    </Button>
                  )}
                </div>
              </aside>
              <section className="bp-payee-pane bp-rule-pane">
                <div className="bp-pane-head bp-rule-head">
                  {m.selectedPayee ? (
                    <>
                      <span className="bp-label">Payee</span>
                      <strong>{m.selectedPayee.name}</strong>
                    </>
                  ) : (
                    <strong>Payee details</strong>
                  )}
                  {m.selectedPayee && (
                    <div className="bp-rule-header-actions">
                      {m.selectedPayee.kind === 'ordinary' && <>
                      <Button size="sm" variant="quiet" disabled={m.busy} onClick={() => m.beginName('rename')}>
                        <Pencil aria-hidden="true" />
                        Rename
                      </Button>
                      <Button size="sm" variant="quiet" disabled={m.busy} onClick={() => m.requestPayeePreview(m.selectedPayeeId, 'replace')}>Replace</Button>
                      <Button size="sm" variant="danger" disabled={m.busy} onClick={() => m.requestPayeePreview(m.selectedPayeeId, 'delete')}>
                        <Trash2 aria-hidden="true" />
                        Delete
                      </Button>
                      </>}
                    </div>
                  )}
                </div>
                {naming && (
                  <div className="bp-payee-name-editor">
                    <label className="bp-field">
                      {m.nameMode === 'create' ? 'New payee' : 'Rename payee'}
                      <input
                        ref={nameRef}
                        className="bp-control"
                        aria-label="Payee name"
                        onFocus={() => { namingCancelled.current = false }}
                        value={m.nameDraft ?? ''}
                        disabled={m.busy}
                        onChange={(event) => m.setNameDraft(event.target.value)}
                        onBlur={() => {
                          if (!namingCancelled.current) void m.saveName()
                        }}
                        onKeyDown={(event) => {
                          if (isComposingKey(event.nativeEvent)) return
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void m.saveName()
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            event.stopPropagation()
                            namingCancelled.current = true
                            m.cancelName()
                          }
                        }}
                      />
                    </label>
                    <p className="bp-field-hint">Enter saves. Escape cancels.</p>
                  </div>
                )}
                {m.nameConflict && (
                  <div className="bp-callout bp-callout--error">
                    {m.nameConflict.name} already exists.{' '}
                    <Button size="md" disabled={m.busy} onClick={m.chooseNameConflict}>
                      Select existing payee
                    </Button>
                  </div>
                )}
                {m.selectedPayee && !naming ? (
                  <>
                    {m.selectedPayee.kind === 'ordinary' && <div className="bp-payee-default-category">
                      <label className="bp-field bp-field--dense">
                        Default category
                        <FilterSelect
                          ariaLabel="Default category"
                          autoFocus={false}
                          searchable
                          disabled={m.busy}
                          value={m.defaultDraft === null ? '' : String(m.defaultDraft)}
                          options={[
                            { value: '', label: 'No default' },
                            ...m.categories
                              .flatMap((parent) =>
                                parent.children
                                  .filter(
                                    (child) =>
                                      (!parent.archived && !child.archived) || child.id === m.defaultDraft,
                                  )
                                  .map((child) => ({
                                    value: String(child.id),
                                    label: `${parent.name}: ${child.name}${parent.archived || child.archived ? ' (unavailable)' : ''}`,
                                  })),
                              ),
                          ]}
                          onChange={(value) => m.setDefaultDraft(value ? Number(value) : null)}
                        />
                      </label>
                      <Button size="md" busy={m.defaultSavingAction !== null} disabled={m.busy || !m.defaultDirty} onClick={() => void m.saveDefault()}>
                        {m.defaultSavingAction !== null ? 'Saving…' : 'Save'}
                      </Button>
                      <p className="bp-field-hint">
                        Used when a rule assigns {m.selectedPayee.name} without setting a category.
                      </p>
                    </div>}
                    <div className="bp-pane-head bp-rule-section-head">
                      <span className="bp-label">Rules that assign {m.selectedPayee.name}</span>
                      <Button size="sm" disabled={m.busy} onClick={m.newRule}>
                        <Plus aria-hidden="true" />
                        New rule
                      </Button>
                    </div>
                    <div className="bp-rule-list">
                      {ownedRules.map((rule) => (
                        <PayeeRuleRow
                          key={rule.id}
                          rule={rule}
                          accounts={accounts}
                          payees={m.payees}
                          categories={m.categories}
                          showPayee={false}
                          selected={rule.id === m.draft?.id}
                          disabled={m.busy}
                          edit="pencil"
                          onSelect={() => m.viewRule(rule)}
                          onEdit={() => m.selectRule(rule)}
                        />
                      ))}
                      {!ownedRules.length && !m.draft && (
                        <div className="bp-empty">No rules assign {m.selectedPayee.name} yet.</div>
                      )}
                    </div>
                    {m.draft && m.editorOpen && (
                      <>
                        <div className="bp-pane-head bp-rule-section-head">
                          <span className="bp-label">
                            {selectedRule ? `Rule ${selectedRule.position} of ${m.rules.length}` : 'New rule'}
                          </span>
                          <div className="bp-rule-header-actions">
                            <Button
                              size="sm"
                              variant="quiet"
                              disabled={m.busy || !ruleReady(m.draft)}
                              onClick={m.duplicateRule}
                            >
                              <Copy aria-hidden="true" />
                              Duplicate
                            </Button>
                            {selectedRule && (
                              <Button size="sm" variant="danger" disabled={m.busy} onClick={m.requestRuleDelete}>
                                <Trash2 aria-hidden="true" />
                                Delete rule
                              </Button>
                            )}
                          </div>
                        </div>
                        <PayeeRuleEditor
                          key={m.editorKey}
                          draft={m.draft}
                          accounts={accounts}
                          payees={m.payees}
                          categories={m.categories}
                          disabled={m.busy}
                          onChange={m.changeDraft}
                        />
                        {m.staleRule && (
                          <div className="bp-callout bp-callout--warning">
                            <p>Rules changed since this draft opened.</p>
                            <Button size="md" disabled={m.busy} onClick={m.keepDraft}>
                              Keep draft
                            </Button>
                            <Button size="md" disabled={m.busy} onClick={m.useSavedRule}>
                              Use saved rule
                            </Button>
                          </div>
                        )}
                        {m.duplicateRuleId !== null && (
                          <div className="bp-callout bp-callout--error">
                            <p>These conditions duplicate an existing rule.</p>
                            <Button
                              size="md"
                              disabled={m.busy}
                              onClick={() => {
                                const rule = m.rules.find((rule) => rule.id === m.duplicateRuleId)
                                if (rule) m.editRule(rule)
                              }}
                            >
                              Show duplicate rule
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                    <div className="bp-pane-footer">
                      {m.draft && m.editorOpen ? (
                        <>
                          <span className="bp-field-hint bp-pane-footer-note">Save can also apply this rule to matching transactions.</span>
                          <Button size="lg" disabled={m.busy} onClick={m.cancelRule}>
                            Cancel
                          </Button>
                          <Button
                            size="lg"
                            variant="primary"
                            disabled={m.busy || !m.ruleDirty || m.staleRule || !ruleReady(m.draft)}
                            onClick={() => void m.saveRule()}
                          >
                            <Save aria-hidden="true" />
                            Save rule
                          </Button>
                        </>
                      ) : (
                        <Button size="lg" disabled={m.busy} onClick={() => m.setMode('rules')}>
                          See all rules in order
                          <ArrowRight aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  !naming && <div className="bp-empty">Select a payee.</div>
                )}
              </section>
            </>
          )}
          <section className="bp-payee-pane bp-payee-history">
            {(!rulesMode || previewing) && (
              <div className="bp-tabs bp-payee-tabs" role="tablist" aria-label="Transaction view">
                <button
                  type="button"
                  role="tab"
                  id="payee-history-tab-current"
                  aria-controls="payee-history-panel"
                  aria-selected={m.historyScope === 'current'}
                  className={m.historyScope === 'current' ? 'is-active' : ''}
                  onClick={() => m.setHistoryScope('current')}
                >
                  Payee transactions{assignedCount !== undefined ? ` (${assignedCount})` : ''}
                </button>
                <button
                  type="button"
                  role="tab"
                  id="payee-history-tab-all"
                  aria-controls="payee-history-panel"
                  aria-selected={m.historyScope === 'all'}
                  className={m.historyScope === 'all' ? 'is-active' : ''}
                  onClick={() => m.setHistoryScope('all')}
                >
                  All transactions
                </button>
                {!rulesMode && (m.selectedPayee?.schedule_count ?? 0) > 0 && <button
                  type="button"
                  role="tab"
                  id="payee-history-tab-schedules"
                  aria-controls="payee-history-panel"
                  aria-selected={m.schedulesSelected}
                  className={m.schedulesSelected ? 'is-active' : ''}
                  onClick={() => m.setHistoryScope('schedules')}
                >
                  Schedules ({m.selectedPayee?.schedule_count})
                </button>}
                {m.draft && (
                  <button
                    type="button"
                    role="tab"
                    id="payee-history-tab-matches"
                    aria-controls="payee-history-panel"
                    aria-selected={m.historyScope === 'matches'}
                    className={m.historyScope === 'matches' ? 'is-active' : ''}
                    onClick={() => m.setHistoryScope('matches')}
                  >
                    Matches rule{matchCount !== null ? ` (${matchCount})` : ''}
                  </button>
                )}
              </div>
            )}
            <div className="bp-payee-history-panel" role={!rulesMode || previewing ? 'tabpanel' : undefined} id="payee-history-panel" aria-labelledby={!rulesMode || previewing ? `payee-history-tab-${m.historyScope}` : undefined}>
              {m.schedulesSelected ? <PayeeSchedules manager={m} /> : <>
              {rulesMode && !previewing ? (
                <>
                  <div className="bp-pane-head">
                    <strong>Check a transaction</strong>
                    <span className="bp-label">Which rule decides it?</span>
                  </div>
                  {m.traceTransactionId !== null && (
                    <TraceCard
                      trace={trace}
                      loading={m.trace.isFetching && !trace}
                      error={m.trace.error?.message ?? null}
                      accounts={accounts}
                      categories={m.categories}
                      payees={m.payees}
                      rulePosition={(id) => m.rules.find((rule) => rule.id === id)?.position ?? null}
                      onClear={() => m.setTraceTransactionId(null)}
                    />
                  )}
                  {historyControls}
                </>
              ) : (
                <>
                  {previewing ? (
                    <div className="bp-payee-preview-band">
                      {m.previewSettling && ruleReady(m.draft) ? (
                        <p>Updating preview…</p>
                      ) : !m.previewEnabled ? (
                        <p>Add a condition and the matching rows appear here.</p>
                      ) : m.preview.error ? (
                        <p className="bp-payee-preview-error" role="alert">
                          {m.preview.error.message}
                        </p>
                      ) : m.preview.data && !m.preview.isFetching ? (
                        <div>
                          <span>
                            {selectedRule ? `Rule ${selectedRule.position}` : 'This rule'} matches{' '}
                            <b>{m.preview.data.counts.matching}</b>
                          </span>
                          <span>
                            decides <b>{m.preview.data.counts.decides}</b>
                          </span>
                          <span>
                            earlier rules win <b>{m.preview.data.counts.earlier}</b>
                          </span>
                          {m.preview.data.counts.blocked > 0 && (
                            <span>
                              can’t change yet <b>{m.preview.data.counts.blocked}</b>
                            </span>
                          )}
                        </div>
                      ) : (
                        <p>{m.preview.isFetching && m.preview.data ? 'Updating preview…' : 'Loading preview…'}</p>
                      )}
                      <p>
                        Apply sets the payee. Rows without splits also get the category shown; split rows keep theirs.
                        {m.ruleDirty && ' Applying does not save the rule.'}
                        {(m.preview.data?.counts.blocked ?? 0) > 0 &&
                          ' Rows in accounts that aren’t set up yet stay read-only until the account is initialized.'}
                      </p>
                    </div>
                  ) : (
                    historyControls
                  )}
                </>
              )}
              {!previewing && m.history.error && (
                <div className="bp-callout bp-callout--error" role="alert">
                  {m.history.error.message}
                </div>
              )}
              {(!rulesMode || previewing) && (
                <div className="bp-payee-selection-bar">
                  <label className="bp-check">
                    <input
                      type="checkbox"
                      disabled={historyBusy || !eligible.length}
                      checked={eligible.length > 0 && eligible.every((row) => selected.has(row.id))}
                      onChange={() => (previewing ? m.togglePreview(rows, true) : m.toggleFind(eligible))}
                    />
                    {previewing ? 'Select rows this rule decides' : 'Select displayed'}
                  </label>
                  <strong>
                    {selected.size} selected{hiddenSelected > 0 && ` · ${hiddenSelected} hidden`}
                  </strong>
                </div>
              )}
              {needsPayee ? (
                <div className="bp-empty">Select a payee to see its transactions.</div>
              ) : (
                <HistoryRows
                  rows={rows}
                  selected={selected}
                  selectable={!rulesMode || previewing}
                  pickedId={rulesMode && !previewing ? m.traceTransactionId : null}
                  onToggle={(row) => (previewing ? m.togglePreview([row]) : m.toggleFind([row]))}
                  onPick={(row) => m.setTraceTransactionId(row.id)}
                  accounts={accounts}
                  categories={m.categories}
                  payees={m.payees}
                  disabled={historyBusy}
                  decisions={previewing ? decisions : undefined}
                />
              )}
              <div className="bp-pane-footer bp-payee-history-actions">
                {pagination}
                {(!rulesMode || previewing) && (
                  <Button
                    size="lg"
                    variant="primary"
                    disabled={historyBusy || !selected.size || !previewing && !m.selectedPayee}
                    onClick={() => void m.apply()}
                  >
                    {previewing ? `Apply rule to ${selected.size}` : `Assign to ${m.selectedPayee?.name ?? 'payee'}`}
                  </Button>
                )}
              </div>
              </>}
            </div>
          </section>
        </div>
        {(m.error || m.queryError || m.rulesEvaluationError || m.outcomeUnknown || m.needsRefresh) && (
          <div className="bp-payee-manager-status">
            <div
              className={`bp-callout ${m.error || m.queryError || m.outcomeUnknown || m.needsRefresh ? 'bp-callout--error' : 'bp-callout--warning'}`}
              role={m.error || m.queryError || m.outcomeUnknown || m.needsRefresh ? 'alert' : 'status'}
            >
              {(m.error || m.queryError) && <p>{m.error ?? m.queryError?.message}</p>}
              {m.rulesEvaluationError && <p>{m.rulesEvaluationError}</p>}
              {!m.error && !m.queryError && (m.outcomeUnknown || m.needsRefresh) && (
                <p>Refresh and inspect saved state before another write.</p>
              )}
              {(m.outcomeUnknown || m.needsRefresh) && (
                <Button size="md" disabled={m.pending} onClick={() => void refresh()}>
                  Refresh and inspect
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      {m.defaultPrompt && (
        <PayeeSavePrompt
          titleId="payee-default-save-title"
          subtitle={m.defaultPrompt.payee.name}
          title="Save default category?"
          saveLabel="Save default only"
          updateLabel={`Save and update ${m.defaultTargets?.length ?? 0}`}
          updateDisabled={!m.defaultTargets?.length}
          savingAction={m.defaultSavingAction}
          disabled={m.busy}
          onCancel={m.cancelDefault}
          onSave={() => void m.completeDefault(false)}
          onUpdate={() => void m.completeDefault(true)}
          recovery={
            m.outcomeUnknown || m.needsRefresh ? (
              <Button size="md" disabled={m.pending} onClick={() => void refresh()}>
                Refresh and inspect
              </Button>
            ) : undefined
          }
        >
          {m.defaultTargets?.length ?? 0} eligible transactions are currently uncategorized. Apply the default
          to them too?
        </PayeeSavePrompt>
      )}
      {m.rulePrompt && (
        <PayeeSavePrompt
          titleId="payee-rule-save-title"
          subtitle={m.payees.find((payee) => payee.id === m.rulePrompt?.draft.payee_id)?.name ?? ''}
          title="Save rule?"
          saveLabel="Save rule only"
          updateLabel={`Save and apply ${m.rulePrompt.count}`}
          savingAction={m.ruleSavingAction}
          disabled={m.busy}
          onCancel={m.cancelRulePrompt}
          onSave={() => void m.completeRule(false)}
          onUpdate={() => void m.completeRule(true)}
          recovery={
            <>
              {m.error && <div className="bp-callout bp-callout--error" role="alert">{m.error}</div>}
              {(m.outcomeUnknown || m.needsRefresh) && (
                <Button size="md" disabled={m.pending} onClick={() => void refresh()}>
                  Refresh and inspect
                </Button>
              )}
            </>
          }
        >
          {m.rulePrompt.count} matching transactions would change. Apply this rule to them too?
        </PayeeSavePrompt>
      )}
      {m.intent && !m.defaultPrompt && !m.rulePrompt && (
        <PayeeGuard
          titleId="payee-unsaved-title"
          subtitle="Your Payee or rule edits have not been saved."
          initialFocusRef={guardCancelRef}
          title="Save changes?"
          onClose={m.cancelIntent}
          closeDisabled={m.busy}
          footer={
            <>
              <Button ref={guardCancelRef} size="lg" disabled={m.busy} onClick={m.cancelIntent}>
                Cancel
              </Button>
              <Button size="lg" disabled={m.busy} onClick={m.discardThenContinue}>
                Discard
              </Button>
              <Button
                size="lg"
                variant="primary"
                disabled={m.busy || (m.ruleDirty && (!ruleReady(m.draft) || m.staleRule))}
                busy={m.pending}
                onClick={() => void m.saveThenContinue()}
              >
                {m.pending ? 'Saving…' : 'Save'}
              </Button>
            </>
          }
        >
          {(m.outcomeUnknown || m.needsRefresh) && (
            <Button size="md" disabled={m.pending} onClick={() => void refresh()}>
              Refresh and inspect
            </Button>
          )}
        </PayeeGuard>
      )}
      {m.ruleToDelete && (
        <PayeeGuard
          titleId="payee-rule-delete-title"
          subtitle="Existing transaction assignments stay unchanged."
          initialFocusRef={guardCancelRef}
          title={`Delete rule ${m.ruleToDelete.position}?`}
          role="alertdialog"
          onClose={m.cancelRuleDelete}
          closeDisabled={m.busy}
          footer={
            <>
              <Button ref={guardCancelRef} size="lg" disabled={m.busy} onClick={m.cancelRuleDelete}>
                Cancel
              </Button>
              <Button size="lg" variant="danger" busy={m.pending} disabled={m.busy} onClick={m.confirmRuleDelete}>
                {m.pending ? 'Deleting…' : 'Delete rule'}
              </Button>
            </>
          }
        >
          {(m.outcomeUnknown || m.needsRefresh) && (
            <Button size="md" disabled={m.pending} onClick={() => void refresh()}>
              Refresh and inspect
            </Button>
          )}
        </PayeeGuard>
      )}
      {m.unusedDeletePreview && (
        <PayeeGuard
          titleId="unused-payees-delete-title"
          subtitle="Payees that no transaction or schedule in your ledger shows."
          initialFocusRef={guardCancelRef}
          title={unusedPayeeCount ? `Delete ${unusedPayeeCount} unused payee${unusedPayeeCount === 1 ? '' : 's'}?` : 'No unused payees to delete'}
          role="alertdialog"
          onClose={m.cancelUnusedDelete}
          closeDisabled={m.busy}
          footer={<>
            <Button ref={guardCancelRef} size="lg" disabled={m.busy} onClick={m.cancelUnusedDelete}>Cancel</Button>
            <Button size="lg" variant="danger" busy={m.pending} disabled={m.busy || unusedPayeeCount === 0} onClick={m.confirmUnusedDelete}>{m.pending ? 'Deleting…' : 'Delete unused payees'}</Button>
          </>}
        >
          {unusedPayeeCount > 0 ? <>
            <div className="bp-payee-reference-rows">{m.unusedDeletePreview.payees.map((payee) => <div key={payee.id} className="bp-payee-transaction is-static">
              <span>
                <strong>{payee.name}</strong>
                <PayeeDeletionEffects compact following={payee.following_transaction_count} unknown={payee.unknown_transaction_count} rules={payee.rules} />
              </span>
            </div>)}</div>
            <p className="bp-note">Records that follow their ledger transaction switch to the payee it shows. This can’t be undone and clears earlier Undo history.</p>
          </> : <p className="bp-dialog-copy">No unused payees remain.</p>}
          {(m.outcomeUnknown || m.needsRefresh) && <>
            {m.error && <div className="bp-callout bp-callout--error" role="alert">{m.error}</div>}
            <Button size="md" disabled={m.pending} onClick={() => void refresh()}>Refresh and inspect</Button>
          </>}
        </PayeeGuard>
      )}
      {m.referencesState && <PayeeReferencesDialog manager={m} onRefresh={refresh} />}
    </Modal>
  )
}

function PayeeSchedules({ manager: m }: { manager: ReturnType<typeof usePayeeManager> }) {
  const data = m.scheduleAssignments.data
  if (!m.selectedPayee) return <div className="bp-empty">Select a payee to see its schedules.</div>
  if (m.scheduleAssignments.isError) return <div className="bp-callout bp-callout--error" role="alert">
    <p>Schedules could not be loaded.</p>
    <Button size="md" disabled={m.busy} onClick={() => void m.scheduleAssignments.refetch()}>Retry</Button>
  </div>
  if (!data || m.scheduleAssignments.isFetching) return <div className="bp-empty" role="status">Loading schedules…</div>
  const ids = data.rows.map((row) => row.id)
  const offPage = [...m.selectedScheduleIds].filter((id) => !ids.includes(id)).length
  const destinations = m.payees.filter((payee) => payee.id !== m.selectedPayeeId)
  return <>
    <div className="bp-payee-schedule-summary">Every schedule that uses this payee, in all accounts, including closed ones.</div>
    {data.total_count > 0 && <div className="bp-payee-selection-bar">
      <label className="bp-check">
        <input type="checkbox" disabled={m.busy} checked={ids.every((id) => m.selectedScheduleIds.has(id))} onChange={() => m.toggleSchedules(ids)} />
        Select displayed
      </label>
      <strong>{m.selectedScheduleIds.size} selected{offPage > 0 && ` · ${offPage} on other pages`}</strong>
    </div>}
    <div className="bp-payee-history-list">
      {data.total_count === 0 ? <div className="bp-empty">No schedules.</div> : data.rows.map((row) => <label key={row.id} className={`bp-payee-transaction${m.selectedScheduleIds.has(row.id) ? ' is-selected' : ''}`}>
        <input type="checkbox" checked={m.selectedScheduleIds.has(row.id)} disabled={m.busy} onChange={() => m.toggleSchedules([row.id])} />
        <span><strong>{data.payee.name}</strong><small>{[scheduleFrequencyLabel(row.frequency), row.memo].filter(Boolean).join(' · ')}</small></span>
        <span><b className={row.amount_cents > 0 ? 'is-positive' : undefined}>{money(row.amount_cents)}</b><small>{row.account_name} · {row.date}</small></span>
      </label>)}
    </div>
    {data.total_count > 0 && <div className="bp-pane-footer bp-payee-history-actions">
      <PayeeReferencePagination total={data.total_count} offset={data.offset} nextOffset={data.next_offset} disabled={m.busy} onPage={m.setScheduleOffset} />
      <FilterSelect ariaLabel="Assign schedules to payee" autoFocus={false} searchable disabled={m.busy}
        value={m.scheduleDestinationId === null ? '' : String(m.scheduleDestinationId)}
        options={[{ value: '', label: 'Choose a payee' }, ...destinations.map((payee) => ({ value: String(payee.id), label: payee.name }))]}
        onChange={(value) => m.setScheduleDestinationId(value ? Number(value) : null)} />
      <Button size="lg" variant="primary" disabled={m.busy || !m.selectedScheduleIds.size || m.scheduleDestinationId === null} onClick={async () => {
        await m.assignSchedules()
        if (document.activeElement === document.body)
          document.querySelector<HTMLButtonElement>('.bp-payee-tabs [aria-selected="true"]')?.focus({ preventScroll: true })
      }}>Assign selected</Button>
    </div>}
  </>
}

function TraceCard({
  trace,
  loading,
  error,
  accounts,
  categories,
  payees,
  rulePosition,
  onClear,
}: {
  trace: PayeeRuleTrace | undefined
  loading: boolean
  error: string | null
  accounts: Account[]
  categories: CategoryTree[]
  payees: { id: number; name: string }[]
  rulePosition: (id: number) => number | null
  onClear: () => void
}) {
  const row = trace?.transaction
  const others = trace ? trace.matching_rule_ids.filter((id) => id !== trace.deciding_rule_id).length : 0
  return (
    <div className="bp-rule-trace">
      <div className="bp-rule-trace-head">
        <strong>{row ? (row.rule_description ?? row.description) : loading ? 'Checking…' : 'Transaction'}</strong>
        <Button size="sm" variant="quiet" onClick={onClear}>
          <X aria-hidden="true" />
          Clear
        </Button>
      </div>
      {error && <p className="bp-field-hint">{error}</p>}
      {trace && row && (
        <>
          <dl className="bp-rule-trace-facts">
            <dt>Description</dt>
            <dd>{row.rule_description ?? row.description}</dd>
            <dt>Merchant</dt>
            <dd>{trace.merchant_name ?? <span className="bp-field-hint">none</span>}</dd>
            <dt>Account</dt>
            <dd>{accounts.find((account) => account.id === row.account_id)?.name ?? 'Account'}</dd>
            <dt>Amount</dt>
            <dd>{money(row.amount_cents)}</dd>
            <dt>Now</dt>
            <dd>
              {row.payee_name ?? 'No payee'} ·{' '}
              {row.allocations.length
                ? `Split (${row.allocations.length})`
                : row.subcategory_name
                  ? `${row.category_name}: ${row.subcategory_name}`
                  : (row.category_name ?? 'Uncategorized')}
            </dd>
          </dl>
          {trace.deciding_rule_id !== null ? (
            <div className="bp-rule-verdict">
              <span className="bp-rule-mark is-decides">Rule {rulePosition(trace.deciding_rule_id) ?? '?'} decides</span>
              <strong>{payees.find((payee) => payee.id === trace.payee_id)?.name ?? trace.fallback_name ?? row.payee_name}</strong>
              {trace.category_id !== null && (
                <>
                  <span className="bp-field-hint">·</span>
                  <span className="bp-rule-verdict-category">{categoryResult(categories, trace.category_id).label}</span>
                </>
              )}
              <span className="bp-field-hint bp-rule-verdict-note">
                {others === 0
                  ? 'No other rule matches.'
                  : others === 1
                    ? '1 other rule also matches but comes later.'
                    : `${others} other rules also match but come later.`}
              </span>
            </div>
          ) : (
            <div className="bp-rule-verdict is-none">
              <span className="bp-rule-mark is-none">No rule matches</span>
              <span className="bp-field-hint">
                {trace.fallback_name
                  ? `Import would fall back to the bank name “${trace.fallback_name}”.`
                  : 'Manual rows get no import fallback.'}
              </span>
            </div>
          )}
          <p className="bp-field-hint">
            Rules run once at first import. This shows what the current rules would decide for this transaction.
          </p>
        </>
      )}
    </div>
  )
}

const BLOCKED_LABELS = {
  account_not_initialized: 'Account not set up yet',
  not_editable: 'Can’t be changed',
} as const

function HistoryRows({
  rows,
  selected,
  selectable,
  pickedId,
  onToggle,
  onPick,
  accounts,
  categories,
  payees,
  disabled,
  decisions,
}: {
  rows: LedgerRow[]
  selected: Map<number, LedgerRow>
  selectable: boolean
  pickedId: number | null
  onToggle: (row: LedgerRow) => void
  onPick: (row: LedgerRow) => void
  accounts: Account[]
  categories: CategoryTree[]
  payees: { id: number; name: string }[]
  disabled: boolean
  decisions?: PayeePreview['decisions']
}) {
  return (
    <div className="bp-payee-history-list">
      {rows.map((row) => {
        const decision = decisions?.[String(row.id)]
        const proposedPayee = payees.find((payee) => payee.id === decision?.payee_id)?.name
        const content = (
          <>
            <span>
              <strong>
                {row.payee_name ?? 'No payee'}
                {decision && proposedPayee && row.payee_id !== decision.payee_id && (
                  <>
                    {' '}
                    <i>→</i> <em>{proposedPayee}</em>
                  </>
                )}
              </strong>
              {decision ? (
                row.allocations.length ? (
                  <small className="is-kept">Split ({row.allocations.length}) · split categories are kept</small>
                ) : (
                  <small>
                    {row.subcategory_name ? `${row.category_name}: ${row.subcategory_name}` : (row.category_name ?? 'Uncategorized')}
                    {decision.changes_category && decision.category_id !== row.category_id && (
                      <>
                        {' '}
                        <i>→</i> <b>{categoryResult(categories, decision.category_id).label}</b>
                      </>
                    )}
                  </small>
                )
              ) : (
                <small>
                  {row.rule_description ?? row.description}
                  {row.category_name ? ` · ${row.subcategory_name ? `${row.category_name}: ${row.subcategory_name}` : row.category_name}` : ''}
                </small>
              )}
              {decision && row.transfer && <small>Transfer: {row.transfer.account_name}</small>}
              {decision?.changes_retained_payee && <small>Updates saved payee on original records</small>}
            </span>
            <span>
              <b className={row.amount_cents > 0 ? 'is-positive' : undefined}>{money(row.amount_cents)}</b>
              <small>
                {accounts.find((account) => account.id === row.account_id)?.name ?? 'Account'} · {row.date}
              </small>
              {decision?.blocked && <small className="bp-payee-blocked">{BLOCKED_LABELS[decision.blocked]}</small>}
            </span>
          </>
        )
        if (decision?.blocked)
          return (
            <div key={row.id} className="bp-payee-transaction is-blocked">
              <span aria-hidden="true" />
              {content}
            </div>
          )
        if (!selectable)
          return (
            <button
              key={row.id}
              type="button"
              className={`bp-payee-transaction is-static${pickedId === row.id ? ' is-picked' : ''}`}
              disabled={disabled}
              onClick={() => onPick(row)}
            >
              {content}
            </button>
          )
        return (
          <label key={row.id} className={`bp-payee-transaction${selected.has(row.id) ? ' is-selected' : ''}`}>
            <input
              type="checkbox"
              checked={selected.has(row.id)}
              disabled={
                disabled ||
                (decision ? !decision.eligible : !canEditField(row, 'payee_id'))
              }
              onChange={() => onToggle(row)}
            />
            {content}
          </label>
        )
      })}
    </div>
  )
}
