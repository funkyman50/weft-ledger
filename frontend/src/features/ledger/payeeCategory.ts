import type { CategoryTree, Payee } from '../../api/types'

export function canAutofillPayeeCategory(categoryId: number | null, categoryProtected: boolean | undefined, categoryAutofilled: boolean | undefined): boolean {
  return Boolean(categoryAutofilled || !categoryProtected && categoryId === null)
}

export function payeeEntryCategory(payeeId: number | null, payees: Payee[], categories: CategoryTree[]): number | null {
  const payee = payees.find((item) => item.id === payeeId)
  if (!payee || payee.kind !== 'ordinary') return null
  const active = (id: number | null) => id !== null && categories.some((parent) => !parent.archived && parent.children.some((child) => child.id === id && !child.archived))
  return active(payee.default_category_id) ? payee.default_category_id : active(payee.remembered_category_id) ? payee.remembered_category_id : null
}

export function ledgerPayeeOption(payee: Payee) {
  return { id: payee.id, label: payee.name, editable: payee.kind === 'ordinary' }
}

export function ledgerPayeeOptions(payees: Payee[], selectedPayeeId: number | null) {
  return payees.filter((payee) => payee.kind === 'ordinary' || payee.kind === 'myself' || payee.id === selectedPayeeId).map(ledgerPayeeOption)
}
