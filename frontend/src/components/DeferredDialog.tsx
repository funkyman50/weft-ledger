import { useEffect, useId, useState, type ComponentType } from 'react'
import { DialogHeader } from './DialogHeader'
import { Button } from './Button'
import { Modal } from './Modal'

export function deferDialog<Props extends { onClose: () => void }>(
  load: () => Promise<ComponentType<Props>>,
  title: string,
  placement?: 'center' | 'corner',
) {
  let loaded: ComponentType<Props> | null = null

  return function DeferredDialog(props: Props) {
    const [Dialog, setDialog] = useState(() => loaded)
    const [failed, setFailed] = useState(false)
    const titleId = useId()

    useEffect(() => {
      if (Dialog) return
      let active = true
      load().then((component) => {
        loaded = component
        if (active) setDialog(() => component)
      }, () => {
        if (active) setFailed(true)
      })
      return () => { active = false }
    }, [Dialog])

    if (Dialog) return <Dialog {...props} />

    return <Modal size="sm" placement={placement} labelledBy={titleId} loading={!failed} onRequestClose={props.onClose}>
      <DialogHeader titleId={titleId} title={title} onClose={props.onClose} />
      <div className="bp-dialog-body">
        <p className="bp-dialog-copy" role={failed ? 'alert' : 'status'}>{failed
          ? 'This window could not load. Close it, finish or copy any unsaved work, then reload the app. If it still will not open, reopen the app in a new tab.'
          : 'Loading…'}</p>
      </div>
      <div className="bp-dialog-footer">
        <Button size="lg" onClick={props.onClose}>Close</Button>
      </div>
    </Modal>
  }
}
