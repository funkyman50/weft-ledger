import type { PayeeReferences, PayeeRule } from '../../api/types'
import { Button } from '../../components/Button'
import { money } from '../../lib/money'
import { scheduleFrequencyLabel } from '../ledger/scheduleFrequency'

const reasons = {
  current: 'Ledger transaction',
  matched: 'Matched entry',
  replaced: 'Earlier bank version',
  excluded: 'Excluded import',
  removed: 'Removed by bank',
  missing_pending: 'Missing pending',
  expired_pending: 'Expired pending',
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
const ruleNames = (rules: PayeeRule[]) => `${rules.length === 1 ? 'Rule' : 'Rules'} ${rules.map((rule) => rule.position).join(', ')}`

type Group = PayeeReferences['groups'][number]

function ReferenceRow({ title, detail, amount, date }: { title: string; detail: string; amount: number; date: string }) {
  return <div className="bp-payee-transaction is-static">
    <span><strong>{title}</strong><small>{detail}</small></span>
    <span><b className={amount > 0 ? 'is-positive' : undefined}>{money(amount)}</b><small>{date}</small></span>
  </div>
}

export function PayeeReferenceList({ groups, sourceId, replacement }: {
  groups: Group[]
  sourceId: number
  replacement?: string | null
}) {
  const deleting = replacement === undefined
  return <div className="bp-payee-reference-rows">{groups.map((group) => {
    if (group.schedule) return <ReferenceRow key={group.key} title={group.schedule.memo || 'Scheduled transaction'}
      detail={['Schedule', scheduleFrequencyLabel(group.schedule.frequency), group.schedule.account_name,
        deleting ? 'Blocks deletion' : replacement && `Becomes ${replacement}`].filter(Boolean).join(' · ')}
      amount={group.schedule.amount_cents} date={group.schedule.date} />
    const shown = group.transaction?.payee_id === sourceId
    const outcome = deleting
      ? shown ? 'Blocks deletion' : `Becomes ${group.transaction?.payee_name ?? 'Unknown Payee'}`
      : replacement && `Becomes ${replacement}`
    return group.records.map((record) => <ReferenceRow key={record.id} title={record.description || 'No description'}
      detail={[reasons[record.reason], record.account_name, !group.transaction && 'Not shown in ledger', outcome].filter(Boolean).join(' · ')}
      amount={record.amount_cents} date={record.date} />)
  })}</div>
}

export function PayeeDeletionEffects({ following, followingName, unknown, rules, compact = false }: {
  following: number
  followingName?: string | null
  unknown: number
  rules: PayeeRule[]
  compact?: boolean
}) {
  if (compact) return <small>{[
    following > 0 && `${counted(following, 'record')} ${following === 1 ? 'follows its' : 'follow their'} ledger transaction`,
    unknown > 0 && `${counted(unknown, 'record')} ${unknown === 1 ? 'becomes' : 'become'} Unknown Payee`,
    rules.length > 0 && `deletes ${ruleNames(rules)}`,
  ].filter(Boolean).join(' · ') || 'Nothing else changes'}</small>
  const items = [
    following > 0 && `${counted(following, 'record')} will switch to ${followingName ?? 'the payee shown on their ledger transaction'}.`,
    unknown > 0 && `${counted(unknown, 'record')} not shown in your ledger will change to Unknown Payee.`,
    rules.length > 0 && `${ruleNames(rules)} will be deleted.`,
  ].filter((item): item is string => Boolean(item))
  if (items.length < 2) return items.length ? <p className="bp-dialog-copy">{items[0]}</p> : null
  return <ul className="bp-dialog-copy bp-dialog-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>
}

export function PayeeReferencePagination({ total, offset, nextOffset, disabled, onPage }: {
  total: number
  offset: number
  nextOffset: number | null
  disabled: boolean
  onPage: (offset: number) => void
}) {
  if (total <= 100) return null
  return <div className="bp-payee-pagination">
    <Button size="md" disabled={disabled || offset === 0} onClick={() => onPage(Math.max(0, offset - 100))}>Previous</Button>
    <span>{offset + 1}–{Math.min(offset + 100, total)} of {total}</span>
    <Button size="md" disabled={disabled || nextOffset === null} onClick={() => onPage(nextOffset!)}>Next</Button>
  </div>
}
