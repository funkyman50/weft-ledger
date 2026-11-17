export function Switch({ label, checked, disabled = false, showLabel = false, onChange }: {
  label: string
  checked: boolean
  disabled?: boolean
  showLabel?: boolean
  onChange: (checked: boolean) => void
}) {
  return <label className="bp-switch-label" data-disabled={disabled || undefined}>
    {showLabel && <span>{label}</span>}
    <span className="bp-switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true" />
    </span>
  </label>
}
