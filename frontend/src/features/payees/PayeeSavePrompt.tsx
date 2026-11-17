import { useRef, type ReactNode, type RefObject } from 'react'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { Modal } from '../../components/Modal'

export function PayeeGuard({ title, titleId, subtitle, children, footer, closeDisabled = false, onClose, initialFocusRef, role = 'dialog' }: {
  title: string
  titleId: string
  subtitle: ReactNode
  children: ReactNode
  footer: ReactNode
  closeDisabled?: boolean
  onClose: () => void
  initialFocusRef?: RefObject<HTMLElement | null>
  role?: 'dialog' | 'alertdialog'
}) {
  return <Modal size="sm" role={role} labelledBy={titleId} initialFocusRef={initialFocusRef} onRequestClose={() => { if (!closeDisabled) onClose() }}>
    <DialogHeader titleId={titleId} title={title} subtitle={subtitle} closeDisabled={closeDisabled} onClose={onClose} />
    <div className="bp-dialog-body">{children}</div>
    <div className="bp-dialog-footer">{footer}</div>
  </Modal>
}

export function PayeeSavePrompt({ title, titleId, subtitle, children, saveLabel, updateLabel, updateDisabled = false, savingAction = null, disabled = false, onCancel, onSave, onUpdate, recovery }: {
  title: string
  titleId: string
  subtitle: ReactNode
  children: ReactNode
  saveLabel: string
  updateLabel: string
  updateDisabled?: boolean
  savingAction?: 'default' | 'history' | null
  disabled?: boolean
  onCancel: () => void
  onSave: () => void
  onUpdate: () => void
  recovery?: ReactNode
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const locked = savingAction !== null || disabled
  return <PayeeGuard
    title={title}
    titleId={titleId}
    subtitle={subtitle}
    initialFocusRef={cancelRef}
    closeDisabled={locked}
    onClose={onCancel}
    footer={<>
      <Button ref={cancelRef} size="lg" disabled={locked} onClick={onCancel}>Cancel</Button>
      <Button size="lg" busy={savingAction === 'default'} disabled={locked} onClick={onSave}>{savingAction === 'default' ? 'Saving…' : saveLabel}</Button>
      <Button size="lg" variant="primary" busy={savingAction === 'history'} disabled={locked || updateDisabled} onClick={onUpdate}>{savingAction === 'history' ? 'Saving…' : updateLabel}</Button>
    </>}
  >
    <p className="bp-dialog-copy">{children}</p>
    {recovery}
  </PayeeGuard>
}
