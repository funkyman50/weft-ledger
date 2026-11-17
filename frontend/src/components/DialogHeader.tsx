import type { ReactNode, Ref } from 'react'
import { X } from 'lucide-react'
import { Button } from './Button'

export function DialogHeader({ titleId, title, titleRef, subtitle, onClose, closeDisabled = false, actions, className }: {
  titleId: string
  title: ReactNode
  titleRef?: Ref<HTMLHeadingElement>
  subtitle?: ReactNode
  onClose: () => void
  closeDisabled?: boolean
  actions?: ReactNode
  className?: string
}) {
  return <div className={`bp-dialog-header${className ? ` ${className}` : ''}`}>
    <div className="bp-dialog-heading">
      <h2 ref={titleRef} tabIndex={titleRef ? -1 : undefined} id={titleId} className="bp-dialog-title">{title}</h2>
      {subtitle && <p className="bp-dialog-subtitle">{subtitle}</p>}
    </div>
    <div className="bp-dialog-header-actions">
      {actions}
      <Button size="lg" variant="quiet" iconOnly aria-label="Close" disabled={closeDisabled} onClick={onClose}><X aria-hidden="true" /></Button>
    </div>
  </div>
}
