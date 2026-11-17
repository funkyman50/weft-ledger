import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type {
  Account,
  CategoryTree,
  Payee,
  PayeeAmountCondition,
  PayeeRuleDraft,
  PayeeTextOperator,
} from '../../api/types'
import { Button } from '../../components/Button'
import { FilterSelect } from '../../components/FilterSelect'
import { parseLedgerAmount } from '../ledger/useLedgerEditor'
import { AMOUNT_OPERATORS, TEXT_OPERATORS, categoryResult } from './payeeRule'

type Field = 'description' | 'merchant' | 'account' | 'inflow' | 'outflow'
type Row = { kind: 'account' } | { kind: 'text'; index: number } | { kind: 'amount' }

const FIELDS: { value: Field; label: string }[] = [
  { value: 'description', label: 'Description' },
  { value: 'merchant', label: 'Merchant' },
  { value: 'account', label: 'Account' },
  { value: 'inflow', label: 'Inflow' },
  { value: 'outflow', label: 'Outflow' },
]

function rowField(draft: PayeeRuleDraft, row: Row): Field {
  if (row.kind === 'text') return draft.text_conditions[row.index].field
  if (row.kind === 'amount') return draft.amount!.direction
  return row.kind
}

function withoutRow(draft: PayeeRuleDraft, row: Row): PayeeRuleDraft {
  if (row.kind === 'account') return { ...draft, account_id: null }
  if (row.kind === 'amount') return { ...draft, amount: null }
  return { ...draft, text_conditions: draft.text_conditions.filter((_, index) => index !== row.index) }
}

function changeField(draft: PayeeRuleDraft, row: Row, field: Field, accounts: Account[]): PayeeRuleDraft {
  if (field === rowField(draft, row)) return draft
  if (row.kind === 'amount' && (field === 'inflow' || field === 'outflow'))
    return { ...draft, amount: { ...draft.amount!, direction: field } }
  if (row.kind === 'text' && (field === 'description' || field === 'merchant'))
    return {
      ...draft,
      text_conditions: draft.text_conditions.map((item, index) => (index === row.index ? { ...item, field } : item)),
    }
  const base = withoutRow(draft, row)
  if (field === 'account') return { ...base, account_id: accounts[0]?.id ?? null }
  if (field === 'inflow' || field === 'outflow')
    return { ...base, amount: { operator: 'eq', direction: field, value_cents: null, upper_cents: null } }
  return { ...base, text_conditions: [...base.text_conditions, { field, operator: 'contains', value: '' }] }
}

function categoryNote(draft: PayeeRuleDraft, payees: Payee[], categories: CategoryTree[]) {
  const payee = payees.find((item) => item.id === draft.payee_id)
  if (!payee) return 'Choose a payee to see its category default.'
  const fallback = categoryResult(categories, payee.default_category_id)
  const defaultLabel = payee.default_category_id !== null && !fallback.archived ? fallback.label : null
  if (draft.category_id === null)
    return defaultLabel
      ? `No category set. ${payee.name}’s default category (${defaultLabel}) applies.`
      : `No category set, and ${payee.name} has no default category.`
  const chosen = categoryResult(categories, draft.category_id)
  if (chosen.archived)
    return `${chosen.label} is archived. This rule still assigns ${payee.name}, and ${defaultLabel ? `the payee default (${defaultLabel})` : 'no category'} applies until you choose another category.`
  return `${chosen.label} replaces ${payee.name}’s default${defaultLabel ? ` (${defaultLabel})` : ''} for rows this rule decides.`
}

function AmountCells({
  value,
  disabled,
  onChange,
}: {
  value: PayeeAmountCondition
  disabled: boolean
  onChange: (value: PayeeAmountCondition) => void
}) {
  const [lower, setLower] = useState(value.value_cents === null ? '' : (value.value_cents / 100).toFixed(2))
  const [upper, setUpper] = useState(value.upper_cents === null ? '' : (value.upper_cents / 100).toFixed(2))
  const amount = (text: string) => {
    const cents = parseLedgerAmount(text)
    return cents !== null && cents >= 0 && Number.isSafeInteger(cents) ? cents : null
  }
  return (
    <>
      <FilterSelect
        autoFocus={false}
        ariaLabel="Amount operator"
        value={value.operator}
        options={AMOUNT_OPERATORS}
        disabled={disabled}
        onChange={(operator) =>
          onChange({
            ...value,
            operator: operator as PayeeAmountCondition['operator'],
            value_cents: operator === 'any' ? null : amount(lower),
            upper_cents: operator === 'between' ? amount(upper) : null,
          })
        }
      />
      {value.operator !== 'any' && <span className={`bp-condition-amount${value.operator === 'between' ? ' is-range' : ''}`}>
        <span className="bp-condition-currency">
          <span aria-hidden="true">$</span>
          <input
            className="bp-control"
            inputMode="decimal"
            aria-label={value.operator === 'between' ? 'Lower amount' : 'Rule amount'}
            placeholder="0.00"
            disabled={disabled}
            value={lower}
            onChange={(event) => {
              setLower(event.target.value)
              onChange({ ...value, value_cents: amount(event.target.value) })
            }}
          />
        </span>
        {value.operator === 'between' && (
          <>
            <span className="bp-condition-static">and</span>
            <span className="bp-condition-currency">
              <span aria-hidden="true">$</span>
              <input
                className="bp-control"
                inputMode="decimal"
                aria-label="Upper amount"
                placeholder="0.00"
                disabled={disabled}
                value={upper}
                onChange={(event) => {
                  setUpper(event.target.value)
                  onChange({ ...value, upper_cents: amount(event.target.value) })
                }}
              />
            </span>
          </>
        )}
      </span>}
    </>
  )
}

export function PayeeRuleEditor({
  draft,
  accounts,
  payees,
  categories,
  disabled,
  onChange,
}: {
  draft: PayeeRuleDraft
  accounts: Account[]
  payees: Payee[]
  categories: CategoryTree[]
  disabled: boolean
  onChange: (draft: PayeeRuleDraft) => void
}) {
  const categoryOptions = [
    { value: '', label: 'Payee default' },
    ...categories
      .filter((parent) => !parent.archived)
      .flatMap((parent) =>
        parent.children
          .filter((category) => !category.archived)
          .map((category) => ({ value: String(category.id), label: `${parent.name}: ${category.name}` })),
      ),
  ]
  const chosen = categoryResult(categories, draft.category_id)
  if (draft.category_id !== null && chosen.archived)
    categoryOptions.push({ value: String(draft.category_id), label: `${chosen.label} (unavailable)` })
  const rows: Row[] = [
    ...(draft.account_id !== null ? [{ kind: 'account' as const }] : []),
    ...draft.text_conditions.map((_, index) => ({ kind: 'text' as const, index })),
    ...(draft.amount ? [{ kind: 'amount' as const }] : []),
  ]
  return (
    <div className="bp-conditional-editor">
      {rows.map((row, position) => {
        const field = rowField(draft, row)
        const number = position + 1
        return (
          <div key={row.kind === 'text' ? `text-${row.index}` : row.kind} className={`bp-condition-row${row.kind === 'amount' ? ' is-amount' : ''}${row.kind === 'amount' && draft.amount?.operator === 'any' ? ' is-any-amount' : ''}`}>
            <span className="bp-condition-join">{position === 0 ? 'If' : 'And'}</span>
            <FilterSelect
              autoFocus={false}
              ariaLabel={`Condition ${number} field`}
              disabled={disabled}
              value={field}
              options={FIELDS.map((option) => ({
                ...option,
                disabled:
                  option.value !== field &&
                  ((option.value === 'account' && (draft.account_id !== null || !accounts.length)) ||
                    ((option.value === 'inflow' || option.value === 'outflow') && row.kind !== 'amount' && draft.amount !== null)),
              }))}
              onChange={(value) => onChange(changeField(draft, row, value as Field, accounts))}
            />
            {row.kind === 'account' && (
              <>
                <span className="bp-condition-static">is</span>
                <FilterSelect
                  autoFocus={false}
                  ariaLabel="Rule account"
                  disabled={disabled}
                  value={String(draft.account_id)}
                  options={accounts.map((account) => ({ value: String(account.id), label: account.name }))}
                  onChange={(value) => onChange({ ...draft, account_id: Number(value) })}
                />
              </>
            )}
            {row.kind === 'text' && (
              <>
                <FilterSelect
                  autoFocus={false}
                  ariaLabel={`Condition ${number} operator`}
                  disabled={disabled}
                  value={draft.text_conditions[row.index].operator}
                  options={TEXT_OPERATORS}
                  onChange={(value) =>
                    onChange({
                      ...draft,
                      text_conditions: draft.text_conditions.map((item, index) =>
                        index === row.index ? { ...item, operator: value as PayeeTextOperator } : item,
                      ),
                    })
                  }
                />
                <input
                  className="bp-control"
                  aria-label={`Condition ${number} text`}
                  maxLength={512}
                  disabled={disabled}
                  placeholder="Text to match"
                  value={draft.text_conditions[row.index].value}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      text_conditions: draft.text_conditions.map((item, index) =>
                        index === row.index ? { ...item, value: event.target.value } : item,
                      ),
                    })
                  }
                />
              </>
            )}
            {row.kind === 'amount' && draft.amount && (
              <AmountCells value={draft.amount} disabled={disabled} onChange={(amount) => onChange({ ...draft, amount })} />
            )}
            <Button
              size="sm"
              variant="quiet"
              iconOnly
              aria-label={`Remove condition ${number}`}
              disabled={disabled}
              onClick={() => onChange(withoutRow(draft, row))}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        )
      })}
      <div className="bp-condition-indent">
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...draft,
              text_conditions: [...draft.text_conditions, { field: 'description', operator: 'contains', value: '' }],
            })
          }
        >
          <Plus aria-hidden="true" />
          Add condition
        </Button>
      </div>
      <div className="bp-condition-divider" />
      <div className="bp-condition-row is-result">
        <span className="bp-condition-join is-then">Then</span>
        <span className="bp-condition-label">Assign Payee</span>
        <FilterSelect
          autoFocus={false}
          searchable
          ariaLabel="Rule payee"
          disabled={disabled}
          value={draft.payee_id === null ? '' : String(draft.payee_id)}
          options={[
            { value: '', label: 'Choose payee' },
            ...payees.filter((payee) => payee.kind === 'ordinary' || payee.kind === 'myself').map((payee) => ({ value: String(payee.id), label: payee.name })),
          ]}
          onChange={(value) => onChange({ ...draft, payee_id: value ? Number(value) : null })}
        />
      </div>
      <div className="bp-condition-row is-result">
        <span className="bp-condition-join is-then">And</span>
        <span className="bp-condition-label">Set category</span>
        <FilterSelect
          autoFocus={false}
          searchable
          ariaLabel="Rule category"
          disabled={disabled}
          value={draft.category_id === null ? '' : String(draft.category_id)}
          options={categoryOptions}
          onChange={(value) => onChange({ ...draft, category_id: value ? Number(value) : null })}
        />
      </div>
      <p className="bp-field-hint bp-condition-indent">{categoryNote(draft, payees, categories)}</p>
    </div>
  )
}
