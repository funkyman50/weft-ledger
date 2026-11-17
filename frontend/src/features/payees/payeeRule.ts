import type { CategoryTree, PayeeRuleDraft } from '../../api/types'

export const TEXT_OPERATORS = [
  { value: 'is', label: 'is' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'regex', label: 'matches regex' },
]
export const AMOUNT_OPERATORS = [
  { value: 'any', label: 'is any amount' },
  { value: 'eq', label: 'is exactly' },
  { value: 'gt', label: 'is more than' },
  { value: 'gte', label: 'is at least' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'between', label: 'is between' },
]

export function categoryResult(categories: CategoryTree[], id: number | null) {
  const parent = categories.find((item) => item.children.some((child) => child.id === id))
  const category = parent?.children.find((item) => item.id === id)
  return {
    label: category && parent ? `${parent.name}: ${category.name}` : 'Uncategorized',
    archived: Boolean(parent?.archived || category?.archived),
  }
}

export function ruleReady(rule: PayeeRuleDraft | null) {
  if (
    !rule ||
    rule.payee_id === null ||
    (rule.account_id === null && rule.amount === null && !rule.text_conditions.length)
  )
    return false
  if (rule.text_conditions.some((condition) => !condition.value.trim())) return false
  if (rule.amount) {
    const amount = rule.amount
    if (amount.operator === 'any') return true
    if (amount.value_cents === null || amount.value_cents < 0 || !Number.isSafeInteger(amount.value_cents))
      return false
    if (
      amount.operator === 'between' &&
      (amount.upper_cents === null ||
        amount.upper_cents < amount.value_cents ||
        !Number.isSafeInteger(amount.upper_cents))
    )
      return false
  }
  return true
}
