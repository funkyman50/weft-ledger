import { useRef } from 'react'
import { Check, Columns3Cog } from 'lucide-react'
import { ActionMenu, ActionMenuItem } from '../../components/ActionMenu'
import { Button } from '../../components/Button'

export type LedgerColumnsChange =
  | { kind: 'transfer'; enabled: boolean }
  | { kind: 'description'; enabled: boolean }
  | { kind: 'balance'; enabled: boolean }
  | { kind: 'separateAmounts'; enabled: boolean }

export function LedgerColumnsMenu({ open, onOpenChange, showTransferColumn, showBankDescription, showRunningBalance, separateAmountColumns, balanceAvailable, descriptionFilterHidden, onChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  showTransferColumn: boolean
  showBankDescription: boolean
  showRunningBalance: boolean
  separateAmountColumns: boolean
  balanceAvailable: boolean
  descriptionFilterHidden: boolean
  onChange: (change: LedgerColumnsChange) => void
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const label = `Columns${descriptionFilterHidden ? '; Description filter active' : ''}`
  const item = (role: 'menuitemcheckbox' | 'menuitemradio', checked: boolean, text: string, change: LedgerColumnsChange, options: { disabled?: string; note?: string } = {}) => (
    <ActionMenuItem role={role} aria-checked={checked} disabled={Boolean(options.disabled)} title={options.disabled} onClick={() => onChange(change)}>
      <span className={`bp-columns-menu-control is-${role === 'menuitemradio' ? 'radio' : 'checkbox'}${checked ? ' is-checked' : ''}`} aria-hidden="true">{checked && role === 'menuitemcheckbox' && <Check />}</span>
      {text}
      {options.note && <small className="bp-columns-menu-note">{options.note}</small>}
    </ActionMenuItem>
  )
  return <>
    <span ref={anchorRef} className="bp-columns-anchor"><Button ref={buttonRef} className={`bp-columns-button${descriptionFilterHidden ? ' has-hint' : ''}`} size="sm" variant="quiet" iconOnly aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <Columns3Cog aria-hidden="true" />
    </Button></span>
    {open && <ActionMenu className="bp-columns-menu" anchorRef={anchorRef} menuRef={menuRef} width={184} align="end" aria-label="Columns" onDismiss={(reason) => {
      onOpenChange(false)
      if (reason === 'escape') buttonRef.current?.focus({ preventScroll: true })
    }}>
      <div className="bp-columns-menu-group" role="group" aria-label="Show columns">
        <span className="bp-columns-menu-heading" aria-hidden="true">Show columns</span>
        {item('menuitemcheckbox', showTransferColumn, 'Transfer', { kind: 'transfer', enabled: !showTransferColumn })}
        {item('menuitemcheckbox', showBankDescription, 'Bank description', { kind: 'description', enabled: !showBankDescription }, { note: descriptionFilterHidden ? 'filter active' : undefined })}
        {item('menuitemcheckbox', balanceAvailable && showRunningBalance, 'Balance', { kind: 'balance', enabled: !showRunningBalance }, { disabled: balanceAvailable ? undefined : 'Balance shows only in individual account views.' })}
      </div>
      <div role="separator" />
      <div className="bp-columns-menu-group" role="group" aria-label="Amount">
        <span className="bp-columns-menu-heading" aria-hidden="true">Amount</span>
        {item('menuitemradio', !separateAmountColumns, 'One signed Amount', { kind: 'separateAmounts', enabled: false })}
        {item('menuitemradio', separateAmountColumns, 'Separate Outflow / Inflow', { kind: 'separateAmounts', enabled: true })}
      </div>
    </ActionMenu>}
  </>
}
