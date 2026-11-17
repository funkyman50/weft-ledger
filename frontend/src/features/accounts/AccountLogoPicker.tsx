import { useEffect, useRef, useState, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Trash2, Upload } from 'lucide-react'
import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import { useAccountLogos } from '../../api/hooks'
import type { Account, AccountLogo, IconImportResult } from '../../api/types'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { Modal } from '../../components/Modal'
import { isComposingKey } from '../../lib/keyboard'
import { AccountIcon } from './AccountIcon'
import { accountLogoUrl, MAX_ICON_FILE_BYTES } from './accountLogos'

function searchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function readImage(file: File): Promise<{ name: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] })
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.readAsDataURL(file)
  })
}

export function AccountLogoPicker({ account, selectedId, returnFocusRef, onSelect, onRemoved, onClose }: {
  account: Pick<Account, 'name' | 'type' | 'plaid_connection' | 'logo_id'>
  selectedId: string | null
  returnFocusRef: RefObject<HTMLButtonElement | null>
  onSelect: (id: string | null) => void
  onRemoved: (id: string) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [progress, setProgress] = useState<{ completed: number; total: number; stopping: boolean; issues: number } | null>(null)
  const stopRequested = useRef(false)
  const previousImporting = useRef(false)
  const stopButtonRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<{ name: string; message: string }[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AccountLogo | null>(null)
  const [renaming, setRenaming] = useState<{ logo: AccountLogo; name: string } | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const renameReturnId = useRef<string | null>(null)
  const gridRef = useRef<HTMLUListElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const removeCancelRef = useRef<HTMLButtonElement>(null)
  const queryClient = useQueryClient()
  const logos = useAccountLogos()
  const removeIcon = useMutation({ mutationFn: (id: string) => apiClient.delete<AccountLogo[]>(`/api/account-logos/${encodeURIComponent(id)}`) })
  const renameIcon = useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => apiClient.patch<AccountLogo[]>(`/api/account-logos/${encodeURIComponent(id)}`, { name }) })
  const importing = progress !== null
  const busy = importing || removeIcon.isPending || renameIcon.isPending
  const managing = Boolean(removing || renaming)
  const query = searchText(search)
  const matches = (logos.data ?? []).filter((logo) => logo.id === renaming?.logo.id || searchText(logo.name).includes(query))
  const close = () => { if (busy) return; if (renaming) renameRef.current?.focus(); else onClose() }

  useEffect(() => {
    if (removing) removeCancelRef.current?.focus()
  }, [removing])

  const renamingId = renaming?.logo.id
  useEffect(() => {
    if (renamingId) { renameRef.current?.focus(); renameRef.current?.select() }
  }, [renamingId])

  useEffect(() => {
    if (renamingId || busy) return
    const returnId = renameReturnId.current
    renameReturnId.current = null
    if (returnId && document.activeElement === document.body) {
      const target = gridRef.current?.querySelector<HTMLButtonElement>(`[data-logo-rename="${CSS.escape(returnId)}"]`) ?? searchRef.current
      target?.focus()
    }
  }, [renamingId, busy])

  useEffect(() => {
    if (previousImporting.current === importing) return
    previousImporting.current = importing
    if (importing) stopButtonRef.current?.focus()
    else if (!error) searchRef.current?.focus()
  }, [importing, error])

  async function importFiles(files: File[]) {
    if (!files.length) return
    setError(null)
    setNotice(null)
    setResults([])
    setSearch('')
    stopRequested.current = false
    setProgress({ completed: 0, total: files.length, stopping: false, issues: 0 })
    const issues: { name: string; message: string }[] = []
    let completed = 0
    let imported = 0
    let reused = 0
    let singleSelection: string | null = null
    let interrupted = false
    const record = (name: string, message?: string) => {
      completed += 1
      if (message) issues.push({ name, message })
      setProgress((current) => current && { ...current, completed, issues: issues.length })
    }
    try {
      for (const file of files) {
        if (stopRequested.current) break
        if (file.size > MAX_ICON_FILE_BYTES) {
          record(file.name, 'This image is too large to process. Try a smaller copy.')
          continue
        }
        let payload: { name: string; data: string }
        try {
          payload = await readImage(file)
        } catch {
          record(file.name, 'This file could not be read. Choose it again.')
          continue
        }
        try {
          const result = await apiClient.post<IconImportResult>('/api/account-logos', payload)
          if (result.reused) reused += 1
          else imported += 1
          record(file.name)
          if (files.length === 1) singleSelection = result.logo.id
        } catch (caught) {
          if (caught instanceof ApiError && (caught.code === 'account_logo_invalid' || caught.code === 'account_logo_upload_too_large')) {
            record(file.name, caught.message)
            continue
          }
          interrupted = true
          issues.push({ name: file.name, message: 'Check this file’s save result before trying again.' })
          setError(apiErrorMessage(caught, 'Could not confirm the icon save. Inspect the result before trying again.'))
          break
        }
      }
      const unstarted = files.length - completed - (interrupted ? 1 : 0)
      const summary = `${completed} processed: ${imported} imported, ${reused} already in library, ${completed - imported - reused} rejected.`
      setNotice(interrupted || stopRequested.current
        ? `Import stopped. ${summary} ${unstarted} later ${unstarted === 1 ? 'file was' : 'files were'} not started. Saved icons remain in your library.`
        : summary)
    } finally {
      setResults(issues)
      await logos.refetch()
      setProgress(null)
    }
    if (singleSelection && !stopRequested.current && !interrupted) onSelect(singleSelection)
  }

  function stopImport() {
    stopRequested.current = true
    setProgress((current) => current && { ...current, stopping: true })
  }

  async function confirmRemoval() {
    if (!removing) return
    setError(null)
    try {
      const remaining = await removeIcon.mutateAsync(removing.id)
      queryClient.setQueryData(['account-logos'], remaining)
      onRemoved(removing.id)
      setRemoving(null)
      searchRef.current?.focus()
    } catch (caught) {
      setError(apiErrorMessage(caught, 'Could not remove this icon.'))
      setRemoving(null)
      searchRef.current?.focus()
      void logos.refetch()
    }
  }

  async function saveName(retry = false) {
    if (!renaming || renameIcon.isPending) return
    const name = renaming.name.trim()
    if (!name || name === renaming.logo.name) { setRenaming(null); return }
    if (renameIcon.isError && !retry) return
    setError(null)
    try {
      const updated = await renameIcon.mutateAsync({ id: renaming.logo.id, name })
      queryClient.setQueryData(['account-logos'], updated)
    } catch (caught) {
      setError(apiErrorMessage(caught, 'Could not rename this icon.'))
      void logos.refetch()
      return
    }
    setRenaming(null)
  }

  return <Modal size="sm" className="bp-logo-picker" labelledBy="account-logo-title" initialFocusRef={searchRef} returnFocusRef={returnFocusRef} onRequestClose={close}>
    <DialogHeader titleId="account-logo-title" title="Choose an account logo" subtitle="Use an automatic initial or an icon from your library." closeDisabled={busy} onClose={close} />
    <div className="bp-logo-picker-search">
      <button type="button" className="bp-logo-automatic" aria-pressed={selectedId === null} disabled={busy || managing} onClick={() => onSelect(null)}>
        <AccountIcon account={{ ...account, logo_id: null }} /><span><strong>Automatic</strong><small>Institution or account initial</small></span>{selectedId === null && <Check aria-hidden="true" />}
      </button>
      <label className="bp-field">Search icons<input ref={searchRef} className="bp-control" type="search" placeholder="Search your library" value={search} disabled={importing} onChange={(event) => setSearch(event.target.value)} /></label>
      <p className="bp-note" role="status">{matches.length} {matches.length === 1 ? 'icon' : 'icons'}</p>
    </div>
    <div className="bp-dialog-body">
      {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
      {logos.isError && <div className="bp-callout bp-callout--error" role="alert">Could not load your icon library. <Button size="sm" disabled={busy || logos.isFetching} onClick={() => void logos.refetch()}>Retry</Button></div>}
      {notice && <p className="bp-note" role="status">{notice}</p>}
      {results.length > 0 && <ul className="bp-logo-import-results" aria-label="Import issues">{results.map((result, index) => <li key={index}>{result.name}: {result.message}</li>)}</ul>}
      {removing && <div className="bp-callout bp-callout--warning">
        <p>Remove “{removing.name}” from your library?</p>
        <div className="bp-callout-actions"><Button ref={removeCancelRef} size="sm" disabled={busy} onClick={() => { setRemoving(null); searchRef.current?.focus() }}>Keep icon</Button><Button size="sm" variant="danger" busy={removeIcon.isPending} disabled={busy} onClick={() => void confirmRemoval()}>Remove icon</Button></div>
      </div>}
      {logos.isPending ? <p className="bp-note" role="status">Loading icons…</p> : matches.length ? <ul ref={gridRef} className="bp-logo-grid">
        {matches.map((logo) => <li key={logo.id}>
          {renaming?.logo.id === logo.id
            ? <div className={`bp-logo-option is-renaming${selectedId === logo.id ? ' is-selected' : ''}`}>
              <img src={accountLogoUrl(logo.id)} alt="" width={56} height={56} draggable={false} />
              <input ref={renameRef} className="bp-control bp-logo-name-input" aria-label={`Name for ${logo.name}`} value={renaming.name} maxLength={80} readOnly={renameIcon.isPending} onChange={(event) => { renameIcon.reset(); setRenaming({ ...renaming, name: event.target.value }) }} onBlur={() => void saveName()} onKeyDown={(event) => {
                if (isComposingKey(event.nativeEvent)) return
                if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) { renameReturnId.current = logo.id; void saveName(true) } }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!renameIcon.isPending) { renameReturnId.current = logo.id; renameIcon.reset(); setRenaming(null) } }
              }} />
              {selectedId === logo.id && <Check className="bp-logo-option-check" aria-hidden="true" />}
            </div>
            : <button type="button" className={`bp-logo-option${selectedId === logo.id ? ' is-selected' : ''}`} title={logo.name} aria-pressed={selectedId === logo.id} disabled={busy || managing} onClick={() => onSelect(logo.id)}>
              <img src={accountLogoUrl(logo.id)} alt="" loading="lazy" width={56} height={56} draggable={false} />
              <span>{logo.name}</span>
              {selectedId === logo.id && <Check className="bp-logo-option-check" aria-hidden="true" />}
            </button>}
          <span className="bp-logo-tools">
            <Button size="sm" variant="quiet" iconOnly data-logo-rename={logo.id} aria-label={`Rename ${logo.name}`} title="Rename" disabled={busy || managing} onClick={() => { setError(null); renameIcon.reset(); setRenaming({ logo, name: logo.name }) }}><Pencil aria-hidden="true" /></Button>
            {!logo.use_count && <Button size="sm" variant="quiet" iconOnly className="bp-logo-delete" aria-label={`Remove ${logo.name}`} title="Remove from library" disabled={busy || managing} onClick={() => setRemoving(logo)}><Trash2 aria-hidden="true" /></Button>}
          </span>
        </li>)}
      </ul> : !logos.isError && <p className="bp-logo-empty">{search ? `No icons match “${search}”.` : 'Your library is empty. Import icons to use them on any account.'}</p>}
    </div>
    <div className="bp-logo-import">
      <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple tabIndex={-1} disabled={busy} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files) }} />
      <Button size="md" busy={importing} disabled={busy || managing} onClick={() => fileRef.current?.click()}><Upload aria-hidden="true" />{importing ? 'Working…' : 'Import icons'}</Button>
      {progress && <div className="bp-logo-progress">
        <p className="bp-note" role="status">{progress.stopping ? 'Finishing the current file…' : `Processed ${progress.completed} of ${progress.total} · ${progress.issues} ${progress.issues === 1 ? 'issue' : 'issues'}`}</p>
        <progress aria-label="Icon import progress" value={progress.completed} max={progress.total} />
        <Button ref={stopButtonRef} size="md" disabled={progress.stopping || progress.completed === progress.total} onClick={stopImport}>{progress.stopping ? 'Stopping…' : 'Stop import'}</Button>
      </div>}
      <p className="bp-note">PNG, JPEG or WebP · Up to 4 megapixels per image.</p>
      <p className="bp-note">Imports and saved name changes stay in your library even if you cancel.</p>
    </div>
    <div className="bp-dialog-footer">
      <div className="bp-dialog-footer-start"><Button size="lg" disabled={busy || managing} onClick={() => onSelect(null)}>Use default</Button></div>
      <Button size="lg" disabled={busy} onClick={close}>Cancel</Button>
    </div>
  </Modal>
}
