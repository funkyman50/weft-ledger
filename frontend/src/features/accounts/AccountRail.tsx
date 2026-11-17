import type { AccountScope } from '../../lib/accountScope'
import { useCallback, useId, useState } from 'react'
import { ChevronDown, ChevronRight, Search, Settings, TriangleAlert } from 'lucide-react'

import { ApiError } from '../../api/client'
import { useReorderAccounts } from '../../api/hooks'
import { money } from '../../lib/money'
import { Button } from '../../components/Button'
import type { Account } from '../../api/types'
import { PlaidConnectionWorkflow } from '../plaid/PlaidConnectionWorkflow'
import { AccountIcon } from './AccountIcon'
import { accountTypeLabel } from './accountTypes'
import { accountBankDifference } from './accountBalances'
import { useSortableAccountRail } from './useSortableAccountRail'

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
}) {
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

  return (
    <aside className="bp-sidebar">
      <div className="bp-brand">
        <img className="bp-brand-mark" src="/icon.png" alt="Weft" width={36} height={36} /><strong aria-hidden="true">Weft</strong>
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
    </aside>
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
  const typeLabel = accountTypeLabel(account.type)
  const difference = highlightBankDifferences ? accountBankDifference(account) : null
  const warning = difference === null ? null : `Bank difference ${money(difference, true)}`
  const title = [compact ? typeLabel : null, warning].filter(Boolean).join(' · ') || undefined
  const showIcon = showAccountIcons || (!compact && warning !== null)
  return (
    <button className={`bp-account${showIcon ? '' : ' is-iconless'}${compact ? ' is-compact' : ''}${selected ? ' is-selected' : ''}${warning ? ' has-bank-difference' : ''}`} type="button" title={title} data-sortable-account-ids={JSON.stringify([account.id])} onClick={onSelect}>
      {!compact && warning
        ? <span className="bp-account-icon bp-account-icon--warning" aria-hidden="true"><TriangleAlert /></span>
        : showAccountIcons && <AccountIcon account={account} />}
      <span className="bp-account-copy">
        <span className="bp-account-name">
          {compact && warning && <TriangleAlert aria-hidden="true" />}
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
