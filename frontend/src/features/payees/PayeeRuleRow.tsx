import { ArrowDown, ArrowUp, ArrowUpRight, Info, Pencil } from 'lucide-react'
import type { Account, CategoryTree, Payee, PayeeRule, PayeeRuleDraft } from '../../api/types'
import { Button } from '../../components/Button'
import { HelpTooltip } from '../../components/HelpTooltip'
import { money } from '../../lib/money'

import { AMOUNT_OPERATORS, TEXT_OPERATORS, categoryResult } from './payeeRule'

function amountText(amount: NonNullable<PayeeRuleDraft['amount']>) {
  const value = (cents: number | null) => (cents === null ? '…' : money(cents))
  const range =
    amount.operator === 'any'
      ? ''
      : amount.operator === 'between'
        ? `${value(amount.value_cents)} and ${value(amount.upper_cents)}`
        : value(amount.value_cents)
  return { range, direction: amount.direction, comparison: AMOUNT_OPERATORS.find((item) => item.value === amount.operator)?.label }
}

export function RuleConditions({ rule, accounts }: { rule: PayeeRuleDraft; accounts: Account[] }) {
  const amount = rule.amount ? amountText(rule.amount) : null
  return (
    <span className="bp-rule-conditions">
      {rule.account_id !== null && (
        <span className="bp-rule-condition is-account">
          <i>in</i>
          {accounts.find((item) => item.id === rule.account_id)?.name ?? 'Unavailable account'}
        </span>
      )}
      {rule.text_conditions.map((condition, index) => (
        <span
          key={index}
          className={`bp-rule-condition${condition.operator === 'not_contains' ? ' is-negative' : ''}`}
        >
          <i>
            {condition.field} {TEXT_OPERATORS.find((item) => item.value === condition.operator)?.label}
          </i>
          {condition.value}
        </span>
      ))}
      {amount && (
        <span className="bp-rule-condition">
          <i>{amount.direction} {amount.comparison}</i>
          {amount.range}
        </span>
      )}
    </span>
  )
}

function RuleExplanation({ label, tone }: { label: string; tone: 'amber' | 'muted' }) {
  return <HelpTooltip as="button" className={`bp-rule-info${tone === 'muted' ? ' bp-rule-info--muted' : ''}`} explanation={label}><Info aria-hidden="true" /></HelpTooltip>
}

export function PayeeRuleRow({
  rule,
  accounts,
  payees,
  categories,
  showPayee = true,
  selected = false,
  disabled = false,
  moveDisabled = false,
  first = false,
  last = false,
  mark = null,
  edit = 'link',
  onSelect,
  onEdit,
  onMove,
}: {
  rule: PayeeRule
  accounts: Account[]
  payees: Payee[]
  categories: CategoryTree[]
  showPayee?: boolean
  selected?: boolean
  disabled?: boolean
  moveDisabled?: boolean
  first?: boolean
  last?: boolean
  mark?: 'decides' | 'matches' | 'dim' | null
  edit?: 'link' | 'pencil'
  onSelect?: () => void
  onEdit?: () => void
  onMove?: (direction: 'up' | 'down') => void
}) {
  const category = categoryResult(categories, rule.category_id)
  const name = payees.find((payee) => payee.id === rule.payee_id)?.name ?? 'Unavailable payee'
  const notReached = rule.matching_count !== null && rule.matching_count > 0 && rule.deciding_count === 0
  const content = (
    <>
      <span className="bp-rule-number">{rule.position}</span>
      <span className="bp-rule-summary">
        <RuleConditions rule={rule} accounts={accounts} />
        {(showPayee || rule.category_id !== null || notReached || mark === 'decides' || mark === 'matches') && (
          <span className="bp-rule-results">
            {showPayee && (
              <span className="bp-rule-result">
                <i>Payee</i> → <strong>{name}</strong>
              </span>
            )}
            {rule.category_id !== null && (
              <span className={`bp-rule-result is-category${category.archived ? ' is-unavailable' : ''}`}>
                <i>Category</i> → <span>{category.label}</span>
              </span>
            )}
            {notReached && <span className="bp-rule-not-reached">Not reached</span>}
            {mark === 'decides' && <span className="bp-rule-mark is-decides">Decides</span>}
            {mark === 'matches' && <span className="bp-rule-mark is-matches">Also matches</span>}
          </span>
        )}
      </span>
    </>
  )
  return (
    <div className={`bp-rule-row${selected ? ' is-selected' : ''}${mark === 'dim' ? ' is-dim' : ''}`}>
      {onSelect ? (
        <button
          type="button"
          className="bp-rule-selector"
          aria-pressed={selected}
          disabled={disabled}
          onClick={onSelect}
        >
          {content}
        </button>
      ) : (
        <div className="bp-rule-selector">{content}</div>
      )}
      {category.archived && (
        <RuleExplanation
          tone="amber"
          label="This category is archived. The rule still assigns its payee, and the payee’s active default category applies when it has one."
        />
      )}
      {notReached && (
        <RuleExplanation
          tone="muted"
          label="Earlier rules decide every matching row in current history. This does not predict future imports."
        />
      )}
      {onEdit && edit === 'pencil' && (
        <Button
          size="sm"
          variant="quiet"
          iconOnly
          aria-label={`Edit rule ${rule.position}`}
          title="Edit rule"
          disabled={disabled}
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" />
        </Button>
      )}
      {onEdit && edit === 'link' && (
        <Button size="sm" variant="quiet" disabled={disabled} onClick={onEdit}>
          Edit
          <ArrowUpRight aria-hidden="true" />
        </Button>
      )}
      {onMove && (
        <span className="bp-rule-moves">
          <Button
            size="sm"
            variant="quiet"
            iconOnly
            aria-label={`Move rule ${rule.position} up`}
            data-rule-move={`${rule.id}-up`}
            disabled={disabled || moveDisabled || first}
            onClick={() => onMove?.('up')}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            variant="quiet"
            iconOnly
            aria-label={`Move rule ${rule.position} down`}
            data-rule-move={`${rule.id}-down`}
            disabled={disabled || moveDisabled || last}
            onClick={() => onMove?.('down')}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
        </span>
      )}
    </div>
  )
}
