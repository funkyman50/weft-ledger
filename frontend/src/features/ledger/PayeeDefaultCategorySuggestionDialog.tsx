import { useEffect } from 'react'
import type { Payee, PayeeDefaultCategorySuggestion } from '../../api/types'
import { Button } from '../../components/Button'
import { PayeeSavePrompt } from '../payees/PayeeSavePrompt'
import { usePayeeDefaultCategory } from '../payees/usePayeeDefaultCategory'

export function PayeeDefaultCategorySuggestionDialog({
  suggestion,
  payee,
  categoryLabel,
  onClose,
  onInspect,
}: {
  suggestion: PayeeDefaultCategorySuggestion
  payee: Payee
  categoryLabel: string
  onClose: () => void
  onInspect: () => Promise<unknown>
}) {
  const defaultCategory = usePayeeDefaultCategory()
  const { preview } = defaultCategory
  useEffect(() => {
    void preview(payee, suggestion.category_id)
  }, [payee, preview, suggestion.category_id])
  const recovery = defaultCategory.outcomeUnknown || defaultCategory.requiresRefresh
  const busy = defaultCategory.saving || recovery
  const cancel = () => { if (!busy) onClose() }
  const save = async (updateHistory: boolean) => {
    const targets = updateHistory ? defaultCategory.targets : []
    if (busy || targets === null || (updateHistory && !targets.length)) return
    if (await defaultCategory.save(payee, suggestion.category_id, targets)) onClose()
  }
  const recover = async () => {
    try {
      await onInspect()
      if (!await defaultCategory.inspect()) return
      defaultCategory.clearRecovery()
    } catch {
      return
    }
  }
  return <PayeeSavePrompt
    titleId="payee-default-suggestion-title"
    title="Save default category?"
    subtitle={`${payee.name} · ${categoryLabel}`}
    saveLabel="Save default only"
    updateLabel={defaultCategory.targets === null ? 'Save and update…' : `Save and update ${defaultCategory.targets.length}`}
    updateDisabled={!defaultCategory.targets?.length}
    savingAction={defaultCategory.savingAction}
    disabled={recovery}
    onCancel={cancel}
    onSave={() => void save(false)}
    onUpdate={() => void save(true)}
    recovery={defaultCategory.error || recovery ? (
      <div className="bp-callout bp-callout--error" role="alert">
        <p>{defaultCategory.error ?? 'Refresh and inspect facts before another write.'}</p>
        <div className="bp-callout-actions">
          <Button size="md" disabled={defaultCategory.saving} onClick={() => void (recovery ? recover() : preview(payee, suggestion.category_id))}>{recovery ? 'Refresh' : 'Retry'}</Button>
        </div>
      </div>
    ) : undefined}
  >
    Do you want to make <strong>{categoryLabel}</strong> the default category for <strong>{payee.name}</strong>?
  </PayeeSavePrompt>
}
