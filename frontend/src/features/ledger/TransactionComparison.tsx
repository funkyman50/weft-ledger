import { useId, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import type { CategoryTree, ComparisonRowEdits, Payee } from '../../api/types'
import { FilterSelect } from '../../components/FilterSelect'

export function TransactionComparison({
  ariaLabel,
  leftHeading,
  rightHeading,
  children,
}: {
  ariaLabel: string
  leftHeading: ReactNode
  rightHeading: ReactNode
  children: ReactNode
}) {
  return <div className="bp-match-comparison" role="table" aria-label={ariaLabel}>
    <div className="bp-match-row bp-match-heading" role="row">
      <span className="bp-match-field-label" role="columnheader">Field</span>
      <span className="bp-match-selector" role="columnheader" aria-hidden="true" />
      <span className="bp-match-column-title" role="columnheader">{leftHeading}</span>
      <span className="bp-match-selector" role="columnheader" aria-hidden="true" />
      <span className="bp-match-column-title" role="columnheader">{rightHeading}</span>
    </div>
    {children}
  </div>
}

export function ComparisonReadOnlyRow({
  label,
  left,
  right,
  proposed = false,
  lockedTo,
}: {
  label: string
  left: ReactNode
  right: ReactNode
  proposed?: boolean
  lockedTo?: string
}) {
  return <div className={`bp-match-row bp-match-static-row${lockedTo ? ' bp-match-locked-row' : ''}${proposed ? ' is-proposed' : ''}`} role="row">
    <span className="bp-match-field-label" role="rowheader">{label}</span>
    <span className={`bp-match-selector${lockedTo ? ' bp-match-lock' : ''}`} role="cell" aria-label={lockedTo ? `${label} is ${lockedTo}` : undefined}>{lockedTo && <Lock aria-hidden="true" />}</span>
    <span className="bp-match-value" role="cell">{left}</span>
    <span className="bp-match-selector" role="cell" />
    <span className="bp-match-value" role="cell">{right}</span>
  </div>
}

type ComparisonChoice<T extends string> = { source: T; name: string; content: ReactNode }

export function ComparisonChoiceRow<T extends string>({
  label,
  left,
  right,
  selected,
  onChange,
  differs = left.content !== right.content,
  disabled = false,
  rightEditable = false,
}: {
  label: string
  left: ComparisonChoice<T>
  right: ComparisonChoice<T>
  selected: T | null
  onChange: (source: T) => void
  differs?: boolean
  disabled?: boolean
  rightEditable?: boolean
}) {
  const groupId = useId()
  const leftId = `${groupId}-left`
  const rightId = `${groupId}-right`
  return <div className={`bp-match-row bp-match-choice-row${differs ? ' is-different' : ''}`} role="row">
    <span className="bp-match-field-label" role="rowheader">{label}</span>
    <label className="bp-match-selector" role="cell" htmlFor={leftId}><input id={leftId} type="radio" name={groupId} aria-label={`Use ${left.name} ${label}`} checked={selected === left.source} disabled={disabled} onChange={() => onChange(left.source)} /></label>
    <label className="bp-match-value" role="cell" htmlFor={leftId}>{left.content}</label>
    <label className="bp-match-selector" role="cell" htmlFor={rightId}><input id={rightId} type="radio" name={groupId} aria-label={`Use ${right.name} ${label}`} checked={selected === right.source} disabled={disabled} onChange={() => onChange(right.source)} /></label>
    {rightEditable ? <span className="bp-match-value" role="cell">{right.content}</span> : <label className="bp-match-value" role="cell" htmlFor={rightId}>{right.content}</label>}
  </div>
}


export function ComparisonMetadataField({ field, label, value, payees, categories, disabled, onChange }: {
  field: keyof ComparisonRowEdits
  label: string
  value: string | number | null
  payees: Payee[]
  categories: CategoryTree[]
  disabled: boolean
  onChange: (edits: ComparisonRowEdits) => void
}) {
  if (field === 'memo') return <input className="bp-control bp-control--sm" aria-label={label} placeholder="Add memo" disabled={disabled} value={String(value ?? '')} onChange={(event) => onChange({ memo: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
  const options = field === 'payee_id'
    ? payees.filter((payee) => payee.kind === 'ordinary' || payee.kind === 'myself' || payee.id === value).map((payee) => ({ value: String(payee.id), label: payee.name, disabled: payee.kind !== 'ordinary' && payee.kind !== 'myself' }))
    : [{ value: '', label: 'No category' }, ...categories.flatMap((parent) => parent.children.map((child) => ({ value: String(child.id), label: `${parent.name}: ${child.name}`, disabled: parent.archived || child.archived }))) ]
  return <FilterSelect ariaLabel={label} searchable autoFocus={false} disabled={disabled} value={value === null ? '' : String(value)} options={options} onChange={(selected) => {
    if (field === 'payee_id') { if (selected) onChange({ payee_id: Number(selected) }) }
    else onChange({ category_id: selected ? Number(selected) : null })
  }} />
}
