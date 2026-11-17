import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { MoreVertical, Plus, Search } from 'lucide-react'
import { apiErrorMessage } from '../../api/client'
import { Button } from '../../components/Button'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import {
  useCategories,
  useCreateCategory,
  useDeleteCategory,
  useUpdateCategory,
} from '../../api/hooks'
import type { Category } from '../../api/types'
import { isComposingKey } from '../../lib/keyboard'
import { ActionMenu, ActionMenuItem } from '../../components/ActionMenu'
import { DialogHeader } from '../../components/DialogHeader'
import {
  activeChildCount,
  categoryBranches,
  deleteDestinations,
  effectiveArchived,
  highlightedSegments,
  moveDestinations,
  presentationChildren,
  type CategoryBranch,
} from './categoryAdmin'
import { matchesSearch, searchQuery } from '../../lib/search'

type Draft =
  | { kind: 'parent'; value: string }
  | { kind: 'child'; parentId: number; value: string }
  | { kind: 'rename'; category: Category; value: string }

type Panel =
  | { kind: 'delete'; category: Category; destinationId?: number | null }
  | { kind: 'move'; category: Category; destinationId?: number }

const spendingClassifications = [
  { label: 'Discretionary', value: true },
  { label: 'Non-discretionary', value: false },
  { label: 'Not applicable', value: null },
]

function HighlightedName({ name, query }: { name: string; query: string }) {
  return <>{highlightedSegments(name, query).map((segment, index) => (
    segment.match ? <span className="bp-mark" key={index}>{segment.text}</span> : <span key={index}>{segment.text}</span>
  ))}</>
}

function CategoryRowMenu({
  label,
  disabled,
  items,
}: {
  label: string
  disabled: boolean
  items: Array<{ label: string; danger?: boolean; separated?: boolean; onSelect: () => void }>
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  return <>
    <Button
      ref={triggerRef}
      className={`bp-row-menu-trigger${open ? ' is-open' : ''}`}
      size="sm"
      variant="quiet"
      iconOnly
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
    ><MoreVertical aria-hidden="true" /></Button>
    {open && <ActionMenu anchorRef={triggerRef} menuRef={menuRef} aria-label={label} data-category-menu onDismiss={(reason) => {
      setOpen(false)
      if (reason !== 'outside') triggerRef.current?.focus({ preventScroll: true })
    }}>
      {items.map((item) => <Fragment key={item.label}>
        {item.separated && <div role="separator" />}
        <ActionMenuItem danger={item.danger} onClick={() => { setOpen(false); item.onSelect() }}>{item.label}</ActionMenuItem>
      </Fragment>)}
    </ActionMenu>}
  </>
}

function DestinationSelect({
  destinationId,
  options,
  pending,
  onChange,
}: {
  destinationId: number | null | undefined
  options: Array<{ id: number; label: string }>
  pending: boolean
  onChange: (value: number | null | undefined) => void
}) {
  const value = destinationId === undefined ? '' : destinationId === null ? '__uncategorized__' : String(destinationId)
  return <FilterSelect ariaLabel="Destination category" searchable autoFocus={false} value={value} disabled={pending} options={[
    { value: '', label: 'Choose a destination' },
    ...options.map((option) => ({ value: String(option.id), label: option.label })),
    { value: '__uncategorized__', label: 'Uncategorized' },
  ]} onChange={(selected) => {
    if (selected === '') onChange(undefined)
    else if (selected === '__uncategorized__') onChange(null)
    else onChange(Number(selected))
  }} />
}

export function CategoryManagerDialog({ onClose }: { onClose: () => void }) {
  const { data: categories = [], isLoading } = useCategories()
  const create = useCreateCategory()
  const update = useUpdateCategory()
  const remove = useDeleteCategory()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const draftRef = useRef<HTMLInputElement>(null)
  const committingDraftRef = useRef(false)

  const pending = create.isPending || update.isPending || remove.isPending
  const normalizedQuery = searchQuery(query)
  const branches = useMemo(() => categoryBranches(categories, query), [categories, query])
  const selectedBranch = useMemo<CategoryBranch | null>(
    () => branches.find((branch) => branch.category.id === selectedId) ?? branches[0] ?? null,
    [branches, selectedId],
  )
  const selectedChildren = useMemo(
    () => selectedBranch ? presentationChildren(selectedBranch, query) : [],
    [query, selectedBranch],
  )
  const activeBranches = branches.filter((branch) => !branch.category.archived)
  const archivedBranches = branches.filter((branch) => branch.category.archived)
  const activeChildren = selectedChildren.filter((child) => !child.archived)
  const archivedChildren = selectedChildren.filter((child) => child.archived)

  useEffect(() => {
    if (draft) draftRef.current?.focus()
  }, [draft])

  const requestClose = (reason: 'escape' | 'overlay') => {
    if (reason === 'escape' && draft) {
      setDraft(null)
      setError(null)
    } else if (reason === 'escape' && panel) {
      setPanel(null)
    } else if (!pending && !panel) {
      onClose()
    }
  }

  const run = async <T,>(action: () => Promise<T>, fallback: string): Promise<T | null> => {
    setError(null)
    try {
      return await action()
    } catch (failure) {
      setError(apiErrorMessage(failure, fallback))
      return null
    }
  }

  const commitDraft = async () => {
    if (!draft || committingDraftRef.current) return
    committingDraftRef.current = true
    try {
      const name = draft.value.trim()
      if (!name) {
        setDraft(null)
        return
      }
      if (draft.kind === 'parent') {
        const created = await run(() => create.mutateAsync({ name, parent_id: null }), 'Could not create the category.')
        if (created) {
          setSelectedId(created.id)
          setDraft(null)
          setQuery('')
        }
        return
      }
      if (draft.kind === 'child') {
        if (await run(() => create.mutateAsync({ name, parent_id: draft.parentId }), 'Could not create the subcategory.')) setDraft(null)
        return
      }
      if (name === draft.category.name) {
        setDraft(null)
        return
      }
      if (await run(() => update.mutateAsync({ id: draft.category.id, payload: { name } }), 'Could not rename this category.')) setDraft(null)
    } finally {
      committingDraftRef.current = false
    }
  }

  const beginDelete = (category: Category) => {
    setError(null)
    setPanel({ kind: 'delete', category })
  }

  const confirmDelete = async (category: Category, destinationId: number | null | undefined) => {
    if ((category.transaction_count > 0 || category.schedule_count > 0) && destinationId === undefined) {
      setError('Choose a destination for these transactions and schedules.')
      return
    }
    const completed = await run(
      () => remove.mutateAsync({ id: category.id, payload: { destination_id: destinationId ?? null } }),
      'Could not delete this category.',
    )
    if (!completed) return
    if (category.parent_id === null) setSelectedId(null)
    setPanel(null)
  }

  const confirmMove = async (category: Category, destinationId: number | undefined) => {
    if (destinationId === undefined) {
      setError('Choose a new parent category.')
      return
    }
    if (await run(() => update.mutateAsync({ id: category.id, payload: { parent_id: destinationId } }), 'Could not move this subcategory.')) setPanel(null)
  }

  const actionsFor = (category: Category) => {
    if (category.archived) return [
      { label: 'Restore', onSelect: () => void run(() => update.mutateAsync({ id: category.id, payload: { archived: false } }), 'Could not restore this category.') },
      { label: 'Delete', danger: true, separated: true, onSelect: () => beginDelete(category) },
    ]
    const base = [{ label: 'Rename', onSelect: () => { setError(null); setDraft({ kind: 'rename', category, value: category.name }) } }]
    if (category.parent_id !== null) base.push({ label: 'Move to another category…', onSelect: () => { setError(null); setPanel({ kind: 'move', category }) } })
    return [
      ...base,
      { label: 'Archive', separated: true, onSelect: () => void run(() => update.mutateAsync({ id: category.id, payload: { archived: true } }), 'Could not archive this category.') },
      { label: 'Delete', danger: true, onSelect: () => beginDelete(category) },
    ]
  }

  const renderDraft = (placeholder: string) => <input
    ref={draftRef}
    className="bp-control bp-control--sm"
    type="text"
    placeholder={placeholder}
    value={draft?.value ?? ''}
    disabled={pending}
    onChange={(event) => { setError(null); setDraft((current) => current ? { ...current, value: event.target.value } : null) }}
    onBlur={() => void commitDraft()}
    onKeyDown={(event) => {
      if (isComposingKey(event.nativeEvent)) return
      if (event.key === 'Enter') {
        event.preventDefault()
        void commitDraft()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setDraft(null)
        setError(null)
      }
    }}
  />

  const panelContent = () => {
    if (!panel) return null
    if (panel.kind === 'move') {
      const options = moveDestinations(categories, panel.category)
      return <div className="bp-callout bp-callout--info bp-category-panel" role="alert">
        <strong>Move “{panel.category.name}” to another category</strong>
        <p>Its {panel.category.transaction_count} {panel.category.transaction_count === 1 ? 'transaction stays' : 'transactions stay'} attached and move with it.</p>
        <label className="bp-field">New parent category
          <FilterSelect ariaLabel="New parent category" searchable autoFocus={false} value={panel.destinationId === undefined ? '' : String(panel.destinationId)} disabled={pending} options={[
            { value: '', label: 'Choose a category' },
            ...options.map((option) => ({ value: String(option.id), label: option.label })),
          ]} onChange={(selected) => setPanel({ ...panel, destinationId: selected ? Number(selected) : undefined })} />
        </label>
        <div className="bp-callout-actions"><Button size="md" disabled={pending} onClick={() => setPanel(null)}>Cancel</Button><Button size="md" variant="primary" busy={pending} disabled={panel.destinationId === undefined} onClick={() => void confirmMove(panel.category, panel.destinationId)}>{pending ? 'Moving…' : 'Move'}</Button></div>
      </div>
    }
    const used = panel.category.transaction_count > 0 || panel.category.schedule_count > 0
    const transactionNoun = panel.category.transaction_count === 1 ? 'transaction' : 'transactions'
    const scheduleNoun = panel.category.schedule_count === 1 ? 'schedule' : 'schedules'
    const options = deleteDestinations(categories, panel.category)
    return <div className="bp-callout bp-callout--danger bp-category-panel" role="alert">
      <strong>Delete “{panel.category.name}”?</strong>
      <p>{used
        ? panel.category.parent_id === null
          ? `${panel.category.transaction_count} ${transactionNoun} and ${panel.category.schedule_count} ${scheduleNoun} in this category and its subcategories will move to one destination. This can’t be undone.`
          : `${panel.category.transaction_count} ${transactionNoun} and ${panel.category.schedule_count} ${scheduleNoun} will move to one destination. This can’t be undone.`
        : panel.category.parent_id === null
          ? 'This category and all of its subcategories will be deleted. This can’t be undone.'
          : 'Nothing is categorized here, so nothing moves. This can’t be undone.'}</p>
      {panel.category.rules.length > 0 && <><p>Remove these rule category results before deleting:</p><ul>{panel.category.rules.map((rule) => <li key={rule.id}>Rule {rule.position} · {rule.payee_name}</li>)}</ul></>}
      {used && !panel.category.rules.length && <label className="bp-field">Move transactions and schedules to<DestinationSelect destinationId={panel.destinationId} options={options} pending={pending} onChange={(destinationId) => setPanel({ ...panel, destinationId })} /></label>}
      <div className="bp-callout-actions"><Button size="md" disabled={pending} onClick={() => setPanel(null)}>Cancel</Button><Button size="md" variant="danger" busy={pending} disabled={pending || panel.category.rules.length > 0 || used && panel.destinationId === undefined} onClick={() => void confirmDelete(panel.category, panel.destinationId)}>{pending ? 'Deleting…' : 'Delete'}</Button></div>
    </div>
  }

  const totalChildren = categories.reduce((total, category) => total + category.children.length, 0)
  const branchCount = selectedBranch?.children.length ?? 0
  const railRows = (section: CategoryBranch[]) => section.map((branch) => <button key={branch.category.id} className={`bp-rail-row${branch.category.id === selectedBranch?.category.id ? ' is-selected' : ''}${branch.category.archived ? ' is-archived' : ''}`} type="button" onClick={() => { setSelectedId(branch.category.id); setPanel(null); setDraft(null); setError(null) }}>
    <span><HighlightedName name={branch.category.name} query={query} /></span><b>{activeChildCount(branch.category)}</b>
    {normalizedQuery && !matchesSearch(branch.category.name, normalizedQuery) && <small>{branch.childMatches} matching {branch.childMatches === 1 ? 'subcategory' : 'subcategories'}</small>}
  </button>)
  const childRows = (section: Category[]) => section.map((child) => <div key={child.id} className={`bp-category-row${effectiveArchived(child, selectedBranch?.category ?? null) ? ' is-archived' : ''}`}>
    <div className="bp-category-row-name">{draft?.kind === 'rename' && draft.category.id === child.id ? renderDraft('Subcategory name') : <><span><HighlightedName name={child.name} query={query} /></span>{child.archived ? <span className="bp-tag">Archived</span> : selectedBranch?.category.archived ? <span className="bp-tag">Unavailable while parent is archived</span> : null}</>}</div>
    <fieldset className="bp-category-classification" aria-label={`Spending classification for ${child.name}`} disabled={pending || Boolean(panel) || Boolean(draft) || effectiveArchived(child, selectedBranch?.category ?? null)}>
      {spendingClassifications.map((option) => <label key={option.label}>
        <input
          type="radio"
          name={`category-classification-${child.id}`}
          checked={child.is_discretionary === option.value}
          onChange={() => void run(() => update.mutateAsync({ id: child.id, payload: { is_discretionary: option.value } }), 'Could not save the spending classification.')}
        />
        <span>{option.label}</span>
      </label>)}
    </fieldset>
    <span className={`bp-category-row-count${child.transaction_count === 0 ? ' is-zero' : ''}`}>{child.transaction_count}</span>
    <CategoryRowMenu label={`Actions for ${child.name}`} disabled={pending || Boolean(panel) || Boolean(draft)} items={actionsFor(child)} />
  </div>)

  return (
    <Modal size="xl" labelledBy="category-dialog-title" loading={isLoading} initialFocusRef={searchRef} extraFocusSelector="[data-category-menu] button:not(:disabled)" onRequestClose={requestClose}>
      <DialogHeader titleId="category-dialog-title" title="Category management" subtitle={isLoading ? 'Loading…' : `${categories.length} ${categories.length === 1 ? 'category' : 'categories'} · ${totalChildren} ${totalChildren === 1 ? 'subcategory' : 'subcategories'}`} closeDisabled={pending} onClose={onClose} />
      <div className="bp-dialog-body bp-dialog-body--flush">
        <div className="bp-category-body">
          <aside className="bp-rail bp-category-rail">
            <div className="bp-category-rail-search"><label className="bp-search"><Search aria-hidden="true" /><input ref={searchRef} type="text" placeholder="Search categories" aria-label="Search categories and subcategories" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
            <div className="bp-category-rail-heading"><span className="bp-label">{query.trim() ? 'Matches' : 'Category'}</span><span className="bp-label">Subs</span></div>
            <div className="bp-rail-list bp-category-rail-list">
              {activeBranches.length > 0 && <div className="bp-label bp-category-section-heading">Active</div>}
              {railRows(activeBranches)}
              {archivedBranches.length > 0 && <div className="bp-label bp-category-section-heading">Archived</div>}
              {railRows(archivedBranches)}
              {draft?.kind === 'parent' && <div className="bp-category-rail-draft">{renderDraft('Category name')}</div>}
              {!branches.length && draft?.kind !== 'parent' && <div className="bp-empty"><strong>No categories found</strong><span>Try another search or add a category.</span></div>}
            </div>
            {error && draft?.kind === 'parent' && <div className="bp-callout bp-callout--error bp-category-panel" role="alert">{error}</div>}
            <div className="bp-pane-footer"><Button size="lg" disabled={pending || Boolean(draft) || Boolean(panel)} onClick={() => { setError(null); setDraft({ kind: 'parent', value: '' }) }}><Plus aria-hidden="true" /> New category</Button></div>
          </aside>
          <div className="bp-category-detail">
            {selectedBranch ? <>
              <div className="bp-pane-head">
                <div className="bp-category-title">
                  {draft?.kind === 'rename' && draft.category.id === selectedBranch.category.id ? renderDraft('Category name') : <h3 className="bp-pane-title"><HighlightedName name={selectedBranch.category.name} query={query} /></h3>}
                  {selectedBranch.category.archived && <span className="bp-tag">Archived</span>}
                  <small>{branchCount} {branchCount === 1 ? 'subcategory' : 'subcategories'} · {selectedBranch.category.transaction_count} transactions</small>
                </div>
                <CategoryRowMenu label={`Actions for ${selectedBranch.category.name}`} disabled={pending || Boolean(panel) || Boolean(draft)} items={actionsFor(selectedBranch.category)} />
              </div>
              <div className="bp-category-list-heading"><span className="bp-label">Subcategory</span><span className="bp-label">Spending classification</span><span className="bp-label">Transactions</span><span /></div>
              <div className="bp-category-rows">
                {activeChildren.length > 0 && <div className="bp-label bp-category-section-heading">Active</div>}
                {childRows(activeChildren)}
                {archivedChildren.length > 0 && <div className="bp-label bp-category-section-heading">Archived</div>}
                {childRows(archivedChildren)}
                {draft?.kind === 'child' && draft.parentId === selectedBranch.category.id && <div className="bp-category-row is-drafting"><div className="bp-category-row-name">{renderDraft('Subcategory name')}</div><span /><span /><span /></div>}
                {!selectedChildren.length && draft?.kind !== 'child' && <div className="bp-empty"><strong>{query.trim() ? 'No matching subcategories' : 'No subcategories yet'}</strong><span>{query.trim() ? 'Try another search.' : 'Add a subcategory to make this category available for transactions.'}</span></div>}
              </div>
              {panelContent()}
              {error && draft?.kind !== 'parent' && <div className="bp-callout bp-callout--error bp-category-panel" role="alert">{error}</div>}
              <div className="bp-pane-footer"><Button size="lg" disabled={pending || Boolean(draft) || Boolean(panel) || selectedBranch.category.archived} onClick={() => { setError(null); setDraft({ kind: 'child', parentId: selectedBranch.category.id, value: '' }) }}><Plus aria-hidden="true" /> New subcategory</Button></div>
            </> : <div className="bp-empty"><strong>No category selected</strong><span>Add a category to begin.</span></div>}
          </div>
        </div>
      </div>
    </Modal>
  )
}
