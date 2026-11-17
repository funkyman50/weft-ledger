# Splits and multi-apply

This file is part of the [product contract](../PRODUCT_CONTRACT.md). It owns the approved requirements for the sections below.

## Split-category transactions

### Picker entry

- Category picker search, No category and the optional Split… command stay above the scrolling category choices.
- An eye toggle beside Category picker search shows or hides each subcategory's spending classification, hidden by default. When shown, an unboxed **D** (Discretionary) or **N** (Non-discretionary) tag forms the rightmost column and any selected checkmark moves just inside it; Not applicable shows no tag. When hidden, the checkmark stays rightmost. Hover text and the option's accessible name give the full classification. The toggle is the first popup command in Tab order. Its browser-local preference applies to every Category picker and survives reload when storage is available.
- Split… sits immediately below No category and remains available during search.
- Bulk reset precedes No category where applicable.
- The permanent individual Category picker action Split… opens two inline allocation rows.
- Existing category goes into the first row.
- Both amounts start blank.
- Each allocation owns only category, memo, and signed amount.
- The parent remains one financial transaction and owns all workflow actions.

### Split draft and commit

- Split editing stages parent edits and allocations together and saves atomically through explicit Save or Cmd/Ctrl+Enter.
- Clicking outside, blur, and Enter do not save.
- Cancel or Escape restores the entire previous state. In an open picker, Escape closes only the picker.
- A changed split draft offers Keep editing or Discard changes before account/filter/workflow navigation.
- This intentionally protects a more detailed draft than bulk staging.
- Refresh, sorting, and loading preserve its group and draft.
- Only one split editor is active.
- Staged bulk work must finish first.

### Allocation validation

- Save requires at least two nonzero exact-cent allocations whose signed sum equals the parent amount.
- Each ordinary line requires an assignment or deliberate No category.
- Untouched extra blank lines are ignored.
- Partial lines block Save.
- Duplicate categories and mixed signs are allowed.
- A stable existing allocation may retain an archived assignment while editing its amount or memo.
- A new or changed assignment requires an active subcategory.

- Split validation identifies the affected row and amount problem before checking for a missing category.
- Errors and recovery details appear in the footer's left-hand space, separate from its action buttons.

### Remaining amount and distribution

- Each allocation row carries a Use remaining action that fills that line from the parent total minus all other amounts.
- Auto-distribute previews a receipt-wide adjustment across ordinary lines using absolute weights, excluding the system line.
- It requires complete nonzero ordinary lines of one shared sign and rejects zero/sign-reversing results.
- Largest fractional remainders receive rounding cents, with displayed order breaking ties.
- Neither helper saves or automatically follows later edits.

### Expansion and un-split

- Saved Split (n) parents expand/collapse with allocations attached beneath them, in the compact register column alignment.
- The entire parent Split category cell toggles expansion. Expanded allocation rows use their parent's selection and edit gestures.
- Save leaves the group expanded.
- Un-split removes every allocation without a preview or confirmation and gives the parent the first line's category, or No category when that line has none.
- A saved split saves immediately together with staged parent edits, and an unsaved split draft simply closes back to the ordinary editor.
- Allocation memos are discarded.

### Pending, matching and allocation ownership

- Pending transactions may be split.
- Provider links or explicit pending resolution establish the cleared relationship.
- Allocations never establish a new match.
- The surviving record retains the selected complete breakdown, including allocation memos.
- Conflicting user categorizations, including deliberate No category, require a whole-breakdown choice.
- A known provider-linked conflict remains actionable and excluded from balances until resolved.
- Unrelated missing rows retain the existing grace-window rules.
- Confirmed disappearance deletes the parent and its allocations.

- Matching selects a complete source-owned breakdown.
- Matching and pending-resolution comparison dialogs label a split simply Split, without listing allocation categories, memos, or amounts.
- Source choices and difference highlighting still use the actual complete breakdown.
- Ordinary category labels and dialog layout remain unchanged.
- A semantic no-op preserves source ownership.
- A user change writes the bank-owned breakdown.
- A new bank-owned transfer classification or connection must materialize its target without changing Payee or ordinary Category on the bank record even when the effective values already agree.
- Unmatch preserves each source's own data.
- If the bank amount changes while the history source owns the effective split, materialize that breakdown on the bank record, switch category ownership to the bank, and preserve the history original. If provider changes affect hidden Plaid history under a live accepted parent, materialize its selected category/breakdown on that live parent before adjusting the hidden original.

### Provider amount changes and split differences

- Changed imported amounts preserve ordinary allocation amounts and add/update one protected Unassigned split difference line, or remove it at zero difference.
- This system marker is separate from ordinary categories and unavailable in assignment pickers.
- Users may recategorize it, deliberately choose No category, or distribute it.
- Subsequent corrections preserve any recategorized line as ordinary.
- Manual amount changes require explicit rebalancing and cannot manufacture a system difference.

- A distinct category warning and unassigned amount remain visible when the parent is collapsed, selected, edited, or already amber for Needs Review.
- External amount changes on records with a split, including a bank-owned split temporarily hidden by a matched manual category, and unequal-total automatic pending resolution set Needs Review.
- Sync updates on records with no split retain their existing review behavior.
- Equal-total automatic pending resolution preserves the survivor's review state.
- Explicit pending resolution marks the survivor Reviewed.
- Saving categorization does not review unless the individual Plaid save qualifies under the enabled [review-after-edit preference](register.md#review-after-editing).
- Explicit R may review while the independent warning remains.

### Filters and bulk boundaries

- Category and allocation-memo filters return the parent once, with its full amount and complete expanded breakdown.
- Matching allocation categories are highlighted.
- A read-only filter finds Unassigned split.
- Sorting, balances, counts, and history paging operate on parents.
- Category usage counts distinct parents across single and split assignments, and deletion reassigns all affected allocations atomically without changing amounts/memos.

- Bulk category replacement or clear rejects the entire command if any selected effective row is split.
- Other permitted bulk fields remain parent-only.
- Moving/deleting a parent carries/removes its allocations.
- Allocations cannot be selected, reviewed, cleared, matched, or moved independently.

### Split save and recovery

- Split saves lock controls and validate a current edit token.
- Known rejection preserves the draft.
- Stale state requires explicit reconciliation.
- An unknown write outcome requires successful explicit Refresh and inspection before any new attempt, with no automatic retry.
- Confirmed save followed by refresh failure remains success.

## Multi-apply

### Toolbar and loaded-row selection

- Selecting two or more persisted rows opens a compact editor above the register: count, flag diamond, Payee, Category, Memo, workflow state (`R` for Plaid-workflow accounts; `C` and `R` for local accounts), Save, situational Match, and Cancel. A single selected row stays highlighted without opening this editor. If an existing multi-edit shrinks to one row, hide its editing fields but retain staged-work Save/Cancel and required recovery controls. A one-row select-all intent retains Select All X and Cancel without editing fields.
- The unsaved composer cannot be selected.
- A normal-clicked row is included when the next row is Cmd/Ctrl-clicked.

- Cmd/Ctrl+A inside the focused ledger selects all loaded persisted parents, including fetched rows outside the viewport.
- A resting ordinary row or closed picker trigger yields to this shortcut even while its editing controls are visible.
- Finish that row through the existing commit-before-selection behavior.
- An unchanged draft closes without a write, and a failed save retains the draft without selecting rows.
- Preserve native text selection and keyboard ownership in focused text fields, open pickers, filters, popups, menus, and dialogs.
- Composers, split drafts, and busy/recovery workflows retain ownership.
- Restricted persisted parents remain selected and retain their ordinary action restrictions.
- This shortcut alone creates the select-all intent: its toolbar shows the selected count against the current matching count and offers **Select All X** when additional matches exist.
- Shift-click, modifier-click, and context-menu selection do not create that intent.
- Manual selection changes clear it.
- Repeating the shortcut never automatically expands or toggles selection, and never drops already-selected offscreen members.

### Full-query selection and history preview

- **Select All X** reads a fixed, complete snapshot matching the current account, filters, and source scope without loading more displayed rows.
- Preserve the prior selection and staged changes until that cancellable read succeeds.
- Failure or cancellation never leaves partial expansion.
- New arrivals do not automatically join.
- Sorting and ordinary history loading preserve membership.
- Account/filter changes and Cancel clear selection and intent.
- Refresh expanded saved facts and prune unavailable members after a successful same-view data refresh, while keeping token-sensitive actions blocked until reconciliation succeeds.
- Navigation, new editing, and superseded reads cannot apply late results.
- Every bulk consumer, selected total, context-menu target set, and sorted transfer queue uses the complete saved selected facts, including offscreen members.

- Ordinary Save, Move, and Delete of an expanded selection use a read-only preview of the concrete saved targets before committing.
- Their existing confirmation surfaces explain when the potential new history receipt exceeds Undo's record budget and the save may be non-undoable and end earlier history.
- Combine this with memo replacement confirmation when necessary.
- The preview does not change history or saved records, substitute new tokens into an existing confirmation, or predict routine eviction of older steps within the bounded history budget.
- A failed or stale preview preserves staging or the dialog and blocks that attempt.

### Selected totals and staged fields

- Explicit selection also shows the signed net saved amount above `Selected (N)` directly left of Cleared in the lower footer, as a full-height blue segment matching selected rows, without a border or rounded corners.
- Credit information and the account-balance equation remain visible.
- Sum each selected visible parent once, including split parents, accepted matches, and missing-pending rows.
- Empty selection hides the block.
- A zero net remains visible.
- Incomplete selected-row snapshots show an accessible unavailable state rather than a partial sum.
- The display follows the existing selection lifecycle, wraps without overlapping balances, and performs no writes.

- Flag, existing payee, assignable subcategory, replacement memo, and workflow state are staged until Save.
- Workflow state is absolute Review in Plaid-workflow accounts, with ordinary Clearance for eligible manual or detached-bank selections, and absolute Clearance and Review in local accounts.
- Ordinary C staging requires complete eligible selection. Clicking C cycles Leave unchanged, Cleared and Uncleared; it has no separate Reset control.
- Show the existing ordinary C control in a Plaid-workflow register when the complete selection permits clearance or that field is already staged. If eligibility changes, keep the staged control visible and disabled and block Save until the incompatible row is removed or the staged changes are cancelled.
- Context-menu Mark selected commands stage through the same owner rather than writing immediately.
- Every field starts at Leave unchanged and can independently return to it.
- Clearing a flag, payee, or category is explicit.
- An empty memo field leaves memos unchanged and typed text replaces every selected memo.
- Memos cannot be cleared in bulk and never append.

### Manual pending clearance

- Eligible pending Plaid selections additionally show a two-state `C*` button with a red asterisk next to R.
- It uses R’s blue face when all selected rows are manually cleared and silver otherwise, including mixed selections.
- A staged value overrides saved values.
- Clicking alternates between staging manual clear and undo, without a third cycle state or check/undo icons.
- The independent Reset discards that staged field and restores the saved selection’s appearance.
- The same absolute intent can be staged from the selection context menu, including one row with an existing draft.
- Both apply through Save atomically and preserve provider status and review unless Review is explicitly staged.
- The untouched toolbar control appears only for an entirely eligible selection. Its menu commands appear when any selected row permits manual clearance or has its backend blocked reason, and remain disabled unless every target permits it.
- If eligibility changes after staging, retain the disabled control and an independent Reset, and block Save until the incompatible row is removed or Manual clearance is reset.
- Transfer-review mode disables `C*` and its menu commands.

### Selection changes and atomic apply

- Adding or removing selected rows preserves staged changes while at least one remains.
- Sorting and loading preserve selection.
- Zero selection, Cancel, account changes, and user-filter changes discard the draft.
- A completed successful same-view refresh prunes unavailable selected rows.
- Confirmation and submission freeze their snapshot.

- Ordinary Save applies every requested change to every selected row in one atomic command.
- Server policy determines eligibility.
- An incompatible added row preserves the staged change but blocks Save until that row is removed or that field is reset.
- Equal effective values are successful no-ops and preserve matched-field ownership.
- Choosing a transfer destination instead opens the per-item review queue described below.

### Memo replacement confirmation

- Ordinary bulk replacement of differing nonempty effective memos requires a confirmation popup that leaves account and filter navigation available.
- These writes submit IDs and existing ledger edit tokens, and validate every selected row under one write lock.
- Any token-covered change, including provider raw/status changes, rejects the whole command.
- Refresh current targets and require another Save/new memo confirmation.
- Never replay an old confirmation with substituted snapshots.
- Transfer queue confirmations show each source's proposed memo and other changes directly in the comparison.

### Draft guards and outcome recovery

- Staged changes block individual row actions and entry into editing, matching, pending resolution, or a new composer, except that the selection context menu may add its applicable clearance/review/manual-clearance state to the same draft.
- With an unstaged selection, individual actions remain single-row.
- Pending resolution explicitly clears selection.
- A valid pair can open the existing Match comparison only with no staged changes.

- A confirmed save clears selection and draft.
- Rejection preserves them with an error.
- An unknown network outcome preserves the draft and requires a successful explicit Refresh before another Save.
- It never retries automatically.
- A refresh failure after confirmed commit does not turn the save into a failed write.
- Late completion cannot affect a different account or filter view.

### All Accounts and relationship boundaries

- In All Accounts, the bulk toolbar exposes both review and local clearance. Context menus use the same applicability and order rules as individual account views.
- Each action remains unavailable unless every selected row permits it.
- Mixed selections still support their mutually editable metadata.
- Transfer and move destinations exclude every selected source account.
- Restore previews show balance effects separately for each account.

- Ordinary bulk apply assigns metadata and the account workflow's review or clearance state without creating or removing matching relationships.
- It routes a newly assigned transfer target through the transfer review queue. Eligible unlinked rows can Clear transfer atomically while retaining Payee and Category. Payee has no clear state. Ordinary Category remains editable independently.
- It rejects provider-status clearance for Plaid-workflow accounts.
- Their eligible pending Plaid parents use the separate manual-clearance override field.
- A bulk Payee or target change that makes a pair eligible for automatic matching waits for an ordinary reconciliation-triggering write or Plaid sync, or explicit Match.
- Existing non-bulk matching behavior remains in force.

### Bulk transfer review

- A separate bulk transfer picker offers other open accounts when every selected row is whole, nonzero, and target-editable. Payee and ordinary Category can also be staged independently.
- Transfer choices use the shared neutral Transfer: [account] label regardless of the selected rows' signs.
- Mixed money-in/money-out rows are allowed.
- Starting balances, splits, linked/attention transfers, unavailable rows, self-transfers, and closed new destinations are excluded.
- Adding an incompatible row preserves staging but blocks Save.

- Selecting a transfer target clears staged Review, Clearance and Manual clearance while preserving staged Payee, ordinary Category, Memo and Flag.
- Review is fixed to Reviewed on confirmation, and `C` and `C*` are disabled.
- Clearing the staged target restores those controls without other staged state changes.
- `C*` reflects the saved selection.
- Saved manual-clearance overrides remain unchanged.
- Staged memo and flag changes belong to each source's confirmation and never copy to its candidate.

- Save snapshots the selected IDs and edit tokens in displayed order, clears selection/staging, and opens the existing Match comparison as a temporary queue.
- Opening, choosing candidates, and starting each item write nothing.
- The comparison shows persisted source facts and proposed target, Payee, ordinary Category, and staged metadata, including memo replacement.
- Each item loads fresh candidates with the ordinary exact-amount/date rules and selects a uniquely closest-date candidate for preview.
- Equal minimum date distances require a choice.
- The loaded source comparison remains visible with tied or zero candidates.

- Link & next atomically sets the target, preserves independent Payee and Category choices, applies staged source metadata, links the confirmed pair, and marks both visible rows Reviewed.
- Create counterpart & next uses the item’s proposed transfer account and atomically creates and connects one reciprocal manual row.
- Save unlinked & next saves and reviews the source alone.
- Skip leaves that item unchanged.
- Exit, Escape, or closing retains completed saves and drops unfinished edits.
- No-op source-only confirmations count as completed.

- Each item has its own transaction and current-context validation.
- A changed initial source snapshot or a known rejection stops that item for explicit Refresh, Skip, or Exit.
- Refresh obtains current facts and requires another confirmation.
- Never silently classify, skip, unlink, or retry a changed row.

- Skip and Exit remain available during reads and read failures.
- During a write, all queue actions and closing are disabled.
- An unknown write outcome stops writes and Skip until a successful explicit inspection.
- Exit may close with a truthful uncertainty message.
- Never count an uncertain attempt as a confirmed save or claim it stayed unchanged.
- If inspection finds the row already linked or unavailable, show that state and allow Skip/Exit without inferring which client changed it.

- Queue membership/order stay fixed through ledger refreshes.
- Account/filter navigation or disposal abandons unfinished work.
- Late responses cannot reopen or advance another view.
- Completion/Exit reports confirmed, skipped, and remaining counts, with any uncertain attempt identified.
- There is no persistent queue or automatic resume.
