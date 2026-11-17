# Schedules, loans and transfers

This file is part of the [product contract](../PRODUCT_CONTRACT.md). It owns the approved requirements for the sections below.

## Scheduled transactions

### Pane and interaction

- The pane sits below the account register and its balance/action footer, separated by a resize grip. The footer stays next to the rows it totals.
- The pane's top action row has the schedule count and a down chevron that hides the pane. Hidden, the pane collapses to one bar the same height as that action row, showing **Scheduled · N** and an up chevron that shows the pane again; the grip is not shown.
- In both expanded and collapsed action bars, a **Look ahead: Off** button sits immediately left of Scheduled Transactions. Its action menu offers **Off**, **End of month**, **4 weeks**, and **12 weeks**, with the current choice checked. The button keeps one width for every choice. The menu is a square panel in the action-bar color, attached flush to the button's column and matching its width, with action-bar item text and hover. It is not the shared combobox or row-menu popover. Support arrow/Home/End navigation, Enter/Space selection, Escape with focus return, and Tab or outside dismissal under the existing workspace guards.
- Look ahead defaults to Off. Remember its choice separately for each account and All Accounts in the browser, alongside pane visibility and height. It survives reload when storage works, falls back to Off otherwise, and is separate from database backup.
- Look ahead keeps every normal next-occurrence row, including dates beyond the chosen window. Add read-only preview occurrences later than both today and that schedule's next date, through the inclusive cutoff. End of month ends on the backend host's current month's last day; 4 weeks and 12 weeks end 28 and 84 days after its current local date. Use the saved recurrence anchor, stored amount and inclusive end date. Once and paused schedules produce no previews. Today and overdue catch-up occurrences remain the responsibility of ordinary due entry.
- Sort preview occurrences among normal rows by canonical ascending chronology, using their displayed date and schedule ID, with paused definitions still last. The schedule count excludes previews and retains its normal treatment of transfer mirrors. Transfer mirrors receive the same preview dates and opposite amounts under their existing visibility rules.
- Give each preview row a subtle full-row tint and one plain Lucide Ghost icon in place of Enter/Skip, with accessible preview text and no button styling. Preserve readable text and signed amounts; mirror previews retain mirror italics. A preview's plain transfer marker identifies its direction and account on hover and for assistive technology. Preview rows have no selection, editor, schedule menu, interactive transfer popover or command-row keyboard stop. Clicking one follows the existing blank-space editor-departure rule. Native browser context menus remain available.
- Preview occurrences are computed from the current schedule definitions. Editing, entering or skipping a schedule refreshes them. They create no saved rows, affect no actual ledger balance and cannot be entered, skipped or edited. The optional deterministic Projected balance below includes their scheduled amounts; other forecasting and what-if planning remain excluded.
- Dragging the grip divides register and pane height within their minimums. Double-clicking it toggles the pane; keyboard controls remain available.
- Browser-local visibility and pane height are remembered separately for each account and for All Accounts. Switching views restores that view's preferences; they survive reload when storage works and fall back to visible at the default height otherwise. Make recurring saves the visible state only for the view where it opens the draft. These preferences are separate from database backup.
- The pane uses the register's table, 27-pixel rows, cell editors, editing-row treatment and action-row styling. Columns are Frequency, Next date, End date, Payee, Category, Memo, the register's amount layout (Amount, or Outflow and Inflow), a **+/- Match** column immediately after Amount (or Inflow in the separate layout), the optional [Projected balance](#projected-balance), and row actions. Sort by canonical ascending chronology using Next date and schedule ID, with paused rows pinned to the bottom and mirror ties after their owner. End date shows the inclusive end date or a stub. All Accounts adds Account and lists schedules owned by open accounts, including transfers paused by a closed target. A selected closed account can still show its paused schedules.
- A transfer schedule belongs to the account where it was created and posts both sides. The other account's pane, and All Accounts, also show a read-only mirror row computed from it: opposite sign, the stored Payee with the owning account as its transfer target, same frequency and dates. Mirror rows are never stored, posted, or edited; their row menu offers only **Go to schedule in <owning account>**. A mirror row is hidden while its schedule is paused.
- Saving a transfer schedule that matches an existing one between the same two accounts with the opposite signed amount shows a warning that both schedules post both sides and will likely count the transfer twice in each account. The check includes paused schedules even though their mirrors are hidden. The user can cancel or save anyway.
- **Paused display:** a closed account's pane shows one gray Paused label over its rows instead of per-row markers, with **Reopen account to resume; missed dates are skipped.** The label is visual only; Edit and Delete remain available. In an open account, a transfer schedule paused by its closed target shows a Paused marker in Next date, with the reason and skipped date on hover.
- **New Scheduled** in the pane's top action row matches the main register's New Transaction button width and opens an inline draft using the existing register pickers. All Accounts first asks for an eligible open account. As in the register, the first plain row click selects it; a subsequent click on the selected owner row edits it. Right-click opens its row menu. Mirrors remain read-only. Editing applies to the whole series; Enter in a text/amount field or the explicit Save action saves. The Actions cell holds the shared ✓ Save and ✕ Cancel controls. New drafts follow [new-entry exit behavior](account-workflows.md#new-entry-exit-behavior); Escape or Cancel on a saved schedule edit retains its direct discard rule. Row actions are **Enter this occurrence**, **Skip this occurrence**, Edit, **Send to account**, and Delete, with confirmation for deletion. **Send to account** opens a right-click flyout listing only valid destination accounts for that schedule. Choosing an account moves the schedule for unentered occurrences; transactions already entered stay in their original accounts. The action column shows the enter and skip actions as [raised](register.md#stateful-and-specialized-controls) icon buttons (arrow up from a dot, and the same icon flipped); the row menu holds these actions.
- The inline schedule Payee picker offers the same Edit and Create actions as transaction entry. Create saves and selects the Payee without saving the schedule; canceling the schedule retains the Payee. Edit follows the schedule draft's departure guard before opening Payees with that identity selected. An unchanged saved schedule closes without a write; a changed saved schedule saves first. A new schedule keeps its explicit completion guard. A failed or uncertain outcome retains its draft and blocks the opening. Closing Payees returns focus to the saved schedule row when it remains available.
- **New Transfer** sits immediately after New Scheduled and before the pane collapse control. It creates the same inline schedule draft with tomorrow’s date, monthly recurrence and no target, Payee, Category or amount assigned, then immediately opens the transfer-target picker. In All Accounts it first opens the existing inline Account selector, limited to accounts with eligible destinations; pointer, Enter or Tab selection opens the target picker afterward. Enter or Tab after target selection focuses Payee. Escape from Account closes only that popup. Either New control resumes an existing draft without changing its intent; conditional keyboard return targets the initiating control. New Transfer is unavailable with an explanation when no eligible source-destination pair exists. Existing new-entry guards, save/recovery behavior and scheduled-transfer semantics remain unchanged.
- Schedule drafts, writes, and recovery share register workflow guards. New drafts use [new-entry exit behavior](account-workflows.md#new-entry-exit-behavior) before account/filter navigation, other editors and dialogs. Clicking outside an unchanged saved schedule editor closes it without a write and allows the clicked action to continue. Changed saved schedule edits save through [existing-row departure](account-workflows.md#existing-row-departure). Other saved-action workflows retain their admission guards. Unknown outcomes require recorded-outcome inspection and fresh schedule/register/account reads before another deliberate write. Never replay automatically.
- If a refresh removes the schedule being edited, its draft and Save/Cancel controls remain visible. Save rejects the stale schedule; Cancel releases the draft guard.

- Persisted schedule rows use one roving tab stop with Up/Down navigation, including paused rows and mirrors. Their enabled action buttons retain ordinary tab stops. Context Menu or Shift+F10 on a row or its button opens the same guarded menu. Enter on an owner row opens editing; Enter on a mirror requests navigation to its owner. Editors retain native field menus and key ownership. Composition and repeated shortcut keys do not activate another command.
- Schedule menus use the transaction menu’s initial focus, disabled-item explanation and Tab/Escape rules. They return focus to the invoking row or action button. Skip is immediate and undoable without another confirmation.

### Scheduled multiselect

- The Scheduled pane supports the register's plain-click, Cmd/Ctrl-click and Shift-click selection behavior. A second plain click edits only a singly selected owner; clicking a member of a multi-selection first selects it alone. That click targets the clicked cell as in the [register](register.md#row-context-menu-and-focus). Clicking an empty End date leaves it empty. The schedule editor's default opening focus is the first editable field. Cmd/Ctrl+A inside the pane selects all saved owner definitions, without a separate full-query expansion. Native text editing, open pickers/menus, composition and held-key guards retain ownership.
- Modifier, range and select-all gestures skip read-only transfer mirrors and preview occurrences. A plain click can still select a mirror alone for Go to schedule. Never resolve a mirror to an owner for a batch write. Selection uses stable identities and displayed order; previews do not create occurrence targets.
- Selecting two or more owners shows a compact multi-editor in the register's selection area above the transaction register, so opening it never moves Scheduled rows. It offers Payee, Category, Memo, Save, Enter this occurrence, Skip this occurrence, Send to account and Cancel. Each field starts at Leave unchanged. Payee cannot be cleared; Category can explicitly clear. Empty Memo leaves existing memos unchanged; replacement never appends or clears and confirms differing nonempty memos. Dates, frequency, amount, +/- Match and transfer targets remain individual edits. Applying a real Payee retains the existing paused-schedule resume/skip-missed behavior and explains it before save.
- Register and Scheduled selections are exclusive. Starting a selection in either surface clears the other's unstaged selection, so the selection area shows one editor. The footer Selected total remains register-only. Unstaged Scheduled selection blocks nothing. Staged fields block conflicting row actions, editing and workflows through the shared schedule guard until Save or Cancel. While fields are staged, register rows and the footer are inert and the selection area remains usable. Adding/removing selected owners preserves staging while at least one remains. A single remaining owner hides field controls but retains staged Save/Cancel and recovery controls. Toolbar controls wrap at narrow widths, and the schedule rows remain reachable through scrolling at the minimum pane height. A collapsed Scheduled pane hides its editor.
- Batch Enter/Skip acts on exactly one current saved next occurrence per selected owner, with its saved date, including future dates. Never enter or skip previews or an entire Look ahead range. Both actions validate all selected tokens and permissions before mutations and commit atomically. A stale, paused or otherwise ineligible member rejects the whole batch with feedback. Enter materializes every occurrence and reciprocal transfer pair before one matching pass. Each successful batch is one logical Undo step under the existing bounded history policy; batch Skip adds no confirmation.
- Send to account offers only destinations common to every selected definition. Exclude all selected source accounts and transfer targets, closed accounts and accounts needing initialization. The server revalidates every definition against the chosen destination. Retain the duplicate-transfer warning. A successful Send moves only unentered occurrences; already-entered transactions remain intact. Batch metadata Save and Send preserve prior history under the existing schedule-edit policy.
- Enter, Skip and Send require staged fields to be saved or cancelled first. Context menus on selected owners retain the multi-selection and use the same batch commands. Unstaged individual action buttons remain single-row actions. Successful individual Enter/Skip/Send/Delete actions remove only their own owner from selection.
- Clear a successful batch's selection and staging, refresh schedules/accounts/register and Projected values, report the count, and keep the current view without jumping to entered rows. Known rejection retains selection and staging. An uncertain result freezes them and requires recorded-outcome inspection and fresh reads before another deliberate write; never retry automatically.
- Same-view refreshes prune removed/out-of-scope selections without adding new arrivals and preserve membership through reordering and Look ahead changes. Account/group navigation and Cancel clear selection. Existing editor-departure, pending-save, history and recovery guards remain in force.

### Projected balance

- Below a divider, the Look ahead menu contains a **Projected balance** item with a compact switch styled like the System settings switches. Toggling it keeps the menu open. It defaults to off and is remembered per account in the browser, independently from the main register Balance preference. Look ahead Off hides the column and disables the switch with an explanation while retaining its saved choice. All Accounts and accounts needing initialization have no projected balance.
- When enabled for one initialized account and a finite Look ahead period, place the **Projected** column after **+/- Match** and before Actions in both amount layouts. Its right-aligned header has no information icon; the same one-sentence explanation is available through its hover title and screen-reader description. Detailed calculation notes belong in user documentation, not the header. Show no value on draft, paused, non-enterable or beyond-window rows. Normal next-occurrence rows beyond the window remain visible. Ghost tint remains independent of balance presentation.
- Each value is the working-balance projection immediately after that dated occurrence. Merge complete visible entered ledger contributions and enterable unentered scheduled occurrences in canonical ascending chronology. Within the same date and direction, entered facts precede scheduled assumptions; IDs provide stable ties within each kind. Starting balance remains first on its date. Include future entered rows on their dates, not in an opening Working total. Missing pending, excluded and hidden duplicate contributions follow the main ledger's balance policy.
- Include each owned or mirrored occurrence once for the selected account, with its own signed amount. Use saved amounts, recurrence anchors and inclusive end dates. Include still-unentered due and catch-up occurrences on their dates, even while ordinary due entry has not run or an existing entry error remains. Do not add an overdue mode or change due execution. Paused and currently non-enterable definitions neither contribute nor show values.
- Compute the supported 84-day range in the schedule GET using one database snapshot and one read-local time. Always compute it for an initialized single-account read, independent from browser presentation choices. Narrowing the browser cutoff filters previews and blanks later balances without refetching or changing earlier values. The response contains both schedule rows and their balances; the browser does not combine separate account and schedule reads to calculate money.
- Refresh after confirmed register/schedule saves, entry, skip, deletion, moves, matching, Undo/Redo and observed provider or due-entry changes. Unsaved keystrokes never recalculate balances. Retain confirmed values until an authoritative snapshot replaces them; blank values during monetary writes or recovery. Existing polling and refresh define when external changes become visible.
- Entered future transactions can change a projected balance without a visible Scheduled row. A bank payment can count alongside an unentered schedule until Enter this occurrence and existing matching/correction resolve it. Do not infer links, suppress occurrences by resemblance or duplicate matching policy. Entering an unchanged occurrence preserves later dated totals; same-day intermediate values can change when it moves into the entered-fact tie group.
- Current Scheduled rows retain canonical date order with paused definitions last. This feature adds no column sorting. If Scheduled sorting is added, apply the main register's balance-emphasis policy: Date-primary ascending or exact descending reversal stays full strength; another primary sort uses readable muted values and an accessible explanation without recomputing them.
- This is a deterministic projection of recorded facts and saved schedules. It adds no guessed spending, amount ranges, floors, alerts, budgets or what-if scenarios.

### Definition and eligibility

- A schedule stores its account, required real Payee, optional tracked-account transfer target, optional ordinary Category, memo, signed amount, nonnegative dollar matching tolerance, next date, frequency, and optional inclusive end date. Ordinary and transfer schedules are supported; splits and flags are excluded. Existing schedules marked Unknown Payee cannot enter until corrected.
- Accounts needing initialization cannot own schedules or be transfer targets. New schedules use open eligible accounts. Closing pauses existing schedules rather than making new destinations available.
- Creation or a changed next date must be at least one calendar day after the backend host's current local date. Today and past dates are rejected. Unchanged saved dates can become due and retain catch-up behavior. The end date cannot precede the next date.
- Frequencies are Once, daily, weekly, every other week, every 4 weeks, monthly, every other month, every 3 months, every 4 months, twice a year, yearly, and every other year. Every other week means fourteen days. Twice a month and custom two-day selectors are excluded; use two separate monthly schedules for two fixed days.
- Month-based frequencies retain their anchor day. Short months clamp to their last day; later months return to the anchor day. Yearly February 29 follows this rule. Changing the next date resets the anchor day; unrelated edits preserve it.
- Make recurring defaults to monthly with the source row's anchor day and the first occurrence after both today and the source date. A July 5 row used on October 3 starts October 5. A future-dated source is not entered twice.
- Category choices follow ordinary assignment. A transfer target requires a nonzero amount and a different eligible account. A saved schedule uses its explicit categorization rather than applying Payee defaults at entry.
- Occurrences receive generated nonblank descriptions from the selected Payee's current name. Both sides of an entered transfer pair use the schedule's one stored Payee and remain independently editable afterward. Occurrence entry enforces the same Payee requirement as ordinary manual creation and does not teach directional Payee memory. Entered manual rows retain generated Description internally; users cannot author or edit it.

### Entry and lifecycle

- Automatic due entry enters every live occurrence on or before the backend's current local date as its own manual row with the scheduled date, stored amount and memo, Uncleared state, and Needs review. Missed occurrences are all entered after downtime.
- An existing definition marked Unknown Payee is paused without creating rows or advancing its next date. Enter and Skip are unavailable; Edit and Delete remain available. Choosing a real Payee resumes it and skips missed occurrences through today, as reopening a closed account does. Other valid definitions continue to enter.
- A transfer occurrence atomically creates one reciprocal linked pair through the transfer owner. The generated counterpart starts Needs review. The owning side follows the entry mode below. Both use guarded bank/manual matching after the pair exists. Existing user-confirmed counterpart creation remains Reviewed and suggestion-only at creation.
- **+/- Match** defaults to 0 (exact). It uses Amount's text filtering, currency parsing, two-decimal precision, Enter save and Escape cancellation. Reject negative or unsafe values. A nonzero tolerance requires a nonzero schedule amount. Transfer schedules accept a tolerance for the owner's side; mirrors display 0 and name the owner account that carries it. The column follows the amount columns in both layouts and All Accounts.
- Occurrences copy the schedule tolerance onto each newly entered owner-side manual row before matching; a scheduled transfer's counterpart starts at 0. Both arrival orders use the same matcher. Editing or deleting a schedule does not change entered rows or future estimates automatically. New schedules, Make recurring, Duplicate and all rows retained through the revision-28 upgrade start at zero. A change to an entered row's amount, account, Payee or transfer target clears its tolerance through every command path; date, memo and Category changes retain it. No main-ledger tolerance editor is provided.
- Exact-amount matching retains its existing Payee-independent, deterministic mutual-closest policy. Unequal matching admits only a live manual row with a positive frozen tolerance and a live bank row in the same account, with the same nonzero direction and effective real Payee. The absolute difference must be at most the frozen tolerance. The bank row cannot have a transfer partner, and its target must be empty or the manual row's target. A linked manual row qualifies only when its partner can take a [linked amount correction](#unlinking-and-target-lifecycle). Accepting such a match, automatically or explicitly, sets the partner to the opposite of the bank amount and clears its tolerance in the same command. A user Unmatch returns that partner to the opposite of the manual amount when it still holds the opposite bank amount and still qualifies. Later bank corrections, replacement, expiry and removal never change the partner; disagreement shows attention. Historical matching, account conversion and cross-account transfer linking remain exact-only.
- Build the complete nearby seven-day pool. Non-dismissed exact edges reserve both endpoints before tolerant selection. Tolerant selection requires exactly one non-dismissed admitted tolerant edge at both endpoints, counting competition before excluding endpoints reserved by exact edges. Payee mismatches do not compete. Do not peel tolerant edges iteratively. Existing rejected pairs and Unmatch holds remain in force. Ambiguous tolerant candidates get neither automatic acceptance nor a suggestion; Find match can still inspect an individually eligible pair.
- A selected tolerant pair at most six days apart can match automatically. At seven days or under suggestion-only admission, use the existing suggested-match review and retain it across later reconciliation. Find match and explicit acceptance use the same amount/Payee/direction/transfer admission; All dates removes only the date limit. Comparisons explain the amount difference and frozen tolerance. If the manual row was later split, preserve its original allocations and use the existing Bank difference handling to balance the accepted bank row; automatic split differences remain Needs review. Bank date, amount and status remain authoritative. Never update a schedule estimate or replace an accepted pair automatically when another candidate arrives.
- Entered unmatched planned rows follow existing Plaid pinning. Outside the entered tolerance, different amounts still require correction of the manual row or its deletion. Enter this occurrence and its resulting match form one undoable command; provider-sync matching stays outside page-session Undo and retains Unmatch.
- Enter this occurrence enters only the next occurrence immediately, with its scheduled date, then advances. Explicit single and batch Enter start each schedule's owning transaction Reviewed; a generated transfer counterpart remains Needs review. Existing matching review inheritance applies in both arrival orders, including when a bank row already exists. Later lifecycle review resets remain unchanged. Skip this occurrence advances without creating rows. Neither modifies earlier occurrences. A schedule affects no actual ledger balance until entry; entered rows count under ordinary ledger rules. The optional [Projected balance](#projected-balance) includes still-unentered occurrences.
- Entry or Skip deletes a schedule when no occurrence remains within its inclusive end date. Once ends after one entry or skip. The pane contains live definitions, not a permanent occurrence log.
- Closed source or target accounts pause entry. Paused schedules show the Paused display above, and the enter and skip actions are unavailable. Reopening skips occurrences through today and resumes at a future date only when both accounts are open. Editing a paused transfer to an open target also skips missed closed-period occurrences.
- Account deletion removes schedules owned by or targeting it and lists them in its stale-checked preview. Category archive/deletion and payee deletion use their management rules above.
- Due dates can be today while waiting for the tick or earlier while paused or catching up. The pane has no special due or overdue state.

### Background timing and persistence

- Entry runs first inside the existing serialized sync runner, at startup and every six hours, before provider sync. Today is the backend host's local date; normal entry occurs within about six hours after local midnight.
- Entry runs without configured Plaid credentials or Items. Manual and scoped syncs can invoke it without duplicates.
- Entry has its own database session and transaction; its failure cannot roll back successful sync, and sync failure cannot roll back entered rows. Failed entry remains eligible for a later tick and gets an actionable notice. No occurrence advances without its rows committing.
- Background entry uses the shared command write reservation and commit/rollback boundary without invented page-session metadata. It does not create user Undo steps or end unrelated history. Existing dependency checks apply.
- Entry stays within the job runner lock and stopping/maintenance checks so backup restore pauses it. No second worker or process is added.

## Loan accounts

### Loan details

- A `loan` account can save Loan details: kind (mortgage, student or other) and the escrow amount collected with each payment. Escrow covers property taxes and homeowners insurance; zero means none. Details are edited from account settings or requested by Resolve difference. Changing the account type requires removing them first; deleting the account removes them.
- Loan details store no principal, interest rate, payment schedule or payment history.

### Resolve difference

- On a loan account, the footer Bank difference warning opens Resolve difference, a compact panel at the lower-right corner of the register above its footer. Without Loan details, the panel asks for them first and then continues.
- Bank difference is Cleared minus the bank's current balance. A positive difference D proposes one charge of −D dated today (the server's local date) in that account. Escrow defaults to the saved escrow amount, capped at D with a note, and is editable for this charge between zero and D; Interest is the rest. The Escrow field appears for a mortgage or a nonzero saved escrow. The panel shows the account, charge, date, Payee, missing categories and bank balance update time.
- Save creates one ordinary manual transaction: cleared and reviewed. Its Payee is the effective Payee of the account's latest visible ledger row by date and ID, excluding Starting Balance; when that Payee cannot be assigned to a manual transaction, the panel explains instead of choosing an older one. One nonzero part uses a single category; two use a split. Categories are the active, unambiguous Debt:Interest & Fees and Debt:Escrow; a missing one saves as No category and the panel says so.
- A zero or negative difference, a missing bank balance, an uninitialized account or a missing Payee shows an explanation and no charge.
- Save rechecks that the difference is unchanged and forms one Undo step. Saving offers bank matches only as suggestions, so the charge stays Cleared and the difference becomes zero. Afterwards the charge is an ordinary transaction with no loan-specific rules. Weft never posts a charge automatically.
- Saving Loan details preserves page history; they affect no ledger rows.
- In a combined scope, each loan account's warning names its account and resolves that account's whole difference.
- Loans have no principal tracking, amortization, rate estimates or escrow disbursement tracking.

## Account transfers

### Transfer target and eligibility

- A transfer target is a tracked account stored separately from the required Payee. There is no External Account target. A payment to an untracked vendor or lender is an ordinary transaction; movement to an untracked own account can use Myself Payee without a target.
- Transfer choices read `Transfer: [account]` in a separate picker. The sign of the source amount determines money direction; selecting a target does not change the amount, Payee or Category.
- New target choices list other open eligible accounts. Closed historical targets remain readable, filterable and eligible to finish existing intent under ordinary guards.
- Transfers remain whole, unsplit, nonzero, non-starting transactions. Self-transfers and transfer split allocations are unavailable.
- Category supports an independent active ordinary subcategory or No category on either sign. A blank category is valid on a transfer. Do not block inflows, show ghost categories or mirror categories. Reports own account/direction inclusion and misleading net-zero handling; ledger filters, selected totals and CSV use actual row facts.

### Pickers, display and proposal behavior

- Individual, bulk and schedule editors place a transfer-target button beside the Payee picker. It opens a transfer-only combobox with eligible account choices; Payee contains actual counterparties in one alphabetical list. Category retains ordinary categories, No category and its normal Split action when the row is not a transfer.
- Read-only ledger rows show a right-aligned ArrowRightLeft button in the Payee cell only when a transfer target is assigned and the [Transfer column](register.md) is hidden; while it is shown, its cell is the trigger and carries the attention reasons. Its anchored popover explains the target and linked or unlinked state. A linked row offers Jump To and confirmed Unlink; an unlinked row is informational. Schedule rows with a target use the same button and popover: an owned schedule offers confirmed Remove, which clears its target and keeps Payee and Category, and a mirror row offers Go to schedule. The existing Link2 connection inspection and matching modal remain. The transfer icon exposes target and state to assistive technology.
- A fresh New Transfer opens the target picker after source account selection. Enter or Tab after choosing a target advances to Payee. New Transaction keeps its current keyboard advance and skips the transfer control; a dedicated shortcut opens it. Selecting a target counts as draft work. If no eligible source-destination pair exists, New Transfer is disabled with an explanation. In All Accounts, source choices for New Transfer must each have an eligible destination.
- Target selection stages only the target. Explicit Save or Enter with a complete nonzero draft opens the existing transfer proposal carrying the full source draft, including Payee and explicit ordinary Category. This applies to new entries and changed saved targets. Cancel restores the intact draft.
- Link, Create counterpart or Save unlinked is the only commit point for a new or changed target. Ordinary create and edit commands refuse those target assignments without review. Payee, Category and other metadata edits that retain a saved target use ordinary ledger commands. A linked row can edit Payee independently; changing its target requires Unlink first. A linked manual amount can change only as a [linked amount correction](#unlinking-and-target-lifecycle). An unlinked row can Clear transfer, retaining Payee and Category.
- Explicit zero saves retaining a target refuse with Transfers require a nonzero amount and preserve the draft/data. Ordinary zero transactions remain allowed after clearing a target. Provider amount corrections retain Payee and Category; incompatible target/link state shows Needs review under the existing lifecycle rules.
- Selecting an existing target keeps an existing Payee, including an imported Payee. A new transfer has no default Payee on first use. A later user-opened draft can receive the saved directional Payee suggestion described below. Unknown Payee must be replaced before an affected transaction edit saves.

### Directional Payee suggestions

- Each confirmed user choice on a saved transfer can teach its Payee for that source account, target account and amount direction. Each account side and reverse direction has separate memory. For a draft dated D, propose the latest eligible saved choice dated on or before D. Do not propose Unknown Payee. There is no initial default.
- Before a new transaction or schedule has an amount sign, an available outflow memory can appear provisionally after target selection. Entering an inflow replaces that untouched suggestion with the inflow memory or clears it if none exists. An explicit Payee choice is never replaced.
- Successful new or edited transaction saves teach memory. Confirmed bulk target or Payee assignments teach each affected transfer row, as does confirmed counterpart creation. Metadata-only bulk saves, imports, automatic links and entered schedule occurrences do not teach. Clearing a target or deleting the contributing row removes that suggestion. Undo/Redo rewinds and reapplies the suggestion with its saved transaction when allowed.
- A created counterpart uses a Payee explicitly chosen in its review, then the counterpart account side's directional suggestion, then the source Payee. The review shows the proposed Payee before creation, including single-row creation from a saved target. Explicit Link confirms the displayed real counterpart Payee for its account side and direction even when unchanged. Later Payee edits on either linked side remain independent.

### Transfer finder and candidates

- Find transfer is available for one or more eligible whole, visible, unlinked, nonzero parents that are not starting balances or missing pending, including rows without transfer classification.
- A classified row searches only its saved destination, including a closed historical destination.
- An unclassified row searches every other open account, consistent with the prohibition on new classifications to closed accounts.
- Exact opposite amounts within seven calendar days appear as individual transaction buttons showing account, date, description, and amount.
- All-dates removes only the date restriction.
- Results are ordered across eligible accounts by date distance, date, then visible ID.
- A uniquely closest-date candidate is selected for preview and determines its destination.
- Equal minimum date distances leave the candidate unselected.
- Date and visible ID break display-order ties only.
- Selecting a candidate keeps the other finder candidates available, including those in other accounts.
- This preview rule also applies to destination-specific saved, proposed, and draft transfers.

- All candidates must be whole, visible, unlinked, non-starting, not missing pending, and free of a conflicting transfer destination.
- Hidden manual originals are excluded and accepted bank/manual entries appear once.
- Selecting a candidate determines the proposed destination and previews reciprocal targets while preserving each Payee and ordinary Category without writing.

### Confirmation and commit

- Explicit cross-account linking uses the existing Match field-by-field comparison table, sharing its renderer, alignment, spacing, and dialog width. Automatic linking follows the rules below.
- Date-range controls precede the candidate results.
- The columns label account and money direction and show the resulting values directly, without before-and-after arrows.
- Only target changes are highlighted as link changes. The initiating transaction is read-only in the modal, including any existing source draft. The target column supports explicit Payee, single ordinary Category or No category, and Memo edits under the target's own permissions and effective ownership. Existing candidates retain untouched metadata; target edits never copy source metadata or synchronize sides. Description, date, amount and status stay read-only.
- The loaded source column always shows its account, date, description, amount, and remaining comparison fields, including when there are tied or zero candidates.
- Until selection, the other column shows its known destination or an unselected counterpart heading. New counterpart mode shows the actual generated date, opposite amount, directional Description, proposed Payee, No category, empty Memo and Uncleared status. An existing candidate and a new counterpart are distinct modes; only the displayed mode's Link or Create action can commit.
- Linking existing rows atomically saves explicit target metadata edits and reciprocal targets, marks both visible rows Reviewed, and preserves each amount, date, Description, clearance and balance. Untouched target metadata stays unchanged. The edits and Payee memory confirmation share the link's Undo step.
- It does not automatically accept bank/manual matches.

- Link, Create counterpart, or Save unlinked is the only commit point and atomically saves the proposed source draft/classification/metadata with its named result.
- If the source already has a target account, Create counterpart uses that saved destination directly, including a closed historical destination. Do not ask the owner to select the same account again.
- Unclassified rows offer Choose counterpart account… before creation, with a visible Choose the counterpart account prompt and other open accounts. Selecting an account prepares the proposal; Create counterpart then confirms creation.
- Account selection only fills the preview.
- Confirmed creation makes exactly one opposite-amount manual row with source date, reciprocal target, the reviewed counterpart Payee, explicitly selected Category or No category, generated directional Description, explicitly entered Memo or empty Memo, and approved and uncleared state. Payee defaults never fill the target Category.
- Connects it, marks the source Reviewed, changes destination Working only, and may refresh suggestions without accepting them.
- Cancel and Skip leave the source unchanged. Target drafts stay local until Link or Create. Candidate, destination and mode switches cannot carry edits to another transaction. Dirty discard actions require inline confirmation. Reads and paging preserve the current target draft. Stale/unknown outcomes require authoritative inspection and never automatically replay edits.

### Repeated creation and outcome inspection

- Repeated creation requests while already linked return the existing connection.
- Unknown write outcomes require successful fresh context inspection before retry.
- No automatic write replay is allowed.
- Commands reserve the writer, validate current tokens and both visible groups, and commit atomically.

### Bank/manual matching and transfer evidence

- Bank/manual matching remains distinct from cross-account linking.
- Both unaccepted entries count.
- Accepted pairs project/count once.
- Unmatch restores separate counting.
- Suggested transfer pairs explicitly explain the possible duplicate and that both count.

- Manual/bank automatic acceptance follows the six-day matching rule above. A compatible whole manual transfer may be linked or unlinked. Neither payee equality nor independent PFC is required for that same-account identity decision.

### Incremental automatic transfer discovery

- After lifecycle and manual matching settle, consider whole existing visible rows in initialized accounts with complete downloads. Opposite nonzero cents, at most six calendar days and mutual uniquely closest dates across a seven-day neighborhood are required. Include all structurally eligible amount/date competitors before applying evidence; filters, paging and weaker PFC never create false uniqueness.
- A saved destination on either side must be compatible with the opposite account. Payee rules do not create destinations on new imports. Ordinary transfer assignments and accepted matches can supply a saved destination. Without a saved destination, require two-sided compatible PFC transfer/payment labels, known equal feed currencies and no category-based refusal. Card-payment evidence uses both actual account types.
- Exclude missing pending, excluded, detached/historical conversion, starting-balance, split and already-linked rows, and closed new destinations. Do not infer two sides from amount alone or create counterparts.
- Apply balances and initialization before discovery. Initialization completion and successful empty syncs revisit eligible neighborhoods. Later account imports can link earlier stored history by transaction dates, regardless of age relative to today.
- Materialize reciprocal targets once; preserve each Payee, amount, date, description, ordinary Category, memo, clearance and review state. Record automatic origin and guarded before/applied classification values. Automatic linking does not teach directional Payee memory.
- The existing transfer dialog explains automatic origin and Unlink restoration. Unlink rejects the pair for automation and restores only unchanged automatic target writes and target ownership. Payee and Category remain independent. Preserve later edits and invalid/deleted references with Needs review. Explicit Link can override rejection.
- No currency conversion, transfer-search button or separate historical sweep is added. Automatic linking never changes amounts.

### Anchors, field ownership and pending lifecycle

- A connection stays anchored to the original record that carried it before bank/manual acceptance.
- The visible bank row can display a manual original's connection.
- Unmatch reveals that manual with its connection.
- A connection newly created on an already-matched visible bank belongs to the bank, which must store its own target without changing Payee or ordinary Category even if effective values already agree.
- Only one source in an accepted group may own a partner.
- Removed links never reappear after Unmatch.

- Bank/manual comparison and pending resolution choose Payee and target ownership independently; Category keeps its independent ordinary source choice. Without review, retain a sole or agreed target. Conflicting targets require review. A source that owns a transfer partner fixes the target to that partner's account, including during pending continuation and anchor rehoming.
- Unresolved conflicting targets block automatic combination; explicit comparison can choose the target. Competing partners or a split on either effective input block combination until corrected.
- Other existing field choices remain.
- Context tokens include transfer state and source ownership.

- Active pending transfers are allowed.
- In-place posting keeps the connection.
- Separate-record resolution retains both provider identities, makes the posted representative visible and rehomes a bank-owned pending anchor atomically.
- A manual original's anchor stays on that manual.
- Preserve the existing copy-before-source-reset mechanism and real conflict checks.
- Posting never creates another counterpart.

### Missing pending and queue behavior

- Missing pending rows show attention under the existing visibility/balance rules.
- Confirmed disappearance detaches a link owned by the deleted bank row and leaves the other account's row unlinked.
- A surviving manual original retains its own connection and reappears, as after Unmatch.
- Preview that distinction.
- Grace expiry uses current projection.
- Unavailable bank partners remain explained.
- Never automatically delete or recreate a counterpart.

- Find transfer is distinct from bank/manual Match.
- Multi-selection uses the same proposal as a per-item queue in displayed order with Link & next, Create counterpart & next, Save unlinked & next, Skip, and Exit.
- Confirmed items remain committed when the queue exits.
- Linked rows offer Inspect connections… and Go to other account. Unlink is confirmed inside connection inspection. Navigation and reveal refresh use the same connection read to locate the current counterpart, without loading transfer candidates.
- Navigation resolves the partner's current visible ID, clears destination filters, loads required history, and reveals without editing. Scroll only the register to center the partner and use the same two-second fading wash or reduced-motion edge as saved-row follow.
- Failed or obsolete reads stop.
- Unavailable partners keep Go to other account disabled with an explanation.

### Unlinking and target lifecycle

- Explicitly created links retain their classifications on Unlink. Automatic links restore unchanged automatic classifications under the guarded restoration rule above. Both record a negative decision for automation.
- Changing a linked target or moving a linked entry requires Unlink first. Payee and ordinary Category edits do not require Unlink and do not change transfer identity or the counterpart.
- **Linked amount correction:** a visible unmatched, non-historical manual row can change its amount when its reciprocal partner is also an unmatched, non-historical manual row. One edit command writes the opposite amount to the partner, clears both tolerances, keeps each side's date, Payee, Category, Memo, clearance and review, and forms one Undo step. Otherwise amount changes require Unlink first.
- Deleting an eligible manual entry removes its link and retains the other account's entry.
- Bank amount corrections retain bank values and flag disagreement using current visible amounts.
- Apart from the linked amount correction and tolerant-match partner update, the other side is never synchronized.

- Fresh databases create the three protected system Payees. Account creation needs no transfer Payee.
- Account deletion clears the deleted target on all surviving stored incoming rows, including hidden originals, while preserving Payee and ordinary Category. The preview counts rows that lose transfer classification. Delete rules with that account condition and schedules owned by or targeting it; no suggestion for the deleted relationship remains.
