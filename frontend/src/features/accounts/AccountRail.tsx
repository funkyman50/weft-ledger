import type { AccountScope } from '../../lib/accountScope'
import { createContext, use, useCallback, useId, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, Search, Settings, TriangleAlert } from 'lucide-react'

import { ApiError, apiClient } from '../../api/client'
import { invalidateAccountAndTransactionQueries, useReorderAccounts } from '../../api/hooks'
import { isComposingKey } from '../../lib/keyboard'
import { money } from '../../lib/money'
import { ActionMenu, ActionMenuItem } from '../../components/ActionMenu'
import { Button } from '../../components/Button'
import { HelpTooltip } from '../../components/HelpTooltip'
import type { Account } from '../../api/types'
import { PlaidConnectionWorkflow } from '../plaid/PlaidConnectionWorkflow'
import { AccountIcon } from './AccountIcon'
import { accountTypeLabel } from './accountTypes'
import { accountBankDifference } from './accountBalances'
import { useSortableAccountRail } from './useSortableAccountRail'

declare const __WEFT_VERSION__: string
declare const __WEFT_CHANNEL__: 'dev' | 'prod'
declare const __WEFT_BUILD__: string

export type AccountMenuAction = 'edit' | 'logo' | 'loan' | 'export' | 'refresh' | 'repair' | 'connect' | 'close' | 'reopen'
export type ConnectionHealth = 'failing' | 'needs_sign_in'

const HEALTH_REASON: Record<ConnectionHealth, string> = { failing: "Bank connection failing: Plaid's last attempt failed", needs_sign_in: 'Bank connection needs sign-in' }

const AccountMenuContext = createContext<{ health: Map<number, ConnectionHealth>; open: (account: Account, event: MouseEvent<HTMLButtonElement>) => void }>({ health: new Map(), open: () => {} })

const releaseName = `v${__WEFT_VERSION__}${__WEFT_CHANNEL__ === 'dev' ? ' dev' : ''}`

export function AccountRail({
  showAccountIcons,
  highlightBankDifferences,
  compact,
  openAccounts,
  closedAccounts,
  selectedAccountId,
  onSelect,
  onCreate,
  onManageCategories,
  onManagePayees,
  onSystemSettings,
  onError,
  health,
  repairableAccountIds,
  onAccountAction,
}: {
  showAccountIcons: boolean
  highlightBankDifferences: boolean
  compact: boolean
  openAccounts: Account[]
  closedAccounts: Account[]
  selectedAccountId: AccountScope | null
  onSelect: (accountId: AccountScope) => void
  onCreate: () => void
  onManageCategories: () => void
  onManagePayees: () => void
  onSystemSettings: (trigger: HTMLButtonElement) => void
  onError: (message: string) => void
  health: Map<number, ConnectionHealth>
  repairableAccountIds: Set<number>
  onAccountAction: (account: Account, action: AccountMenuAction) => void
}) {
  const [menu, setMenu] = useState<{ account: Account; left: number; top: number; trigger: HTMLButtonElement } | null>(null)
  const menuAnchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const groupItemRef = useRef<HTMLButtonElement>(null)
  const groupMenuRef = useRef<HTMLDivElement>(null)
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const openMenu = useCallback((account: Account, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const trigger = event.currentTarget
    const row = trigger.getBoundingClientRect()
    // Keyboard-opened context menus report no pointer position.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0
    setGroupMenuOpen(false)
    setMenu({ account, left: fromKeyboard ? row.left + 24 : event.clientX, top: fromKeyboard ? row.bottom : event.clientY, trigger })
  }, [])
  const closeMenu = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) menu?.trigger.focus()
    setGroupMenuOpen(false)
    setMenu(null)
  }, [menu])
  const choose = (action: AccountMenuAction) => {
    const { account } = menu!
    closeMenu(true)
    onAccountAction(account, action)
  }
  const queryClient = useQueryClient()
  const moveToGroup = useMutation({
    mutationFn: ({ account, group }: { account: Account; group: string | null }) => apiClient.patch<Account>(`/api/accounts/${account.id}`, { group_name: group }),
    onSuccess: () => invalidateAccountAndTransactionQueries(queryClient),
    onError: (error) => onError(error instanceof ApiError ? error.message : 'The account group could not be saved.'),
  })
  const chooseGroup = (group: string | null) => {
    const { account } = menu!
    closeMenu(true)
    if (group !== account.group_name) moveToGroup.mutate({ account, group })
  }
  const groupNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const account of [...openAccounts, ...closedAccounts]) {
      if (account.group_name) names.set(account.group_name.toLocaleLowerCase(), account.group_name)
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b))
  }, [openAccounts, closedAccounts])
  const openGroupMenu = (focus = false) => {
    setGroupMenuOpen(true)
    if (focus) queueMicrotask(() => groupMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
  }
  const closeGroupMenu = () => { setGroupMenuOpen(false); groupItemRef.current?.focus() }
  const reorderAccounts = useReorderAccounts()
  const [closedAccountsOpen, setClosedAccountsOpen] = useState(false)
  const blocks: { group: string | null; accounts: Account[] }[] = []
  const groups = new Map<string, Account[]>()
  for (const account of openAccounts) {
    if (account.group_name === null) blocks.push({ group: null, accounts: [account] })
    else {
      let members = groups.get(account.group_name)
      if (!members) {
        members = []
        groups.set(account.group_name, members)
        blocks.push({ group: account.group_name, accounts: members })
      }
      members.push(account)
    }
  }
  const reorderOpenAccounts = useCallback(async (ids: number[]) => {
    try {
      await reorderAccounts.mutateAsync(ids)
    } catch (error) {
      onError(
        error instanceof ApiError
          ? error.message
          : 'Account order could not be saved.',
      )
      throw error
    }
  }, [onError, reorderAccounts])
  const openAccountListRef = useSortableAccountRail(
    blocks.length > 1 && !reorderAccounts.isPending,
    reorderOpenAccounts,
    JSON.stringify(blocks.map((block) => block.accounts.map((account) => account.id))),
  )
  const totalNeedsReview = openAccounts.concat(closedAccounts).reduce(
    (count, account) => count + account.pending_count,
    0,
  )

  const menuAccount = menu?.account
  return (
    <AccountMenuContext value={{ health, open: openMenu }}>
    <aside className="bp-sidebar">
      <div className="bp-brand">
        <img className="bp-brand-mark" src="/icon.png" alt="Weft" width={36} height={36} />
        <HelpTooltip className="bp-brand-name" explanation={`${releaseName}${__WEFT_BUILD__ ? `, build ${__WEFT_BUILD__}` : ''}`}><strong>Weft</strong><span className="bp-brand-release">{releaseName}</span></HelpTooltip>
        <Button className="bp-system-settings-button" size="md" variant="quiet" iconOnly aria-label="System settings" onClick={(event) => onSystemSettings(event.currentTarget)}><Settings aria-hidden="true" /></Button>
      </div>
      <nav className="bp-account-list" aria-label="Accounts">
        <button className={`bp-account bp-all-accounts${showAccountIcons ? '' : ' is-iconless'}${compact ? ' is-compact' : ''}${selectedAccountId === 'all' ? ' is-selected' : ''}`} type="button" title={compact ? 'Combined history' : undefined} onClick={() => onSelect('all')}>
          {showAccountIcons && <span className="bp-account-icon"><img src="/all-accounts-piggy.png" alt="" draggable={false} /></span>}
          <span className="bp-account-copy">
            <strong>All Accounts</strong>
            <span className="bp-account-details">
              <small>Combined history</small>
              {totalNeedsReview > 0 && <span className="bp-account-count"><span aria-hidden="true">{totalNeedsReview}</span><span className="bp-visually-hidden">{totalNeedsReview} need review</span></span>}
            </span>
          </span>
        </button>
        <div className="bp-open-account-list" ref={openAccountListRef}>
          {blocks.map((block) => block.group !== null ? (
            <AccountGroup key={`group:${block.group}`} name={block.group} accounts={block.accounts} sortable={!reorderAccounts.isPending} showAccountIcons={showAccountIcons} highlightBankDifferences={highlightBankDifferences} compact={compact} selectedAccountId={selectedAccountId} onSelect={onSelect} onReorder={async (ids) => {
              const groupIds = new Set(ids)
              let index = 0
              await reorderOpenAccounts(openAccounts.map((account) => groupIds.has(account.id) ? ids[index++] : account.id))
            }} />
          ) : (
            <AccountRailItem
              key={block.accounts[0].id}
              account={block.accounts[0]}
              showAccountIcons={showAccountIcons}
              highlightBankDifferences={highlightBankDifferences}
              compact={compact}
              selected={block.accounts[0].id === selectedAccountId}
              onSelect={() => onSelect(block.accounts[0].id)}
            />
          ))}
        </div>
        {closedAccounts.length > 0 && (
          <div className="bp-closed-accounts">
            <button
              className="bp-closed-accounts-toggle"
              type="button"
              aria-expanded={closedAccountsOpen}
              onClick={() => setClosedAccountsOpen((open) => !open)}
            >
              Closed accounts ({closedAccounts.length})
            </button>
            {closedAccountsOpen && closedAccounts.map((account) => (
              <AccountRailItem
                key={account.id}
                account={account}
                showAccountIcons={showAccountIcons}
                highlightBankDifferences={highlightBankDifferences}
                compact={compact}
                selected={account.id === selectedAccountId}
                onSelect={() => onSelect(account.id)}
              />
            ))}
          </div>
        )}
      </nav>
      <div className="bp-sidebar-footer">
        <Button size="lg" onClick={onManageCategories}>
          Categories
        </Button>
        <Button size="lg" onClick={onManagePayees}>
          Payees
        </Button>
        <Button
          size="lg"
          onClick={onCreate}
        >
          New account
        </Button>
        <PlaidConnectionWorkflow compact onError={onError} />
      </div>
      {menuAccount && <>
        <span ref={menuAnchorRef} className="bp-context-anchor" style={{ left: menu.left, top: menu.top }} aria-hidden="true" />
        <ActionMenu anchorRef={menuAnchorRef} menuRef={menuRef} width={196} relatedRefs={[groupMenuRef]} aria-label={`${menuAccount.name} actions`} onDismiss={(reason) => {
          if (reason === 'escape' && groupMenuOpen) closeGroupMenu()
          else closeMenu(reason !== 'outside')
        }}>
          <ActionMenuItem onFocus={() => setGroupMenuOpen(false)} onPointerEnter={() => setGroupMenuOpen(false)} onClick={() => choose('edit')}>Edit account…</ActionMenuItem>
          <ActionMenuItem onFocus={() => setGroupMenuOpen(false)} onPointerEnter={() => setGroupMenuOpen(false)} onClick={() => choose('logo')}>Change logo…</ActionMenuItem>
          <ActionMenuItem ref={groupItemRef} aria-haspopup="menu" aria-expanded={groupMenuOpen} onPointerEnter={() => openGroupMenu()} onClick={() => openGroupMenu(true)} onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return
            if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openGroupMenu(true) }
          }}>Move to group <ChevronRight aria-hidden="true" /></ActionMenuItem>
          {menuAccount.type === 'loan' && <ActionMenuItem onFocus={() => setGroupMenuOpen(false)} onPointerEnter={() => setGroupMenuOpen(false)} onClick={() => choose('loan')}>Loan details…</ActionMenuItem>}
          <ActionMenuItem onFocus={() => setGroupMenuOpen(false)} onPointerEnter={() => setGroupMenuOpen(false)} onClick={() => choose('export')}>Export…</ActionMenuItem>
          {menuAccount.plaid_connection && <ActionMenuItem onFocus={() => setGroupMenuOpen(false)} onPointerEnter={() => setGroupMenuOpen(false)} onClick={() => choose('refresh')}>Refresh from bank…</ActionMenuItem>}
          {menuAccount.plaid_connection && repairableAccountIds.has(menuAccount.id) && <ActionMenuItem onFocus={() => setGroupMenuOpen(false)} onPointerEnter={() => setGroupMenuOpen(false)} onClick={() => choose('repair')}>Repair connection…</ActionMenuItem>}
          {!menuAccount.plaid_connection && !menuAccount.closed && <ActionMenuItem onFocus={() => setGroupMenuOpen(false)} onPointerEnter={() => setGroupMenuOpen(false)} onClick={() => choose('connect')}>Connect to bank…</ActionMenuItem>}
          {menuAccount.closed
            ? <ActionMenuItem onFocus={() => setGroupMenuOpen(false)} onPointerEnter={() => setGroupMenuOpen(false)} onClick={() => choose('reopen')}>Reopen account</ActionMenuItem>
            : <ActionMenuItem onFocus={() => setGroupMenuOpen(false)} onPointerEnter={() => setGroupMenuOpen(false)} onClick={() => choose('close')}>Close account…</ActionMenuItem>}
        </ActionMenu>
        {groupMenuOpen && <ActionMenu anchorRef={groupItemRef} menuRef={groupMenuRef} relatedRefs={[menuRef]} width={196} placement="side" autoFocus={false} aria-label={`Move ${menuAccount.name} to group`} onDismiss={(reason) => {
          if (reason === 'escape') closeGroupMenu()
          else closeMenu(reason !== 'outside')
        }} onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); closeGroupMenu() }
        }}>
          {[null, ...groupNames].map((group) => <ActionMenuItem key={group ?? ''} role="menuitemradio" aria-checked={group === menuAccount.group_name} onClick={() => chooseGroup(group)}>{group ?? 'No group'}{group === menuAccount.group_name && <Check aria-hidden="true" />}</ActionMenuItem>)}
        </ActionMenu>}
      </>}
    </aside>
    </AccountMenuContext>
  )
}

function AccountGroup({ name, accounts, sortable, showAccountIcons, highlightBankDifferences, compact, selectedAccountId, onSelect, onReorder }: {
  name: string
  accounts: Account[]
  sortable: boolean
  showAccountIcons: boolean
  highlightBankDifferences: boolean
  compact: boolean
  selectedAccountId: AccountScope | null
  onSelect: (id: AccountScope) => void
  onReorder: (ids: number[]) => Promise<void>
}) {
  const [collapsed, setCollapsed] = useState(false)
  const membersId = useId()
  const ids = accounts.map((account) => account.id)
  const membersRef = useSortableAccountRail(sortable && !collapsed && accounts.length > 1, onReorder, JSON.stringify(ids))
  const pending = accounts.some((account) => account.working_balance_cents === null)
  const total = accounts.reduce((sum, account) => sum + (account.working_balance_cents ?? 0), 0)
  const selected = selectedAccountId === `group:${name}`
  return <div className={`bp-account-group${selected ? ' is-selected' : ''}`} data-sortable-account-ids={JSON.stringify(ids)}>
    <div className="bp-account-group-header">
      <button className="bp-account-group-toggle" type="button" aria-expanded={!collapsed} aria-controls={collapsed ? undefined : membersId} onClick={() => setCollapsed((value) => !value)}>
        {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        <span className="bp-account-group-name" title={name}>{name}</span>
        <span className={`bp-account-group-total${!pending && total < 0 ? ' is-negative' : ''}`} title={pending ? 'Group total is pending until every account is initialized.' : 'Combined working balance'}>{pending ? 'PEND' : money(total)}</span>
      </button>
      <Button className="bp-account-group-open" data-account-group-open size="sm" variant="quiet" iconOnly aria-label={`Open ${name} group ledger`} title={`Open ${name} group ledger`} aria-current={selected ? 'page' : undefined} onClick={() => onSelect(`group:${name}`)}><Search aria-hidden="true" /></Button>
    </div>
    {!collapsed && <div id={membersId} className="bp-account-group-members" ref={membersRef}>
      {accounts.map((account) => <AccountRailItem key={account.id} account={account} showAccountIcons={showAccountIcons} highlightBankDifferences={highlightBankDifferences} compact={compact} selected={selectedAccountId === account.id} onSelect={() => onSelect(account.id)} />)}
    </div>}
  </div>
}

export function AccountRailItem({ account, showAccountIcons, highlightBankDifferences, compact, selected, onSelect }: { account: Account; showAccountIcons: boolean; highlightBankDifferences: boolean; compact: boolean; selected: boolean; onSelect: () => void }) {
  const menu = use(AccountMenuContext)
  const typeLabel = accountTypeLabel(account.type)
  const health = menu.health.get(account.id)
  const difference = highlightBankDifferences ? accountBankDifference(account) : null
  const warning = health ? HEALTH_REASON[health] : difference === null ? null : `Bank difference ${money(difference, true)}`
  const title = [compact ? typeLabel : null, warning].filter(Boolean).join(' · ') || undefined
  const showIcon = showAccountIcons || (!compact && warning !== null)
  return (
    <button className={`bp-account${showIcon ? '' : ' is-iconless'}${compact ? ' is-compact' : ''}${selected ? ' is-selected' : ''}${health ? ' has-connection-failure' : warning ? ' has-bank-difference' : ''}`} type="button" title={title} data-sortable-account-ids={JSON.stringify([account.id])} onClick={onSelect} onContextMenu={(event) => menu.open(account, event)}>
      {!compact && warning
        ? <span className={`bp-account-icon bp-account-icon--${health ? 'danger' : 'warning'}`} aria-hidden="true"><TriangleAlert /></span>
        : showAccountIcons && <AccountIcon account={account} />}
      <span className="bp-account-copy">
        <span className="bp-account-name">
          {compact && warning && <TriangleAlert className={health ? 'is-danger' : undefined} aria-hidden="true" />}
          <strong>{account.name}</strong>
          {warning && <span className="bp-visually-hidden">{warning}</span>}
        </span>
        <span className="bp-account-details">
          <small>{typeLabel}</small>
          {account.pending_count > 0 && <span className="bp-account-count"><span aria-hidden="true">{account.pending_count}</span><span className="bp-visually-hidden">{account.pending_count} need review</span></span>}
          <span className={`bp-account-balance${account.working_balance_cents !== null && account.working_balance_cents < 0 ? ' is-negative' : ''}`} aria-label={account.plaid_connection && account.starting_balance_initialized_at === null ? 'Initialization pending' : undefined}>
            {account.plaid_connection && account.starting_balance_initialized_at === null ? 'PEND' : money(account.working_balance_cents ?? 0)}
          </span>
        </span>
      </span>
    </button>
  )
}
