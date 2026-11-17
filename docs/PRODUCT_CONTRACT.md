# Weft product contract

Weft is a single-user account register for same-machine use. It keeps local and Plaid-backed transaction history in one source-aware view.

This document owns approved product requirements. The implementation must satisfy them. Future ideas, work documents and existing or old routes do not expand scope. If source behavior differs, record the mismatch instead of silently changing the requirement. Unresolved findings are listed in [future features and concepts](FUTURE_FEATURES_AND_CONCEPTS.md).

## Read this contract

Use the section index to find the rules affected by a task. Read their complete conditions and linked dependencies. Account connection changes also affect initialization, Plaid lifecycle, matching, transfers, and the data-preservation rules. Register commands also depend on source permissions and Undo/recovery rules. Each area has its own file under [contract/](contract/).

- [System and installation](contract/system.md)
  - [Session](contract/system.md#session)
  - [Plaid settings](contract/system.md#plaid-settings)
  - [AI settings and OpenAI connection](contract/system.md#ai-settings-and-openai-connection)
  - [Diagnostics download](contract/system.md#diagnostics-download)
  - [Backup restore](contract/system.md#backup-restore)
  - [Data protection and schema upgrades](contract/system.md#data-protection-and-schema-upgrades)
- [Accounts](contract/accounts.md)
  - [Account workspace](contract/accounts.md#account-workspace)
  - [Account initialization](contract/accounts.md#account-initialization)
  - [Account feed conversion](contract/accounts.md#account-feed-conversion)
- [Categories and payees](contract/categories-and-payees.md)
  - [Categories](contract/categories-and-payees.md#categories)
  - [Payees](contract/categories-and-payees.md#payees)
- [Register](contract/register.md)
  - [Register](contract/register.md#register)
    - [Scroll behavior](contract/register.md#scroll-behavior)
    - [Presentation preferences and backup eligibility](contract/register.md#presentation-preferences-and-backup-eligibility)
    - [Review after editing](contract/register.md#review-after-editing)
    - [Keyboard entry](contract/register.md#keyboard-entry)
    - [Calendar keyboard behavior](contract/register.md#calendar-keyboard-behavior)
    - [Server-owned permissions](contract/register.md#server-owned-permissions)
    - [Immediate feedback and reconciliation](contract/register.md#immediate-feedback-and-reconciliation)
    - [Undo and Redo](contract/register.md#undo-and-redo)
    - [Transaction context menu](contract/register.md#transaction-context-menu)
  - [CSV export](contract/register.md#csv-export)
  - [Shared action controls](contract/register.md#shared-action-controls)
- [Splits and multi-apply](contract/splits-and-multi-apply.md)
  - [Split-category transactions](contract/splits-and-multi-apply.md#split-category-transactions)
  - [Multi-apply](contract/splits-and-multi-apply.md#multi-apply)
    - [Bulk transfer review](contract/splits-and-multi-apply.md#bulk-transfer-review)
- [Manual and Plaid account workflows](contract/account-workflows.md)
  - [Manual-account workflow](contract/account-workflows.md#manual-account-workflow)
    - [New-entry exit behavior](contract/account-workflows.md#new-entry-exit-behavior)
  - [Plaid-account workflow](contract/account-workflows.md#plaid-account-workflow)
    - [Reported balance history](contract/account-workflows.md#reported-balance-history)
    - [Excluded bank imports](contract/account-workflows.md#excluded-bank-imports)
- [Schedules, loans and transfers](contract/schedules-loans-and-transfers.md)
  - [Scheduled transactions](contract/schedules-loans-and-transfers.md#scheduled-transactions)
    - [Projected balance](contract/schedules-loans-and-transfers.md#projected-balance)
  - [Loan accounts](contract/schedules-loans-and-transfers.md#loan-accounts)
  - [Account transfers](contract/schedules-loans-and-transfers.md#account-transfers)
- [Terms](#terms)
- [Explicit exclusions](#explicit-exclusions)

## Terms

| Term | Meaning |
| --- | --- |
| Register or ledger | The transaction view. The ledger service determines which rows are visible and which actions they permit. |
| Parent row | A top-level transaction. Split allocations appear beneath their parent and do not count as independent transactions. |
| Effective fields | Transaction values after applying an accepted match and its chosen field ownership. |
| Canonical ascending chronology | Date, starting balance first, inflows, zero amounts, outflows, then stable ID within each class. Use effective signed amounts; descending reverses the entire sequence. Allocations stay with their parent and transfer sides use their own account sign. |
| Plaid Item | One stored bank connection. Its account mappings can supply several local accounts. |
| Bank feed | The provider connection and account mapping that refresh one local account. |
| Planned row | A manual row created or moved into a Plaid-workflow account after connection that remains unmatched. Retained historical overlap is not a planned row. |
| Missing pending | A provider-pending row reported removed before its final outcome is resolved. |
| C* or Cleared* | A user override that treats an eligible bank-pending row as cleared while it remains pending at the bank. |
| Edit token | A snapshot marker used to reject a command when relevant row facts have changed. |
| Unknown outcome | The client cannot establish whether a sent write committed. Further writes require the prescribed inspection and refresh. |
| Page-session history | The temporary Undo/Redo record for the current page and backend session. It does not undo provider sync. |

## Explicit exclusions

The current product does not include:

- budgets, forecasts beyond the deterministic Scheduled projected balance, floors, or what-if planning;
- variable-rate loan calculations, amortization schedules, payoff simulation and escrow disbursement tracking;
- split transfers, custom transfer children, automatic counterpart creation outside scheduled transfer entry, and synchronized twin editing beyond the [linked amount correction](contract/schedules-loans-and-transfers.md#unlinking-and-target-lifecycle);
- broad ledger search beyond visible column filters, the payee manager's history workflow, and transfer candidate search;
- user accounts, roles, or logout;
- a global Plaid health console; connection repair is available from linked account settings.

Ideas may remain in `FUTURE_FEATURES_AND_CONCEPTS.md`, but they become product scope only through an explicit decision that updates this contract first.
