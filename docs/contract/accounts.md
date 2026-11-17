# Accounts

This file is part of the [product contract](../PRODUCT_CONTRACT.md). It owns the approved requirements for the sections below.

## Account workspace

### Account rail and selection

- The account list starts with All Accounts below the brand header, without a separate visible Accounts label. The brand header shows the Weft name, a version chip (`v<version>`, followed by `dev` in development builds) and Wally, the single-color Weft moth mark. At narrow widths only the mark is visible, with the Weft accessible name. The navigation retains its accessible Accounts name. A solid 3px muted-blue divider separates the brand header from account navigation.
- The left rail shows open accounts, their type, working balance, the selected imported icon or automatic institution/account initial, and review count when relevant.
- Each account row shows its name on the first line. The second line shows its type, its review count as a small amber badge, and its right-aligned working balance.
- Account-type icons, automatic initials, imported icons and the All Accounts icon share one white rounded-square tile with a soft outline and no hard border, so every row has the same icon footprint. They follow the browser-local [Show account icons preference](register.md#presentation-preferences-and-backup-eligibility). Hiding icons does not change row height.

- The browser-local **Highlight bank differences** preference replaces the account logo/type icon with the existing amber warning triangle in normal view and prefixes the triangle to the account name in compact mode, with a pale yellow row background when the footer's Bank difference is present. It applies to open, grouped and expanded closed rows. Selected rows retain their blue background and amber triangle. Amber remains visible on hover and during sorting. The warning remains visible with account icons hidden and at narrow widths. In normal view it retains the logo slot even when account icons are hidden. Hover and accessible text give the signed difference; ordinary account navigation stays unchanged. All Accounts, group headers and collapsed sections show no aggregate warning.

- Selecting an account opens its register.
- If selection becomes invalid, the app chooses an open account first, then a closed account when none are open.

- A fixed All Accounts tile sits above the open-account list, with the same shape and selected styling, a blue-and-white piggy-bank icon when account icons are shown, Combined history on the second line, and a badge there summing Needs Review across open and closed accounts.
- It has no aggregate monetary balance and cannot be dragged or enter persisted reorder payloads.
- Selecting it shows all stored accounts, including closed accounts, in the existing ledger.
- Initial selection still chooses the first account.

- Open accounts can be reordered by hold-and-drag.
- The complete order persists atomically.

### Account groups and ordering

The open-account rail is a freely ordered mixture of individual ungrouped accounts and named group blocks.

- Each account has one optional group string. Account creation and settings offer a dropdown that accepts an existing suggested name or a new typed name. Enter selects the value into the account-form draft. Save changes persists it with the other account settings; Cancel discards it.
- Clearing the field removes the string from this account only. A change affects no other account's group value. Suggestions come from distinct nonempty saved values, including values on closed accounts. A name disappears from suggestions when no saved account uses it.
- There is no group table, independent group identity, or group-management modal. Groups have no financial type or reporting policy of their own.
- A named group's header shows a small caret, the group name, and the signed sum of its open member accounts' Working balances, right-aligned. If any member balance is unknown, the header shows PEND with an initialization explanation instead of a partial numeric total.
- The caret/name/total control expands or collapses the member rows. Collapsing changes presentation only; the account selection, member order and header total remain intact. A separate Lucide magnifying-glass button after the total opens the group ledger without toggling collapse or beginning a drag.
- Ungrouped accounts appear as individual rows with no Ungrouped header or group object. Default placement puts ungrouped rows before named groups. A user-defined order can freely interleave ungrouped rows and named group blocks; the default must not override that saved order.
- A group with one open member remains a group block. Dragging a group moves all its open members together, preserving their internal order, whether it is expanded or collapsed. Ungrouped rows move independently before, between or after group blocks. Members can be reordered within their group.
- Creating a named group places it at the bottom. Joining a group appends the account to its block. Clearing a group places the account after its former remaining block; a sole member keeps its position. New and reopened ungrouped accounts follow the leading ungrouped rows, before the first group. Reopening into a group with no open members creates a bottom block. Other accounts retain their relative order.
- The persisted order must represent each named group as one contiguous block. Reordering does not itself assign or clear a group string. Moving an account between groups uses its account settings.
- All Accounts stays fixed above this order and retains its existing Combined history behavior without an aggregate monetary balance. Closed accounts remain in their separate section and retain saved group values, outside open group totals.
- Group values and account order belong to saved financial data, are shared across browsers, and are included in full backups and restores. Bank sync, disconnection and account feed conversion preserve them.

### Group ledger

- The group magnifying-glass action opens the existing combined transaction and Scheduled ledgers for that group's current open accounts. The heading is the group name. Keep a visible selected state on its group header. All Accounts retains its broader scope, including closed transaction accounts.
- Both ledgers show the Account column and use their existing combined-view behavior. Transaction filters, paging, scope counts and full selection apply within the group on the server. The Scheduled pane includes owned schedules and computed transfer mirrors whose displayed account is a group member, under the existing pause and Look ahead rules. It does not show a combined running or Projected balance.
- Group navigation uses the existing workspace departure, draft, pending-save, history and unknown-outcome guards. Row editing and commands retain the ledger's existing server permissions and command boundaries. A group is a view, not a new account or report.
- Membership follows saved group strings and open state. Refresh the scoped reads and clear stale row selection when membership changes. Retain active drafts and in-flight saves with their real account IDs. If no open member remains, defer the ordinary fallback account until active work and recovery finish. No independent group identity or saved group-ledger record is created.
- New transaction and schedule source choices default to eligible member accounts. Transfer destinations retain their ordinary cross-account eligibility. Opening a linked transfer stays in the group when its destination remains a member; otherwise it opens that individual account.
- Export initially checks the current group's open members; users can change the modal's account selection. CSV scope remains based on the selected owning accounts. Group membership does not change transaction facts, transfer identity or reporting defaults.

### Reporting defaults

Each account stores two booleans, **Cash flow reporting** and **Net worth reporting**. Reports remain deferred.

- The booleans set default account inclusion for their future report families. Future reports can override the selection; these settings are not absolute exclusions. Changing a default does not rewrite an explicitly saved report selection.
- New and existing checking, savings, cash and credit accounts default Cash flow reporting to on. Loan accounts default it to off. Net worth reporting defaults to on for every current account type. Accounts initially have no group.
- Both choices are independent of group membership and remain editable after history or a bank feed exists. They save in the account-form draft with the other settings, persist in the database, and are included in full backups and restores.
- Bank sync and account feed conversion preserve explicit choices rather than reapplying defaults. Neither choice changes ledger visibility, categories, transfer identity, account balances, CSV export selection, schedule entry, bank activity or backup inclusion.
- No report screen, calculation, retirement-specific flag or saved-report system is added in this change. Cash-flow definitions and report inclusion formulas remain deferred.

### Account identity and type

- A local account has a nonblank, case-insensitively unique name and one basic type: checking, savings, credit, cash, or loan.
- Local creation and type-editing menus include all five types.

- `loan` is a liability label. Optional [Loan details](schedules-loans-and-transfers.md#loan-details) supply the escrow default for [Resolve difference](schedules-loans-and-transfers.md#resolve-difference); the label enables no calculations or planning.

### Account settings layout

Account creation and settings show identity and state first, then fields, then lifecycle actions.

- The header shows the logo tile and the account name. A pencil badge on the tile is **Choose logo**. A pencil button beside the name, **Rename account**, turns the name into a text field in place. The edited name joins the account-form draft. Account creation shows the name field open.
- A status strip below the header states the account's connection condition: manual, connected with its last balance update, closed, or needing repair. It shows no monetary amounts. When repair is offered, the strip holds **Repair connection**. Otherwise a closed account's strip holds **Reopen account**.
- Account group and Account type share one row. **Cash flow reporting** and **Net worth reporting** are switches.
- **Account actions** lists the available lifecycle commands as rows: Connect this account, Re-init starting balance, Disconnect bank, Close account, Reopen account when the strip does not hold it, and Delete account. Each opens its existing confirmation. The footer holds only Cancel and Save changes or Create account.

### Account logos

- New accounts use automatic initials. Prefer the connected institution name, otherwise the account name. Trim and normalize the name, strip accents from its leading letter and use A–Z with a stable name-derived color. Names without an A–Z leading letter use the account-type icon. Same-institution accounts share a tile. A manual-account rename or bank disconnection can change the automatic tile. Explicit icon selections stay unchanged.
- Account settings and creation offer **Choose logo** on the header tile. The nested searchable picker retains the account draft and owns focus, Tab, Escape and backdrop dismissal. Closing returns focus to Choose logo. Show the Automatic preview and installation-wide imported library. Search saved labels without case, spacing or punctuation differences. Keep uniform grid rows, four rows before scrolling and two-line labels with full names on hover. No institution artwork ships with the application.
- **Import icons** accepts any number of PNG, JPEG or WebP files. There is no selected-file count, combined selection-size or library count/size ceiling. Normalize each to a bounded transparent square while preserving proportions and removing metadata. Reject unsupported, animated, malformed or excessive-resolution/data images. The four-million-pixel limit and per-image processing-memory bound remain. Identical normalized images reuse a saved entry; matching filenames never replace artwork or assign accounts automatically. Filenames supply initial searchable labels only. SVG, ZIP packs, remote image retrieval and image replacement are excluded.
- Each tile shows two borderless icon buttons: a pencil, **Rename**, and a red trash can, **Remove**. Rename turns the tile label into a text field in place. Leaving the field or pressing Enter saves the shared library label, including for images used by accounts; Escape, an empty name or an unchanged name saves nothing. Remove asks for confirmation and is hidden for images used by accounts. Trim the name and require 1–80 printable characters; duplicate labels are allowed. Keep image bytes, identity and account selections unchanged. Keep a rejected rename draft available; changing the name or pressing Enter can try again through the existing command boundary. Never retry it automatically after an error. Keep the active rename tile visible during search changes. Do not close the picker while a rename draft or save is active. A close request returns focus to an unsaved draft; Escape cancels the draft. After Enter or Escape, return focus to the pencil, or Search icons if the tile is filtered out, unless focus has moved elsewhere. Cancelling account settings does not undo a saved library rename.
- Process one file at a time and show completed/total progress. **Stop import** finishes the current read/save and stops before the next file. Keep confirmed imports. Individual unreadable or rejected images produce per-file errors and do not block later files. Continue only on the named image-validation/size rejection codes. Every other command or transport error stops the selection, retains confirmed results and the account draft, and identifies the current save for inspection and later files as unstarted. Unknown outcomes require the existing inspection and fresh-read barrier; recovery never resumes or retries the import automatically. Refresh the library after processing ends.
- Import saves the shared library immediately. Explain that imported icons remain even when account settings are cancelled. A clean, unstopped single-file import selects it in the account draft; batch import leaves the selection unchanged. **Use default** restores the automatic tile. Choosing a tile changes only the draft; Save persists the choice and Cancel discards it. Save account name, type and icon atomically through the ordinary account command and its local-save confirmation policy. A saved account change still ends earlier page-session Undo history.
- **Remove** is available only for unused library images, with confirmation. The server must refuse removal while any saved account uses the image, including closed accounts. If another action removes a draft's selection, saving that stale choice must fail without persisting other account changes. Library import, rename and removal use ordinary commands, preserve ledger Undo, record save outcomes and obey the same uncertain-write inspection and awaited fresh-read barrier. They never create ledger Undo entries.
- Selected icons belong to the saved account, remain after bank disconnect and follow Show account icons in the rail. The account-settings preview remains visible while rail icons are hidden. Keep the existing bank-difference warning's precedence. Every browser reads the same library and selections; include image bytes, unassigned images and references in encrypted backup/restore. Backup-package size admission stays in the backup flow and must not impose a library ceiling on imports, startup or ordinary use. Imported images remain private installation data, outside source and static build assets. A null choice means Automatic; omitted fields preserve the current choice. New selections must reference existing library entries.

### Closing and reopening

- Local accounts can be created, renamed, closed, browsed while closed, and reopened without losing history.
- Closing a linked account asks for confirmation with Cancel, Close and disconnect, and Close and stay connected.
- Close and disconnect atomically stops only its bank feed under the ordinary disconnect rules, preserves its ledger and identity, and keeps any sibling account on the same Plaid Item syncing.
- Close and stay connected preserves its bank mapping, authorization, cursor, balances, and pending lifecycle.
- Startup, manual, and six-hour background Plaid refreshes continue on the closed account.
- Local accounts without affected schedules close directly. When schedules will pause, closing first lists those schedules and requires confirmation.
- Closing pauses schedules owned by the account and transfer schedules targeting it. Reopening skips missed occurrences and resumes at the next future date; a schedule resumes only when both transfer accounts are open.
- The sync notice review count includes open and closed accounts.
- Closed accounts remain unavailable as new transfer destinations and as candidates from another account.
- Reopening restores that eligibility.
- Changes to the current installation preserve closed state and saved initialization for linked accounts unless a reset is explicitly approved. After a separately approved reset that retains bank links, linked closed accounts use the same automatic initialization and Needs initialization/PEND presentation as linked open accounts.
- Unresolved missing-pending rows, an unfinished linked-account initialization, or a staged conversion targeting the account block either close choice without changing it.
- A failed last-Item revocation leaves it open and linked.
- If its last Item token is unreadable, stopping refreshes requires explicit Remove local connection only, then Close.
- Staying connected does not read or revoke that token.
- Reopening retains an existing connection and never reconnects a missing feed automatically.

### Deleting an account

- Account settings can delete one local or Plaid-linked account together with its complete local history, including imported transactions, without deleting any other account.
- A fresh confirmation shows the rows removed, surviving rows in other accounts whose transfer classification will change, and whether the selected account is the last mapping on its Plaid Item.
- The confirmation also lists schedules owned by or targeting the account and rules with that account condition. Deletion removes those schedules and rules atomically.
- The confirmed write rejects a stale preview, is permanent in the product, and ends page-session Undo/Redo.
- A staged conversion targeting this account blocks deletion.
- A staged conversion on its shared Plaid Item also blocks deletion of the last mapped sibling.
- Other accounts remain deletable.
- Closing remains available when the user wants to preserve history.

- Account type changes explain their blockers.
- Deletion preserves every other account's transactions and clears their links to deleted rows.
- Surviving rows targeting the deleted account lose that target, including unlinked intent and hidden originals. Preserve their Payee and ordinary Category.
- Their amount, date, description, memo, flag, and review state remain.
- Deleting the last local mapping of a Plaid Item revokes that Item before removing local custody.
- Deleting one account from a shared Item keeps the Item and sibling feed.
- Revocation failure leaves the account and feed intact.
- An unreadable local Plaid token does not make account deletion a silent local-only removal.
- The user must explicitly disconnect that feed locally first under the narrow custody-recovery rule below.

### Mapping and repairing bank connections

- Plaid onboarding can create new mapped local accounts.
- After Link returns its accounts, the final mapping step starts with each selected, lets the user uncheck any, and requires at least one selected account with a valid local name.
- It creates and later syncs only the selected local accounts.
- Unchecked accounts receive no local account or mapping.
- This Weft selection does not change the account access authorized within Plaid Link, and an already-present account should be unchecked rather than guessed from its name or last four digits.
- Account settings can instead connect one existing open local account without replacing its identity or history.

- One local account has at most one active bank feed, and one provider account maps to at most one local account.
- Account settings offers repair for an existing Plaid Item only when sync has reported a sign-in/consent or missing-mapped-account issue affecting that account.
- Healthy connections, temporary provider outages, and non-fatal transaction warnings do not show the repair action.
- Repair does not replace accounts, mappings, access tokens, or history.
- The cursor advances only through ordinary successful sync.
- A manual account can attach an unlinked provider account from an existing Plaid Item through the reviewed conversion workflow below.
- Repair itself never adds, swaps, or reconnects a mapping and never creates a duplicate Item as a fallback.

- Disconnecting a bank feed never deletes the account or its imported history.

### Uninitialized account lock

- Uninitialized Plaid-workflow accounts show **PEND** instead of an account balance.
- Their selected ledger is blurred and inert beneath an inline **Needs initialization** card.
- Ordinary totals and Bank difference are unavailable.
- Account navigation, settings, and other accounts remain usable.
- The card shows download progress or a retry path until history is complete, then **Initialize account** for balance or pending decisions.
- Local accounts retain their existing behavior.

## Account initialization

### Setup introduction

- Manual setup begins with the approved four-card introduction when its shared 14-day browser cooldown has expired or has never been set.
- Explain incomplete imported history and Starting Balance, pending amounts already included by the bank, reviewing suggested selections, and Cleared* versus bank Pending.
- Keep the approved illustrations and wording. The final comparison illustration labels the local card Your register.
- Use the existing setup Modal and Button primitives, Back/Next, four-step progress, Skip intro on every card, and Review my balance on the final card.
- Do not advance automatically.

- Finishing or skipping the introduction starts one cooldown across accounts in that browser.
- Closing or abandoning it does not.
- Skip bypasses only the explanation.
- Setup offers Explain setup to replay it without losing the balance draft, selections, or preview.
- Closing a replay returns to that setup without starting a cooldown.
- Accepted Re-init entry deliberately resets the cooldown and shows the introduction for development/testing.
- Storage failure cannot block setup.
- Automatic initialization remains uninterrupted.
- Background completion supersedes an open introduction without marking it seen.

### Initialization state and automatic admission

- Starting-balance initialization is one saved account fact, represented by its existing nullable initialization timestamp.
- Historical-import readiness is a separate account-owned fact that survives disconnection and ordinary restart.
- An empty first response is not proof of completed history.
- Initialization has no estimated-versus-confirmed state.

- After a complete successful import and current-balance update, a linked never-initialized account automatically initializes only when its current balance is valid and present, it has no active provider-pending or unresolved missing-pending rows, and its starting-balance state is consistent.
- Zero is a valid balance.
- Zero net pending is not zero pending rows, and C* rows remain provider-pending.
- Use complete account facts independent of displayed labels, filtering, or pagination.
- Save its one starting balance as bank current minus every visible cleared contribution except the system baseline and set initialized state atomically.
- Never silently repair or duplicate a conflicting baseline.
- No pending C* is inferred or written on this automatic path.

### Automatic completion

- Automatic initialization needs no dialog or confirmation.
- Update the rail and remove the selected ledger lock without a reload or account change, restore sensible focus, and announce readiness to assistive technology for that selected account only.
- Later successful syncs may initialize previously unfinished accounts after pending uncertainty clears.
- New pending activity or a later Bank difference never relocks or automatically rebases an initialized account.

### Manual balance entry

- Manual initialization reuses the shared account-owned Modal, Button composition, money/date formatting, and established styling.
- Entry resolves the existing ledger-work guard.
- After the introduction, show the account, signed current-balance field suggested from Plaid when available, and fetch time first.
- Continue reveals the full pending checklist and inline preview in the same modal.
- Credit and loan accounts explain negative debt.
- With complete history but missing bank current, manual balance entry remains available.
- An empty pending checklist needs no selection.

### Pending selections and suggestions

- Ask **Which pending transactions are already included in this balance?**
- Show all eligible active pending parents with full date, description, and signed amount.
- Share their underlying eligibility with ordinary manual clearance while keeping that ordinary command unavailable before initialization.
- Existing C* flags start selected.
- A supported available-balance hypothesis may suggest additional selections only after an exact signed-cents search proves a unique set of transaction IDs.
- For bank current B, all relevant pending Q, and available funds W (available credit minus limit for cards), the target is B + Q − W.
- Require complete compatible fields, no missing-pending uncertainty, and a user reference equal to the stored current balance.
- Loans, disconnected accounts, missing data, more than 32 candidates, no match, and ambiguous solutions fall back to manual choice.
- Zero-sum alternatives and duplicate amounts remain distinct solutions.
- Show the reference used, call the result a suggestion, and require review and Save.
- Uniqueness is not proof of bank inclusion.
- Never rerun suggestions over user edits or silently apply pending C*.

### Missing-pending resolution during setup

- Unresolved missing-pending rows block finishing setup and offer the existing resolution workflow.
- Preserve the setup draft while temporarily replacing its modal.
- The existing choose-from-ledger route may temporarily unblur a read-only candidate picker with totals suppressed and only resolution-related actions available.
- Return to the preserved draft with fresh account facts.
- Unresolved rows continue to block Save.

### Starting-balance preview and calculation

- A server-calculated preview automatically shows Starting balance, Cleared, Uncleared, and Working when the pending checklist opens after recommendations settle, and refreshes on each checkbox change.
- Show before/after for an existing initialized account.
- Keep checkboxes usable during calculation, discard superseded responses, and enable **Save Starting Balance** only for a successful preview of the exact current draft.
- There is no separate Preview action.
- Highlight the Starting balance row with a rounded blue border and pale blue background.
- Before totals are unavailable for first setup.
- Let B be the user reference, C the contribution of every visible cleared row except the system baseline and active provider-pending rows, and M the selected eligible pending contribution.
- Create or replace the one baseline with B − C − M and save the exact selected C* flags and initialized state atomically.
- Hidden matched sources, excluded or missing rows, and other-account transfer partners do not enter C or M independently of their visible parent.

### Save validation and competing initialization

- Preview and Save bind initialization state, all relevant bank facts, complete projected rows and their edit tokens, the reference, and exact selection.
- Draft edits invalidate the previous preview for saving and request fresh totals automatically.
- Keep the last successful amounts visible during recalculation and keep the card and columns stationary.
- Announce updates accessibly without inserting visible loading text into the layout.
- Changed snapshots reject atomically before mutation.
- Cancel saves no draft baseline or flags.
- Saving freezes controls and dismissal.
- Inspect uncertain outcomes through a fresh read before another deliberate Save.
- Never replay automatically.
- If background initialization wins while manual setup is open, show the saved result and explain completion.
- Never silently convert its stale first-setup Save into Re-init.
- If manual Save wins, sync must preserve that baseline.

### Re-init and preserved facts

- Account settings offers **Re-init** for an initialized Plaid-workflow account.
- Existing unsaved-settings and ledger guards apply.
- Replace settings rather than nesting dialogs.
- Re-init always shows an automatic before/after preview and requires Save Starting Balance, including with no pending.
- Opening it does not clear initialized state, reset cursors, or change saved data.
- Preserve history, metadata, review, matches, transfers, connections, and the saved baseline until a successful explicit correction.

- Initialization and Re-init do not change provider balances/fetch time, provider lifecycle, review state, matching relationships, hidden sources, or transfer partners.
- A fresher entered balance may leave Bank difference against cached Plaid.
- Ordinary backend ledger commands and cross-account transfer commands enforce the unfinished-account boundary.
- Dedicated pending resolution remains available.
- Transaction-only CSV export does not require an account balance.

### Initialization through installation changes

- Normal restarts and changes to the current installation preserve initialization, history readiness, transactions, starting balances and provider cursors unless a reset is explicitly approved.
- Reimport or Re-init must not silently replace saved financial history.
- If a separately approved destructive reset retains bank links but clears history, fresh background import automatically initializes eligible retained accounts and leaves the rest PEND. Its confirmation must state that loss before execution.
- The current account-deletion rule applies to retained accounts and disconnected partial imports.
- Close is available after linked-account initialization or explicit disconnection.

## Account feed conversion

### Choosing a bank account

- Account settings offers **Connect this account** for an open account without an active feed.
- The user chooses an existing Plaid connection, identified by institution and linked local accounts, or a new bank login.
- Weft never infers Item identity from account names, masks, or institution alone.
- On an existing Item, currently authorized unmapped bank accounts are offered, and Link update mode with Account Select can request a missing account.
- The user must keep already-linked sibling accounts selected.
- If access to one is lost, the conversion stops and names it.
- After authentication or choosing an existing connection, the user chooses exactly one bank account and sees its institution, name, mask, type, currency, and current balance when available.
- A known incompatible account type, duplicate mapping, or non-USD currency blocks the connection.
- Missing currency warns without blocking.
- Closed accounts must be reopened first.

### Staged download and resumption

- Connection downloads up to 730 days of available provider history into one durable, resumable staged attempt.
- Staging creates no live transaction, payee, category assignment, match, account mapping, balance, or ledger side effect.
- After **Download history**, the account-selection dialog stays in place with a spinning **Downloading…** button, explains that Plaid history may take several minutes, and opens the matching review automatically when ready.
- Selection and bank-access controls are locked during this first download, but the user may close the dialog after staging and resume later.
- A failed or timed-out download offers **Refresh** of the existing attempt, never a second staging request.
- A new-login attempt pauses when complete review becomes available.
- An existing-Item attempt replays the Item's transaction stream from an independent empty cursor and stages only the selected account's rows.
- It offers review without treating Item-level history completion as proof that the added account is complete.
- The account remains usable while review is open and ordinary sibling sync continues on its own Item-wide cursor.
- Explicit **Refresh** checks for later rows.
- At most one conversion attempt may exist application-wide.
- Leaving the workflow preserves that attempt for **Resume bank connection**.
- Starting another conversion requires the user to resume the existing attempt or explicitly abandon it.
- Abandonment revokes an otherwise unused new staged Item, but deletes only the attempt for an already-linked Item and cannot undo a completed bank permission change.
- Provider confirmation that a new staged Item is already absent counts as successful revocation.
- Other revocation failures leave that attempt resumable and block a replacement attempt.

### Review eligibility

- After the complete available history arrives, one review groups the result as **Ready to match**, **Needs a choice**, **New from the bank**, **Kept from your history**, and **Pending at the bank**.
- A posted pair qualifies for preselection when it has the same signed amount, is within four calendar days, has no relationship blocker, and is one deterministic edge after considering the complete nearby candidate set.
- A null payee on either side is not a conflict, while different populated canonical payees remain manual.
- Field-value differences with deterministic default ownership do not create balance ambiguity and remain Ready with the differing fields highlighted.
- Repeated equal-amount/payee rows may be assigned internally in date order only for edges that have no equal-distance alternative.
- A tie demotes only the affected rows, not an entire chained amount component.
- Pending rows never qualify for preselection.
- No proposed match applies before **Connect account**.

### Review decisions and field ownership

- Every **Ready to match** proposal starts accepted.
- Each Ready bank row's status mark toggles its proposal between accepted and unresolved, a bucket-level checkbox controls the complete server-side set, and the interface states how many accepted proposals will apply at commit.
- Comparing a Ready pair is only for inspection or saving different field ownership.
- **Needs a choice** contains every other posted feed/history edge with the same signed amount within seven calendar days that touches no Ready row: unique pairs five to seven days apart, different populated canonical payees, equal-distance alternatives, and relationship conflicts.
- An alternative edge of a Ready row is not a Needs a choice row.
- It appears only as a labeled candidate when either of its rows is selected.
- Each affected edge is resolved one pair at a time.
- An otherwise valid pair may be accepted or marked **Keep separately**.
- A relationship-blocked pair explains the conflict, disables acceptance, and offers **Keep separately** or return-to-ledger correction.
- An unchecked safe proposal remains unresolved rather than becoming a dismissal.
- Only rows participating in an unresolved candidate edge block, so one ambiguous edge never demotes an otherwise deterministic edge in the same amount component.
- Pending candidates remain optional matches. When undecided pending overlap remains, Connect account requires one acknowledgement for the complete set.
- The acknowledgement shows its count and signed amount and explains that separate retained and bank-pending rows can immediately count twice in Working. It does not record Keep separately decisions or dismissals.
- The user can resolve the overlap later through explicit Find match.
- Every blocking posted edge must end as an accepted pair or an explicit keep-separate decision before connection.
- Existing history remains the default owner of user metadata, splits, review state, and transfer anchors when current matching policy permits it.
- **New from the bank** rows enter Needs review by default and offer one explicit complete-count bulk action to mark the imported history Reviewed.

### Review buckets and navigation

- Retain all available provider history, including rows older than the prior manual ledger, and retain all manual history.
- The review has no **Older than your history** exclusion bucket and no mixed-unit **Everything** bucket.
- Outcome rows remain in stable review buckets while their staged decision state changes.
- Rail progress and the footer report remaining decisions without moving the active row.
- **New from the bank** holds posted bank rows outside Ready and Needs a choice.
- **Kept from your history** holds history rows outside Ready, Needs a choice, and pending candidacy.
- Rail counts are rows in one unit per bucket, bank rows except Kept's history rows, and a separate open count names the bank rows that still have an undecided posted edge.
- Selecting a row never filters either register: the selected row's candidates are highlighted, other rows dim, candidates outside the active bucket appear with their bucket named, clicking a highlighted row compares that pair, and clicking a dimmed row starts a new selection.
- Every bank row shows one status mark: needs a choice, blocked by a relationship conflict, matched, imports as new, or pending at the bank.
- A history row shows a matched mark only while an accepted pair uses it.
- Accepting a pair whose bank or history row is already accepted elsewhere replaces that earlier pair.

### Required bank balance and final preview

- A present, valid, sign-normalized Plaid Current Balance is required for review and connection.
- The matching workbench is the single final preview.
- There is no second balance-confirmation screen.
- It shows the provider fetch time.
- The prior and re-anchored Starting Balance.
- The running balance immediately before and after the oldest retained pre-connection history row of any origin other than the system baseline.
- Current and after-connection Cleared, Uncleared, and Working balances.
- And complete counts for matched, **New from the bank**, **Kept from your history**, bank-pending rows, and undecided pending candidates.
- After-connection Cleared equals Plaid Current Balance by construction, so equality is an asserted invariant rather than an independent confidence signal.
- The prior and re-anchored Starting Balance and the history-seam balances expose what the re-anchoring absorbed.
- Provider-pending and other uncleared activity affect Working separately.
- Missing current balance, unresolved posted possible duplicates, an inconsistent or out-of-range baseline calculation, or a stale preview blocks connection.
- The **Connect account** action stays disabled while review decisions are refreshing so it cannot submit an old preview token.
- Incomplete history also blocks a new-Item conversion.
- An existing-Item conversion instead requires an explicit late-history acknowledgement because Item-level completion cannot establish completeness for the newly added account.
- The acknowledgement sits visibly beside **Connect account** and explains that older rows may arrive later, require matching, and leave a Bank difference until the user reviews them and explicitly uses Re-init.
- Weft never automatically rebases.
- If a shared-Item review has no posted bank rows but a nonzero bank balance, warn that history may not have arrived yet and recommend Refresh before connecting without forbidding a legitimate empty-history account.

### Final catch-up and connection commit

- **Connect account** performs one serialized final bank catch-up and commits the reviewed snapshot atomically only when no material review fact changed.
- A failed final check leaves the attempt reviewable.
- Changed rows or balance require refreshed review.
- It preserves account ID, name, type, order, all bank and manual history, Payees, transfer targets, metadata, splits, review state, and transfer links.
- Materializes accepted and keep-separate decisions.
- Activates the feed.
- And stores current readiness, cursor, and balances.
- For an existing Item, its ordinary Item-wide cursor and sibling mappings remain untouched by staged replay and local account-row filtering.
- It creates or updates exactly one system Starting Balance dated one day before the oldest transaction in the projected review history and staged bank rows, retaining an existing baseline date when both are empty.
- A hidden original or excluded bank row later revealed may precede this baseline, as late older shared-Item history already may.
- Its amount equals sign-normalized Plaid Current Balance minus every other visible cleared contribution in the committed projection.
- It never creates a second baseline.
- Connection is outside Undo and ends the page's earlier history.

### Retained historical overlap

- Existing rows become historical feed-overlap data on connection.
- Their saved status remains intact and they do not become planned unmatched rows merely because the feed is active.
- Only manual rows created or moved into the account after connection are planned entries eligible for ordinary future automatic matching.
- Moving an eligible Uncleared manual row into an actively connected account clears any prior feed-history marker before assigning Unmatched status.
- Historical overlap never qualifies for ordinary automatic matching.
- Explicit Find match can combine one live, non-historical Plaid row with historical Manual or Plaid history in the same account with the same signed amount. Nearby dates means seven days; All dates removes that date limit.
- Two live Plaid rows remain under pending-lifecycle rules.
- Historical accepted pairs can be superseded without nesting pairs. Preserve effective user fields, splits, review, and transfer anchors, and retire the replaced bank side as hidden superseded history.

### Disconnect confirmation

- Account settings offers **Disconnect bank**.
- With no bank-pending uncertainty, confirmation says that refresh will stop, live bank balance will disappear and an automatic tile will use the account name; a selected icon stays, and all history and user work will remain.
- Active ordinary pending rows freeze as clearable detached-bank Uncleared history.
- Manually cleared pending rows freeze as detached-bank Cleared history.
- Unresolved missing-pending rows must be settled before disconnection.

### Disconnection and unreadable-token recovery

- Disconnect atomically deactivates the feed, clears live provider balance and fetch time, removes obsolete unaccepted suggestions, retains accepted matches, dismissals, exclusions, provenance, transfer anchors, and user metadata, and returns the account to local workflow.
- Provider-owned identity, date, amount, and description remain immutable.
- A standalone frozen detached-bank row gains local Clear and Unclear controls, including after the account reconnects. Matching, exclusion, or provider identity reactivation ends those standalone controls.
- Imported rows retain Plaid source and do not gain Delete or provider-field editing. Retained accepted pairs can be inspected and unmatched while disconnected.
- If the account is the last mapping on an Item, revoke the Item before deleting local custody, except that an active shared-Item conversion first requires abandonment.
- A revoke failure leaves the feed connected and reports the error.
- Only when the locally stored token cannot be decrypted may the user explicitly choose **Remove local connection only** after a warning that Weft cannot revoke bank access and they should revoke it at the bank.
- The server rechecks unreadability.
- A readable token requires normal revocation and a last-mapping staged conversion still blocks removal.
- The same pending-transaction and history-preservation rules apply, and removing the last mapping deletes its unreadable local Item in the same transaction.

### Returning provider identities

- Reconnecting later repeats the staged overlap review.
- A bank transaction with the same provider transaction ID as a retained active, excluded, or previously removed row in that account is the same row: it is updated and reactivated in place, not duplicated or offered as a separate match.
- Returning excluded rows remain excluded.
- Returned removed rows become visible again, and the preview counts only visible rows.
- A posted provider row naming a retained pending predecessor is the same lifecycle even when its amount or date changed. Connection updates the retained local row in place, preserves effective user metadata and transfer anchors, applies existing split-difference and review rules, and displays the provider changes in review. Linked predecessor IDs receive the same account-ownership checks as returning transaction IDs.
- If both identities of an accepted pair return, reactivate the bank side first, keep the original hidden under that pair, and count only the bank side. Ordinary sync preserves a hidden original's live accepted parent.
- If a returning identity is the hidden original of an accepted pair with a retired bank side, make the current provider row visible and retire the stale side while preserving effective user fields and transfer anchors. Preview and commit must count the same visible contribution.
- With no direct posted identity, an existing current-feed predecessor can update in place without pending resolution.
- Ordinary sync must not send detached or non-pending history into pending-lifecycle resolution. If a posted row has no direct retained identity, it can reactivate its detached predecessor in place. A distinct direct identity takes precedence and leaves detached predecessor history intact; it does not block a later connection.
- Multiple live staged rows claiming the same retained identity stop review with `conversion_bank_identity_conflict`. Refresh the review or abandon the attempt; the connection remains unchanged. Staged posted replacements retire pending predecessors regardless of event order.
- A staged ID already owned by a different local account stops staging and names that account so the user can reopen and reconnect it.
- If a superseded bank transaction ID returns in the same account and its replacement belongs to a retired feed, the connection review reactivates the returning provider row and retires the replacement. Preserve effective user fields, splits, review and exclusion state, and transfer anchors. Preview and commit must count one visible transaction contribution and must not nest accepted pairs.
- Otherwise, a superseded bank ID remains omitted from review and connection. The final preview counts these omitted rows and explains that their replacement entries remain unchanged.
- A new Item's account identity alone never proves equality with retained provider rows.
- Accepting a new feed row against a retained accepted pair replaces the old bank side in place and retires it as hidden superseded history.
- It never nests matches or gives one row two active relations.

### Snapshot validation and outcome inspection

- Review and commit are bound to the exact account, provider, payee-rule/default, transaction, match, exclusion, and transfer snapshot.
- Changed facts make the preview stale and require refresh.
- A definite provider failure preserves the review without triggering the unknown-save barrier.
- A genuinely unknown commit outcome requires status inspection before retry and is never replayed automatically.
