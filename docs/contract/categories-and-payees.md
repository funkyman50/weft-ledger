# Categories and payees

This file is part of the [product contract](../PRODUCT_CONTRACT.md). It owns the approved requirements for the sections below.

## Categories

### Hierarchy and assignment

- Categories use exactly two levels: a parent category contains subcategories.
- Ordinary assignment requires an active subcategory under an active parent.
- Transfer destinations use separate tracked-account targets under the account-transfer rules below; Payee and Category remain independent.

- Uncategorized remains a valid transaction state.
- Empty parents are allowed but remain unavailable for assignment until they have a subcategory.

### Management and search

- One master–detail modal creates, searches, renames, moves, archives, restores, and deletes parents and subcategories.
- Names are case-insensitively unique among parents or within one parent's children.

- Both panes show active A–Z followed by archived A–Z.
- Search matches a case-insensitive substring anywhere and includes clearly labeled archived results.
- Category row actions use the shared compact action menu. Arrow keys and Home/End move between commands. Escape closes only the menu and returns focus to its trigger; Tab dismisses it and continues within the dialog.

### Spending classification and starter data

- Subcategories store Discretionary (true), Non-discretionary (false), or Not applicable (null).
- All three choices save immediately through the row control for active subcategories under active parents.
- New subcategories default to Not applicable.
- Parents have no classification.
- Renaming, moving, archiving, and restoring preserve the saved value.

- Fresh databases receive the checked-in generic starter list: 17 categories and 65 subcategories. Project and earnings labels contain no installation-specific names or job numbering.
- Seeds behave like user-created categories.
- Ordinary restarts and changes to the current installation preserve edits, deletions, classifications and assignments unless a reset is explicitly approved. Do not reapply starter data to an existing register. Changes to the starter file never rename, recreate, delete or reclassify saved categories or change their assignments.
- A separately approved destructive reset must state whether it restores the starter list and which saved categories it discards.
- Uncategorized remains separate from the discretionary Miscellaneous: Misc. subcategory.

### Archive and deletion

- Archiving a parent temporarily makes its branch unavailable without changing each child's archive state.
- Existing transactions retain and display archived assignments.
- Archiving a category clears its assignment from schedules. Archiving a parent clears schedule assignments to all its children. Those schedules remain active and enter Uncategorized until explicitly reassigned; payee defaults do not refill the cleared assignment.

- Every deletion requires confirmation. Rules setting the category or any child of a deleted parent block deletion; list those rules in the confirmation.
- Deleting a used subcategory or an entire parent branch atomically moves all affected transactions and schedules to one explicitly chosen active subcategory or to Uncategorized before deleting the source. The confirmation reports schedule usage separately.

- Archived ordinary items expose only Restore and Delete.
- There is no separate merge action.
- Deletion with reassignment is the ordinary consolidation flow.

### Search consistency

- Payee and category searches use the same case-insensitive substring-anywhere behavior throughout the register and management surfaces.
- Payee and Category checkbox-filter search narrows option labels by substring. Applied choices match exact identities. Qualified subcategories remain distinct even when another parent has a child with the same name.

## Payees

### Payee identity

- Payees identify the actual counterparty across differing descriptions. Transfer destination is a separate optional tracked-account assignment on a transaction or schedule.
- Every saved transaction and schedule has a Payee. Myself is a protected selectable Payee for the user, including movement to an untracked own account. It appears in the Payees workbench list for assigned-transaction and rule workflows. Starting Balance is protected and used only for starting-balance rows. Unknown Payee is a protected marker for unresolved saved records, including references retained after explicit Payee deletion; it is unavailable for new entries and rules, and an affected saved row must receive a real Payee before an edit can save. Schedules marked Unknown Payee cannot enter occurrences until corrected. Protected system Payees cannot be renamed or deleted, and Delete unused payees excludes them.
- They are global, with trimmed display names and casefolded unique keys.
- Internal spaces and punctuation remain literal.
- Automatic reuse preserves existing display spelling.
- There are no conglomerate groups, aliases, or allocation-level payees.

### First-import assignment

- On a Plaid row's first import, evaluate the global ordered rules against account ID, signed amount, nonblank original_description or required name, and merchant_name. The first match assigns its Payee and optional Category. Transfer classification uses the ordinary transfer workflows and provider evidence. A missing or archived rule Category falls back to the effective Payee's active default on ordinary rows, then Uncategorized.
- Without a matching rule Payee, reuse/create nonblank merchant_name or name as fallback. Trim the fallback and cut it to its first 35 characters. Equal resulting names reuse one Payee. If neither provider field supplies a usable Payee and no rule does, roll back the affected Plaid Item without advancing its cursor. Show an actionable sync notice directing the owner to add a Payee rule scoped by account or amount and retry. Staged account conversion exposes the missing Payee before commit and refuses that conversion until corrected. Unknown Payee is never assigned to a new import.
- Do not assign an existing payee by approximate name similarity. Automatic fuzzy payee assignment is outside scope.
- Initialize assignment before reconciliation. Preserve the full original description and provider payload independently. Sticky entry categories never affect imports.

### Display and assignment preservation

- The register Payee column shows only the first 35 characters, with a plain cutoff and no full-name hover text. Stored names, searching and sorting remain complete.
- Assignment is stored once. Provider modifications, in-place posting, moves and rule changes retain existing Payee and transfer-target assignments. Rules never run again merely because a pending row posts.
- Pending review and automatic pending-to-posted continuity prefer a real posted Payee when the pending Payee is Unknown or Starting Balance. Preserve all other default fields and explicit source choices; do not change matching eligibility.
- Distinct pending/posted identities retain the existing conflict and inference guards. Different rule results do not authorize overwriting user metadata or guessing through a conflict. Use explicit historical assignment to correct existing payees.

### Manual creation and picker creation

- Manual creation and editing require a saved real Payee for both ordinary and transfer transactions. Omitted or explicit null Payee refuses a save. Manual entry does not accept Description or offer Automatic from rules. Stored descriptions remain available to matching and historical rule evaluation.
- Starting balances use Starting Balance Payee. Myself is selectable in entry and Rules, with no default-category or remembered-category controls. Starting Balance and Unknown Payee have no ordinary rename/delete, default, remembered-category, suggestion or rule-result controls.
- The composer distinguishes an unfilled Payee draft from a selected identity; No payee is not a selectable option.
- A Payee picker offers explicit creation for a nonblank, locally nonduplicate trimmed search. It saves/selects the identity without saving the transaction or creating a rule. Cancelling the transaction retains the payee.
- With an empty search and a selected payee, the ordinary/new-row picker offers **Edit** followed by the payee’s name, such as **Edit Apple**. An exact trimmed, case-insensitive search match offers Edit for that identity instead of disabled Create. Edit opens the Payees window with that payee selected through the existing ledger entry guard; search alone never changes the transaction assignment. With empty search and no selected identity, hide this action. Nonblank nonduplicate search retains Create.
- Picker Edit uses the ordinary editor departure guard. A changed saved ordinary edit saves before Payees opens; an unchanged edit closes without a write. A dirty new or split entry retains its explicit completion guard. Recovery, an obsolete entry or a later focus move cancels the deferred opening. Closing Payees returns to the persisted transaction row and reveals it, or the register if unavailable, while preserving a later deliberate focus move. Long Edit labels expose the full action and payee name in a tooltip.
- Enter selects the active existing result and never creates a payee. Opening with an empty search does not activate the first payee.
- Picker creation follows identity-conflict and unknown-outcome recovery rules. Completion only patches its originating unchanged edit.

### Manager and identity conflicts

- The payee window has Payees and All Rules tabs. It opens in Payees and does not persist the last tab. Payees has three columns: a fixed 240px payee list, then the payee column and the transaction column splitting the rest evenly. All Rules splits 60/40 between the ordered list and the transaction check. The ordinary/new-row payee picker also opens this window through its Edit action, preselected to that payee.
- Payees creates, renames, searches and deletes unused ordinary Payees. Names sort A–Z. Duplicate create/rename reports the existing identity, including a collision with a protected system Payee name. Case-only rename is allowed. Rename changes labels globally and creates no rule or suggestions; fallback imports can recreate the former name.
- New payee fills the list footer. When any ordinary Payee has no displayed transactions or saved schedules, a full-width danger **Delete unused payees** button appears as a separate row directly beneath it. Payee search does not narrow the cleanup set; All Rules does not show the button. Existing busy and recovery guards disable it. Payee transactions, All transactions and conditional Schedules provide transaction history and saved schedule assignments. Rename, Replace and Delete are compact actions for an ordinary Payee; Delete uses danger styling and retains its confirmation. A list row whose ordinary Payee has no displayed transactions and no saved schedules also offers a danger trash action that selects it and opens the same confirmation. The payee column shows the default Category, then the Payee's rules with global numbers and a New rule action, then the editor for the selected or new rule.
- While no rule is open, the payee column footer offers See all rules in order, which switches to All Rules. While a rule is open, that footer holds Cancel and Save rule with the note that saving can also apply the rule to matching transactions. The transaction column keeps its own footer.

### Default category

- The selected payee offers an optional Default Category, initially No Default. Only an active ordinary subcategory can be selected.
- A saved archived default remains visible as unavailable and dormant. Category deletion clears the default without adopting the deletion destination.

### Default admission and explicit assignments

- Server defaults fill only untouched uncategorized effective parents: no category, no explicit assignment, no allocations and no transfer target. Existing-transaction commands also require category editing permission.
- Apply defaults on first Plaid import, including before account initialization, and ordinary bulk payee changes without explicit categorization. Single-row editors send their displayed categorization; backend save-time fallback must not fill a different value.
- Explicit No category, categories and splits win. Defaults use the ordinary category writer and mark the category assigned. Later default changes, posting, provider updates and unrelated edits do not recategorize those rows.
- Explicit Rules-mode historical application is the separate overwrite exception below.

### Sticky entry category

- Selecting Payee fills Category immediately from its active default, then its remembered category from individual ledger entry/editing, then empty. This memory is global per payee and survives page reload. It is not derived from transaction dates or imports.
- Autofill runs only when Category is empty and unassigned, or still contains an untouched autofill. Protect a user's category choice, explicit No category, loaded assigned categories, splits and transfers. Changing Payee replaces an untouched autofill with the new payee's value. Assigning a transfer target removes an untouched Payee autofill and leaves an explicit Category unchanged.
- Use this behavior in new manual transactions, Payee changes on eligible existing ordinary rows and new schedule drafts. A fresh New Transfer opens the transfer-target picker immediately and receives no Payee default autofill. Schedules save the displayed Category; occurrences use the stored Category without a later lookup.
- Successful individual ledger choices or accepted autofills of active ordinary single categories remember the category for the effective payee. A user edit can concern a Plaid row. Explicit No category resets the remembered category and streak. An untouched blank category stays unassigned and neither teaches nor resets memory. Split and transfer saves leave memory unchanged. Automatic imports, bulk assignment, rule application, schedule management/occurrences and Undo/Redo do not teach or count uses.
- Keyboard Payee acceptance advances to Category with the value filled and popup closed. Tab retains that value; typing uses existing type-to-open replacement. Pointer selection keeps the shared picker's existing focus behavior. Save commits the displayed value, omitting categorization for an untouched blank. Return changed memory with the saved outcome and update the payee cache before allowing another entry. Cancel does not teach memory.
- Archived remembered categories are dormant; category deletion clears the memory. Memory is a preference and is not rewound by ledger Undo.

### Applying a changed default to history

- When eligible history exists, a changed default offers Save default only or Save and update N transactions, plus Cancel. Otherwise save directly. Use the shared compact confirmation presentation.
- N covers eligible full-history effective parents across accounts, independent of search/selection. Accepted history assignments and the default save are atomic and reject stale baselines/targets.
- Clearing No Default never clears transaction categories. Default drafts share dirty, leave and recovery guards.

### Third-assignment default suggestion

- After a successful individual ledger save that chooses or accepts an active ordinary single category, offer to make it the payee default after three consecutive uses of that category for that payee. Keeping an autofilled category when saving counts as acceptance; merely displaying it does not.
- Count distinct effective parent rows. Repeated edits to one row cannot inflate evidence. A different category or explicit No category resets that payee's streak. Other payees' choices do not interrupt it.
- Splits, transfers, excluded/missing/starting rows do not count. Reads, imports, bulk operations, schedule management/occurrences, unchanged saves and Undo/Redo do not trigger prompts.
- The payee must have no configured default or prior dismissal. Explicit default saves suppress future suggestions. Manual configuration remains available.
- Wait for the saved write/refresh and conflicting workflows to finish. Merely opening an unchanged existing row does not defer the prompt. Discard stale candidates; advisory lookup errors never fail the saved transaction.
- Cancel closes the suggestion without changing the payee. Offer Cancel, Save default only and Save and update N. Load eligible-history targets before enabling the update action, use those exact targets atomically, and disable it when N is zero.

### Deleting a payee

- Delete requires confirmation and no default-register displayed transaction or saved schedule using the Payee, across every account including closed accounts. Search, account filters, editability and schedule look-ahead never narrow eligibility. Show separate displayed-transaction and saved-schedule blockers.
- Confirmed Delete reassigns only stored transaction references to the deleted identity. A retained reference with a verified active representative takes that transaction's effective Payee. A reference with no such representative becomes Unknown Payee. Resolve same-account membership with the ledger projection; a replacement pointer endpoint alone is not proof of visibility. A still-visible missing-pending row can block deletion. Starting Balance records and protected source identities cannot be deleted through this workflow.
- Preserve displayed Payees, balances, transactions, amounts, dates, categories, splits, descriptions, memos, review/clearance, flags, field ownership, transfer targets/partners and provider facts. Clear the tolerance of a changed manual reference. Do not rerun rules, apply defaults, reconcile relationships or create transaction records. Later separation keeps the reassigned Payee; it cannot recover the deliberately deleted identity. Restored/returning records can show Unknown and require a real Payee before ordinary editing.
- Owned rules do not block deletion. List and remove them atomically with the Payee. Disclose counts of records following a displayed Payee and becoming Unknown, rule removal and permanent loss of the identity on later separation. Full affected-record details remain available but collapsed by default. Cancel changes nothing. Do not automatically merge, suppress or garbage-collect identities.
- Delete unused payees previews every ordinary Payee with zero displayed transactions and zero saved schedules, independently of Payee search. Rule-owning and intentionally prepared unused Payees remain eligible for this explicit command; list their names and owned rules before confirmation. The button shows an available candidate count, never an unavailable count as zero. Protected Payees are excluded.
- Single and batch eligibility, reference destinations and tokens use one read-local time. Bind the complete candidate set, names, preferences, references, effective destination Payees, blockers and owned rules before any mutation. A changed plan rejects the entire command. Resolve references before deleting identities. The exact confirmed batch is applied atomically; no cleanup runs during imports, sync or other automated work.
- Saved deletion invalidates earlier ledger Undo and records its ordinary persistent completion. Unknown outcomes require inspection and fresh reads without automatic replay. Remove deleted IDs from lookups, clear a deleted selected Payee and retain surviving selections. Refresh Payees, rules and dependent views; a failed refresh after confirmed deletion blocks further work until fresh reads succeed.

### Reference inspection and replacement

- Complete Delete/Replace previews keep saved originals together under a verified active representative. A group includes only records reached by that representative's same-account explicit Payee assignment. Show each record as one compact history-style row with its saved description, plain reason (ledger transaction, matched entry, earlier bank version, excluded import, removed by bank, missing pending, expired pending), account, date, amount and the Payee it will take. A record without an active representative is described as not shown in the ledger and, for Delete, becomes Unknown Payee. Schedules remain distinct rows. Supporting records are not additional purchases.
- Page complete groups and schedule definitions 100 at a time. Counts and confirmation tokens cover the complete set before paging. A changed token while paging resets to the first page for fresh review. Keep group membership and expanded-source snapshots in full confirmation tokens even though hidden transaction rows have no management tab.
- Payees offers Payee transactions, All transactions, conditional Schedules and temporary Matches rule. Schedules appears only when the selected Payee's global saved schedule count is known and positive. It includes every saved definition, including closed accounts and outside look-ahead, without transaction search/account filters. Opening or changing tabs never writes data. Hidden transaction assignments are resolved only by explicit Delete or global Replace, not by a source-only editor.
- Schedules uses compact rows with saved Payee, shared recurrence label, memo, amount, account and next date. It provides Select displayed, an off-page selected count, a destination Payee picker with no preselection and Assign selected. Keep its selection separate from transaction/rule selection. Payee or complete schedule-token changes clear ticks; unchanged paging and destination changes keep them. A sent assignment and successful recovery clear ticks. Unavailable reads/counts are loading/error states, not zero.
- Schedule assignment requires distinct assignable source/destination Payees and selected saved definition IDs bound to the complete schedule token. Reject stale scope, missing IDs or invalid identities before any mutation. Change only the selected definitions' Payee values. Preserve every other field, never advance recurrence or enter occurrences, and leave past entered rows unchanged. Use one ordinary captured Undo step and recorded-outcome recovery. Schedule tokens cannot authorize Delete/Replace.
- If Schedules becomes empty while selected, return to the remembered transaction tab. Restore focus when disappearing controls lose it, without overriding a later deliberate focus move. Do not infer emptiness from loading/errors. Ordinary Payee transaction history is neither automatically queried nor explicitly refetched while Schedules is selected. During recovery, refresh Payees before selected-Payee schedule reads and skip a deleted source.
- Replace this payee everywhere requires two distinct ordinary Payees and explicit confirmation. Preview every stored transaction reference, schedules and source-owned rules. Retarget those rules to the destination without changing their conditions, category results, IDs or global order. Keep the destination's default, remembered category and suggestion preferences; disclose removal of the source's preferences. Protected Payees cannot be replaced or used as replacement destinations.
- Replace every transaction and schedule reference to the source, including hidden, removed, excluded and retired records, then remove its identity in one ordinary command. Clear changed manual transaction match tolerances; preserve schedule tolerance. Preserve categories, splits, amounts, dates, review, transfer targets/links, field ownership and bank facts. Do not apply defaults or reconcile pairs. Unrelated Payees and unused Payees remain unchanged.
- Bind confirmation to exact current reference membership, relevant saved facts, owned rules and both Payees' preferences. Reject stale confirmation before any change. Replacement is not undoable and ends earlier ledger Undo history. Record its persistent completion atomically and use ordinary unknown-outcome inspection; never replay automatically.
- After confirmed replacement, select the destination, clear obsolete Payee/rule selections and refresh ledger, reference and schedule reads. Map source filter IDs to the destination in both include and exclude Payee filters, deduplicating values. This follows the new identity and can include or exclude rows already assigned to the destination. Apply the same mapping after recovery establishes that the source was removed. A confirmed save with failed refresh remains saved and blocks further writes until fresh reads succeed.
- Explain that future fallback imports can recreate the former name unless an explicit rule normalizes it. Replacement does not add a rule. Automatic cleanup remains deferred.

### Rule editor and grammar

- Rules form one global numbered list. Each rule assigns a saved real Payee and can set an active ordinary subcategory. A rule cannot assign No Payee or consist only of Category. Starting Balance and Unknown Payee are unavailable as rule results. New rules go at the top.
- Each rule contains one or more AND conditions; only added conditions must match. OR uses separate rules. Account is one account ID with operator is. Account renaming preserves the condition.
- Description and Merchant can repeat: is, contains, does not contain, starts with, ends with, matches regex. Text and tested fields are outer-trimmed and casefolded. Blank fields fail every operator, including does not contain. Manual rows have no Merchant; nonblank stored manual descriptions remain available.
- Inflow and Outflow are the only amount fields; there is no generic Amount or either-direction choice. They share one condition slot per rule. Both offer is any amount, is exactly, is more than, is at least, is less than, is at most and is between. Comparisons use nonnegative integer-cent magnitudes. Inflow requires a positive transaction amount and Outflow a negative one; neither matches zero. Between includes both bounds. Is any amount matches the chosen direction without a value input.
- A new Inflow or Outflow condition starts with is exactly and a blank amount. Save requires an entered amount or a deliberate is any amount choice. Currency inputs show a dollar prefix. Switching Inflow/Outflow retains the comparison and bounds. Switching to is any amount hides inputs while retaining their local unsaved text for switching back. Saved badges use the same direction and comparison words as the editor. Removing either-direction support never converts or rewrites saved rules silently.
- Matches regex is an unanchored, case-insensitive Python regular-expression search over the trimmed text; `^` and `$` anchor it. An invalid expression is refused at save and preview with the parser's message. Duplicate detection compares regex text exactly and other text casefolded. Text input must be nonblank and at most 512 characters. There is no wildcard grammar.
- Regex evaluation has per-search and cumulative operation limits. A limit failure never counts as a nonmatch. Assignment, import and conversion refuse the affected operation with an actionable rule error and preserve its saved data and cursor. Informational rule counts become unavailable with a warning; the complete rule list and its editing/deletion remain available. Match and pending-resolution dialogs retain other evidence and identify unavailable rule evidence. Correcting the rule permits a later explicit retry.
- There are no invented rule titles, enabled flags, merchant tie-breaks in Payee rule ordering, similarity ordering, ambiguity states or register overlap hints.

### Rule conflict resolution

- Evaluate rules in global order. The first match wins the Payee and Category result. Use the explicit active rule Category, then the effective Payee's active default on ordinary rows. Historical Apply keeps existing transfer targets and uses a Payee default only on rows without a transfer target. Import, preview, historical Apply and transaction check share this evaluation. Partial overlap is allowed. A duplicate full condition set is refused regardless of results, condition order or text case. The error identifies and links the existing rule.
- Use one evaluator for import, conversion, preview and bank/manual match evidence. Existing source permissions and lifecycle admission remain authoritative.

### Rule editing, saving and deletion

- The payee column of the Payees tab remains the editor. New rule from a selected Payee starts with that Payee. New rule from All Rules requires choosing a Payee. Saving or editing a rule selects its Payee. All Rules offers Find and payee/category/account filters over the global list. Payee/category filters concern explicit results; Account concerns the explicit account condition. Find searches conditions, Payee names and Category names. Show absolute global numbers.
- Each row shows wrapping condition badges, then the Payee and optional Category results. The payee column uses the same layout without repeating its selected Payee result. Clicking a row selects it and shows its Matches rule view for review and Apply without opening the editor; clicking it again deselects it. Each row's pencil action opens it in the editor; Save rule and Cancel close the editor and keep the rule selected. The selected rule is highlighted. All Rules rows offer Edit and move arrows. Archived result categories appear amber and struck through, with a keyboard/touch-accessible explanation that the Payee/default fallback remains active; no archived badge.
- Saving a rule affects future imports. When the draft at its intended position decides eligible changes for N visible history rows, Save rule offers Cancel, Save rule only and Save and apply N in the shared compact confirmation; otherwise it saves directly. N excludes earlier-rule winners and rows that cannot be changed. When rule evaluation is unavailable, Save rule saves the rule only. The leave guard's Save uses the same confirmation, then completes the remaining dirty saves before navigating. Save, move and delete check one global collection snapshot. Every move immediately swaps adjacent global positions atomically. Moves are disabled while Find/filters are active; show Clear filters to reorder.
- Condition/result changes stay drafts until Save; blur never saves. Invalid/stale writes preserve text with an error and require reconciliation. Delete requires confirmation. Cancel/Escape restores a saved rule or discards a new draft.
- Leaving dirty work or selecting another rule offers Save / Discard / Cancel. Empty new drafts can be dropped. Search and ticks are view state.
- Duplicate creates an unsaved copy at the top; duplicate validation blocks Save until its conditions differ. Drafts preview at their intended position: new/duplicate first, edited at the saved position.
- A rule is Not reached only when current visible history contains matches and earlier rules win every one. This describes current history, not a proof about future imports.
- Suggest rules, post-rename candidates and per-payee rule editing are removed.

### Entry guard

- Category, payee and starting-balance entry share one guard: resolve split leave and require ordinary editing, writes, bulk staging and matching/pending/transfer workflows to finish or cancel.
- Outside-pointerdown follows the [ordinary editor exit rules](account-workflows.md#new-entry-exit-behavior) and does not bypass admission or save. Payee drafts can save independently; split drafts retain Keep editing / Discard changes.

### Historical search

- Payees-mode Find searches original descriptions or effective payee names using literal case-insensitive substring, all/one account including closed accounts, optional hiding of already-assigned rows, and Payee transactions. Counts cover the full query.
- The Payee list counts visible assignments across all accounts. Payee transactions shows the full query count for its active account/search filters, before paging. Display counts exclude hidden originals and use each visible parent's effective Payee. A Payee with zero displayed transactions can still have blocking saved schedules. Retained transaction references are disclosed and resolved by explicit deletion; they do not independently block it. Unavailable display counts are omitted or shown as a dash; never substitute stored-reference counts.
- Use visible effective parents: accepted matches once under the Plaid ID, splits once, removed rows absent, starting balances nonselectable. Page in exact reverse canonical chronology, 100 at a time. Rule-preview pages use the same order.

### Selection and assignment

- Payees-mode ticks persist across Find pages/search for the same payee, with a truthful hidden-selection count. Changing payee ends that selection session and keeps the active browsing tab, including Schedules. If the change clears Matches rule, return to the remembered transaction tab. Closing ends selection; a new dialog opening uses Payee transactions. Header selects displayed eligible rows.
- Assign to payee writes explicit selected IDs atomically through the ledger. Assign the Payee to the displayed transaction, its accepted match original, and all same-account originals whose retained replacement-pointer chain leads to either record. This includes active continuity predecessors and retired bank originals, deduplicated by transaction ID. Do not follow transfer partners or inactive associations without a retained pointer. An assignment equal to the displayed Payee still updates any differing stored Payees and preserves Payee ownership. A separated original keeps the assigned Payee. A changed manual Payee clears its match tolerance. The assignment captures one Undo step when saved data changes, creates no rules and does not reconcile pairs. Preview eligibility and edit tokens use the same complete source membership. Successful assignment returns selected snapshots.
- Stale/ineligible targets reject all changes, remove invalid selections with a count and require review/reselection.

### Rule preview

- The transaction column orders Payee transactions first, All transactions second, conditional Schedules third and the temporary Matches rule tab last. Each dialog opening selects Payee transactions. Without a selected payee, it remains selectable and shows “Select a payee to see its transactions.” without fetching or displaying all history.
- Within one dialog opening, remember the most recently selected Payee transactions or All transactions tab; Schedules does not replace that remembered transaction view. Removing the selected rule or unsaved draft returns to that tab. Switching payees retains this preference. Do not persist it across dialog openings or page reloads.
- While a rule draft or selected saved rule is present, the transaction column adds Matches rule with the matching count. New rule keeps the current transaction tab so conditions can be written while viewing transactions; from Schedules it returns to the remembered transaction tab; selecting, duplicating or editing a saved rule opens Matches rule. Save rule and Cancel on a saved rule keep it selected under the rule-editing requirements above.
- Matches rule tests the selected saved/unsaved draft against all visible history except starting balances, independently of Find filters. Show matching count, selected-rule decisions, earlier-rule winners and how many matches cannot be changed yet.
- Each row shows Payee and Category changes and the current transfer context on the left and amount/account/date on the right, without source/status badge, Manual label or description line. A matching row that cannot be changed (its account is not set up or it is otherwise not editable) appears dimmed without a checkbox and names the reason.
- Header selection skips earlier-rule winners; those rows can be selected individually. A previewed no-op is not an eligible change. A rule that only changes a stored Payee is eligible and the preview identifies that change. Rows that cannot be changed are never selectable or applied.
- Bind preview identity to global order, draft, payee/default/category state and row snapshots. Any changed draft/order/results or refreshed preview clears Apply ticks. A stale Apply rejects the entire command.

### Transaction check

- The right column of All Rules lists visible history with the shared account filter, search and paging. Picking a row shows its description, merchant, account, amount and current assignment, then the verdict: the deciding rule with its effective Payee and Category, or that no rule matches and which bank name import would fall back to. Manual rows have no fallback.
- While a row is picked, the rule list marks the deciding rule and other matching rules and dims the rest. Clear removes the marks.
- The check evaluates the current rules now. Rules run once at first import, and the check never writes or re-runs assignment.

### Historical application

- Save and apply N applies the previewed results to those N rows and saves the rule as one command. It rejects the whole command, saving nothing, when the preview changed. Matches rule ticks and Apply remain for selective application, and an unsaved valid draft can guide explicit assignment without saving a rule.
- Apply Payee and Category results to selected rows as one undoable ledger command. The Payee result follows [Assign to payee](#selection-and-assignment), including stored Payees. For ordinary single/uncategorized rows, the active rule Category or effective Payee default can overwrite an existing ordinary Category, including explicit No category. Without either Category result, retain the existing Category.
- Preserve existing transfer assignments and split allocations. Apply writes the previewed Payee and eligible Category result. Keep field ownership when the effective value is unchanged.
- Unticking creates no lasting exception. Applying does not teach sticky entry memory or reconcile matches.

### Writes and recovery

- Disable conflicting controls during writes. Unknown outcomes require recorded-outcome inspection and fresh reads, never automatic replay. Clear untrustworthy selection with a count and preserve drafts.
- Confirmed commit plus refresh failure remains success. Late responses cannot replace another view. Debounce text/preview reads by 250ms and cancel obsolete reads.

### Dialog layout and refresh

- Reuse shared Button, select and Modal composition and guards. The window has fixed viewport-relative height and independently scrolling panes. Stack history below the first two panes at 1000px and all panes at 640px. Keep search/actions reachable in short windows.
- Import/create/rename/assignment and sync refresh payee lookups, history/previews, labels and account summaries. Rule writes refresh global rules, previews/counts and conversion dependencies. Only Save and apply changes history; it also refreshes ledger reads. Refetch never silently replaces a dirty draft.
