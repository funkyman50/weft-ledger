import type { EditableField, LedgerRow } from '../../api/types'

export function rowStateAction(row: Pick<LedgerRow, 'allowed_actions' | 'approved'>): 'review' | 'clearance' | null {
  const review = row.allowed_actions.includes('review')
  if (review && !row.approved) return 'review'
  if (row.allowed_actions.includes('clearance')) return 'clearance'
  return review ? 'review' : null
}

export function canEditField(row: LedgerRow, field: EditableField): boolean {
  return row.allowed_actions.includes('edit') && row.editable_fields.includes(field)
}

export function matchReviewMode(row: LedgerRow): 'linked' | 'suggested' | null {
  if (row.match?.state === 'matched' && row.allowed_actions.includes('inspect_connections')) return 'linked'
  return row.match?.state === 'suggested' && row.allowed_actions.includes('dismiss_match') ? 'suggested' : null
}
