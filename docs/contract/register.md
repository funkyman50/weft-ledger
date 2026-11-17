# Register

This file is part of the [product contract](../PRODUCT_CONTRACT.md). It owns the approved requirements for the sections below.

## Register

Each account has one source-aware ledger with date, payee, description, category, memo, signed amount, status, and workflow controls.

### Presentation preferences and backup eligibility

System settings opens from the rail gear. Its Display tab provides these browser-local presentation preferences: **Show new transaction after saving** (enabled by default), **Show account icons** (enabled by default), **Highlight bank differences** (off by default), and **Compact mode** (off by default).

- Turning off Show account icons hides account-type icons, automatic initials, imported icons and the All Accounts piggy-bank icon for open and closed accounts. Each row keeps its height and its text moves left. At desktop width, names use the freed space before truncating. At narrow widths, names keep their wrapping width. Account names, types, balances, review badges, selection and order keep their existing behavior. The Weft brand mark remains visible.
- Highlight bank differences uses the existing initialized, known Cleared-minus-bank-current difference. Equal, unknown and uninitialized balances show no highlight. This preference never hides the footer warning or Resolve difference and changes no saved financial data.
- Compact mode shows each account rail row on one line: icon, name, review badge and balance. The account type, or Combined history for All Accounts, moves to the row's hover tooltip. Rows keep one height with icons shown or hidden. Narrow widths keep their icon-and-name rail.
- An icon-only Columns button (Columns3 cog icon, accessible name and tooltip Columns) is fixed at the ledger grid's top-right corner, flush with its right edge over the scrollbar gutter and beside the action-column header. It opens a right-aligned menu, no wider than its options and kept within the ledger's right edge, of browser-local column preferences that apply across accounts and All Accounts and survive reload when storage is available: Show columns — Transfer (hidden by default), Bank description (hidden by default) and Balance — and Amount — One signed Amount or Separate Outflow / Inflow. Items show checkboxes and radio buttons, apply immediately through the ordinary editor departure guard and keep the menu open; Escape returns focus to the button. While open, the menu counts as open ledger work for Undo and Redo. Balance is available only in individual account views; elsewhere its item is disabled with that reason and the preference is kept.
- Column order is Payee, Transfer, Bank description, Category. A transfer cell reads with the Payee: → and the other account for an outflow, ← for an inflow, then Linked, Unlinked or Needs review; other rows show the empty dash. The cell opens the transfer popover and announces direction, account and state. While a row is edited, the cell shows the draft target without a state. Hiding the column drops only its sort priority.
- The separate columns show positive magnitudes, keep zero in Inflow, and still edit and persist one signed amount.
- Balance shows the account's working balance immediately after each included transaction in canonical ascending chronology, including pending and planned transactions.
- It remains based on full account history regardless of filters, display sorting, status grouping, or pagination.
- Enabling Balance preserves the selected sort. In the default grouped view, mute balances on pending and unmatched planned rows. If status grouping places a contributing entry below a chronologically later contributing entry, also mute every available balance at or after the earliest such displaced entry in canonical chronology. Use the contributing projected entries shown in the current view; filtered-out entries do not define this cutoff. Missing, excluded and uninitialized rows have no balance and do not define it. Cleared* and locally cleared planned entries still count.
- Mark the first affected loaded balance in displayed order with one amber line above its amount. The marker remains visible during selection, editing and saved-row reveal without changing row height or column width. Its keyboard-focusable note and hover explanation identify the date-sequence boundary and direct the reader to Date sorting. Loading older history or refreshing rows recomputes the cutoff and marker; an old displaced entry can mute the whole loaded window.
- Under custom sorting, show all balances at full strength when Date is primary, ascending or descending; otherwise mute all available balances. Custom sorts show no cutoff marker. Muting uses readable muted text instead of sign colors, without changing values. Each muted cell explains its reason on hover. The Balance header provides a visible information cue and keyboard-accessible explanation. Grouped pending/planned cells also expose their reason accessibly; cutoff-muted history uses the boundary note and header to avoid per-row repetition. Filters can hide contributing entries and same-date secondary sorts can reorder them, so adjacent-row arithmetic is not promised.
- Missing pending and excluded imports neither contribute nor show a balance.
- Uninitialized Plaid-workflow accounts show none.
- The preferences apply immediately across accounts in that browser, survive reload when storage is available, and do not affect saved values, history, filters, or CSV export. Hiding Bank description drops only its sort priority, retaining other priorities or restoring the default sort when none remain.
- System settings provides the separate [Backup & restore workflow](system.md#backup-restore). Account data belongs in backups; browser-local presentation preferences do not.

### Review after editing

- System settings has a **Behavior** tab after Display. **Mark reviewed when I edit a bank transaction** is off by default and stored in this browser only. It applies to future individual ledger saves, including ordinary explicit and click-away saves and explicit split saves. Enabling or disabling it changes no saved transaction by itself.
- When enabled, a real saved change to effective Payee, Category/categorization or Memo on a visible unreviewed Plaid parent also marks the final visible Plaid parent Reviewed. Clearing a field, explicit No category, Payee category autofill, split allocation changes and allocation memos count. A matched source's selected effective values govern no-op detection; allocation IDs and ownership-only writes do not count.
- The backend checks source and review permission before editing, measures the requested semantic metadata change before reconciliation, and applies review to the final visible bank parent after reconciliation. A different final bank parent must also permit review. Review overrides inherited Needs review from a matched manual entry only on the visible bank parent. Hidden originals and transfer counterparts retain their review state.
- Manual sources, including those in Plaid-workflow accounts, do not qualify. Unchanged/reverted saves and flag-only edits do not qualify. Only individual row and split saves send this intent; bulk/global assignments, rules/defaults, schedules, imports/sync and initialization keep their existing behavior. Existing comparison confirmations, including transfer Save unlinked, retain their review rules independently of the toggle.
- Metadata and review commit atomically in the existing edit command and Undo/Redo history. Undo/Redo restore that saved result regardless of the current preference. Pending lifecycle, clearance and independent split warnings do not change.
- A confirmed response supplies the saved Reviewed state before refresh. The existing fresh-read policy removes reviewed rows from Needs review and clears an exhausted review-status filter while preserving other filters. Existing keyboard return/fallback behavior applies; no automatic next-row focus is added. Failed and uncertain saves keep their existing recovery rules. Unknown-outcome recovery refreshes authoritative data without predicting review or automatically clearing an exhausted review filter.

### Layout, filters and totals

The register must preserve these layout, filtering and selection requirements:

- Include manual, Plaid, and starting-balance rows.
- Use compact 27-pixel rows and stable text alignment while editing.
- In both ledgers, single-selected and multi-selected rows use the same light blue background. Editing uses a darker blue background, including new composers, and takes priority over selection, review and hover shading. The selected-total footer segment matches the lighter selection color.
- Keep source, date, amount-or-outflow-and-inflow, balance, status and action columns fixed. Keep text columns flexible and resizable.
- The optional Balance column follows the amount column or Inflow.
- Bank description is read-only Plaid text; manual, draft and starting-balance cells stay blank. Use the bank row’s own Description even when match field ownership selects manual text elsewhere. Its sort uses that displayed text.
- On a read-mode Plaid Payee cell, hover shows bank Description independently of the Payee rule-hint and transfer icons. Every saved Plaid row has a Payee, so the cell shows that identity without a bank-description fallback.
- Keep one visibility and fitted layout for main rows, the new composer, selected rows and split allocations. Retain explicitly resized widths and refit untouched peer widths on visibility changes.
- The visibility toggle follows the editor departure guard. A changed saved ordinary edit saves before changing visibility; a new entry with work asks before discard. Refusal or a split/transfer handoff leaves visibility unchanged. Keep its keyboard focus unless the user has moved focus elsewhere.
- Close the Description filter popup before hiding its anchor. Preserve the active Description filter, counts and clear-all; indicate that filter with a dot and accessible-name note on the Columns button and a filter-active note on its Bank description item. Description filtering and CSV still use effective stored text from every source.
- The final action column has two compact slots in every account view. The first shows Match/Resolve when permitted, including retained matches after disconnection, and otherwise stays empty.
- The action column remains unsortable and keeps its width. Its header reserves room for the Columns button at its right. During any explicit custom sort, the header shows one compact button immediately left of Columns, containing closely grouped List sort ascending and Reset icons, with the hover text and accessible label **Return to default sort**. The button restores default grouping and Date ascending, preserves filters and selection, then disappears. When it owns keyboard focus, return focus to Date before removing it. An explicit local Date ascending sort still shows reset even when its order matches the local default.
- The second slot shows `R` while a row permits review and needs review. Otherwise it shows `C` when ordinary clearance is permitted, or the existing `R` toggle when only review is permitted. It stays empty when neither action is permitted. Scheduled Needs review, review counts and matching inheritance remain independent of clearance.
- Keep the same native state button through `R` → `C` so focus survives in an unfiltered view. Reject the second click of a multi-click gesture and held activation-key repeats, including when review refresh moves another row under the pointer or resets an exhausted review filter. Rejected clicks must not enter row editing or selection. A later separate click or Enter/Space activation deliberately acts on the newly displayed button. Keep existing focus behavior when a filtered row leaves.
- Allow horizontal overflow only when selected widths require it.
- Support up to three sort priorities through normal and Shift-click header actions.
- An explicit header sort replaces the default grouped display. The first plain or Shift-click from default starts a custom sort with only the clicked column; Date starts ascending. Further Shift-clicks add priorities. Removing the last custom priority restores default. A distinct order icon marks default status grouping on Status, or default Date order in local-only views; ordinary arrows and priority numbers describe only explicit custom sorts.
- Filter by source, date, exact Payee/Category selections, description, memo, signed amount range, displayed Status and an independent Needs review restriction. All is the default scope of ordinary register rows. Excluded contains suppressed bank rows. All sources combines both. Retained joined originals remain hidden in every main-register scope.
- Show truthful All/Excluded scope counts, filter-sensitive Showing counts, empty-result recovery and one clear-all action. Column filters must not change scope counts.
- Top-workspace notices float at the header's original vertical position, centered on the page, and stack downward in arrival order without displacing page layout.
- Notices are independently dismissible and fade out over 240 milliseconds after a timed display, and remaining notices close upward as earlier ones leave.
- Ordinary notices stay visible for five to twelve seconds, scaled by message length.
- A Plaid completion shows a thirty-second result/count summary and a separate card for each distinct bank issue, which stays until dismissed or replaced by the next completion.
- Manual and timed dismissal affect only that card.
- Hovering or focusing a timed notice pauses its remaining time.
- Identical ordinary feedback refreshes one card instead of stacking duplicates.
- Neutral notices, warnings, and errors use consistent title/body/action composition and distinct blue, amber, and red tones.
- A bounded scroll region limits the stack to half the viewport or 360 pixels without displacing page layout.
- Recovery alerts with a required action remain until their condition clears.
- Load the latest 200 eligible rows, including all filtered pending and planned rows retained outside history paging, regardless of display sorting. If those rows fill the page, include at least one eligible ordinary history row when one exists. Load older ordinary history upward in stable order without duplicates or scroll jumps. Loaded-window refreshes retain the whole oldest loaded date so same-day sign edits remain visible.
- Default to Status then Date ascending: ordinary history first, provider-pending Plaid rows next, and unmatched planned manual rows last, including in All Accounts. Order each group by canonical ascending chronology. Local-only accounts default to Date ascending. Custom header sorting orders all loaded rows together without status grouping; a sole Date sort uses canonical chronology, with descending an exact reversal. With Date primary and secondary columns, date and direction class precede the secondary columns. Restore grouped placement only when returning to default.
- In the default view, a visible Plaid row with provider status Pending stays in the pending group, including Cleared* and Pending?, regardless of connection, historical or exclusion state. Visibility and filters still apply. Posting returns the row to ordinary history under its usual paging rules. Planned rows retain their existing Unmatched identity.
- Planned rows keep the Unmatched label after local clearance. Their dot is green when Cleared and gray when Uncleared, including while Needs review makes the action slot show R. Hover/focus and accessible text distinguish Cleared from Uncleared in Weft and explain that no bank transaction has been matched. They remain in Unmatched and do not enter Cleared or Bank pending.
- Show Cleared, Uncleared and Working balances. Omit missing pending and excluded rows from these totals.
- After initial history and starting-balance initialization, when Cleared differs from Plaid's sign-normalized current balance by at least one cent, the upper footer status zone shows an account-level `Bank difference` warning in every register scope: a yellow alert triangle with the signed Cleared-minus-bank amount, ordered before the missing-pending warning and Transactions to review.
- The warning is keyboard-focusable, never filters, and its hover/focus explanation gives both balances, the signed difference, and provider update time. A loan account's warning opens [Resolve difference](schedules-loans-and-transfers.md#resolve-difference); other accounts retain the passive warning.
- When Plaid supplies credit availability and limit, show them.
- Support ROYGBV flags.
- Support Cmd/Ctrl additive selection, Shift range selection and clearing selection. Other controls must not change selection accidentally.
- Suppress outer focus outlines on the register scroll region and persisted rows; retain their focus behavior and row-selection shading.

### Categorical column filters

- Category and Payee use searchable checkbox lists. Status uses a compact five-value checklist plus a separate Needs review toggle. Other column controls retain their existing behavior; Account/Source/Flag checklist redesigns and Scheduled-pane filters remain deferred.
- Without search, the list edits the draft selection, and a mixed-state All values checkbox controls every choice. Checkbox and parent-label clicks stay in the popup; they never apply automatically.
- Search follows the spreadsheet filter-search model. It shows only matching choices, all checked, with a mixed-state Select all search results checkbox. Each change of search text starts its matches checked. With search text present, Apply replaces the filter with Only the checked matches. Checking Add current selection to filter instead keeps the draft selection and sets just the matching choices to their checked state: checked matches are included and unchecked matches are excluded. Clearing the search returns to the draft selection without the search checks.
- Start from All and uncheck to mean All except those identities; newly added identities remain included. Start from None and check to mean Only those identities; newly added identities stay excluded. Summaries state the intent. Fixed complete Status selection means All. None cannot be applied. Limit each Payee/Category filter to 200 explicit selected or excluded identities/keys, with visible feedback; All has no such list.
- Category parent checkboxes select or exclude their current matching subcategory IDs. They are shortcuts, not saved parent predicates. New children do not join an Only selection; an All except selection admits new children unless specifically excluded. Keep No category and Unassigned split separate. No category includes never-assigned and deliberately empty categories, including genuinely uncategorized transfers/starting balances and ordinary blank split allocations. It does not match a split merely because its parent category is blank.
- Choices list only the Payees and Category keys used by visible rows in the selected account context (one account, a group or All Accounts), including excluded rows, protected Payees and archived categories. A parent group shows only its used subcategories, and No category and Unassigned split appear only when used. Other column filters, date range and source do not narrow the choices. Choices use the same effective facts as filtering and refresh after ledger writes. While they load or refresh, Apply stays disabled; a failed read hides the choices and leaves Clear and Cancel available. A selected value no longer used in the context remains visible as not used here and removable. There is no blank Payee choice and transfer destinations are not Payees. Renames preserve identity. Removed included choices remain visible as unavailable and removable, without silently broadening the filter.
- Description and Memo remain case-insensitive contains filters. While the draft is nonblank, they suggest up to eight matching values from the same account context, most used first; Memo includes split-line memos. Choosing a suggestion fills the draft; Apply or Enter applies it.
- Values within a column combine as OR; columns combine as AND. For a split, any selected effective allocation category returns its parent once. Excluding one allocation category does not remove a mixed split whose other allocation still matches. Keep complete breakdowns and highlight matching allocations in both Only and All except modes, including blank/unassigned choices. Unassigned split is a row-level lifecycle condition: excluding it omits affected parents before ordinary category matching.
- Status partitions visible rows into Bank pending, Cleared, Uncleared, Reconciled and Unmatched. Planned rows are Unmatched before ordinary clearance classification. Cleared* and visible missing pending remain Bank pending. The fixed Status column and its filter appear in local-only as well as Plaid/combined views; existing default sorting remains unchanged. Needs review is an additional AND restriction and retains its existing missing-pending exclusion. Do not add a Reviewed filter.
- The popup stages changes until Apply. Apply requires a changed valid selection; Enter applies the same result as Apply, including a search result. Cancel, Escape, outside dismissal and switching columns discard unapplied changes. Clear immediately resets only that column, including Needs review for Status. Search-clear removes only search text. Return focus to the header on Apply/Cancel/Escape unless a deliberate outside interaction owns focus. Preserve composition, held-key, scrolling and workspace departure/recovery guards.
- Filter changes clear row selection through the existing view boundary. Counts, paging and full selection use the same server filter semantics. Filters do not alter balances, transaction facts, CSV export scope or saved data. The existing footer review control toggles only Needs review and preserves selected statuses and other filters.

### Viewport placement

Shared picker and menu popups fit the visible viewport: prefer below when the measured content fits, otherwise above when it fits, otherwise use the larger side and scroll.

- Keep an 8px edge margin and 4px trigger gap, clamp width, and update placement as the viewport, trigger or contents change.
- Search and pinned commands remain visible during normal choice-list scrolling.
- Exceptionally short windows allow the entire popup to scroll so every control stays reachable.

### Scroll behavior

The register distinguishes keeping the current view from navigating to a transaction. Scroll changes affect only the register and preserve horizontal position and keyboard focus.

- Within two pixels of bottom, the register keeps the last displayed row at the bottom through row changes, refreshes, split expansion, composer visibility, selection controls, scheduled-pane changes and window resizing. Bottom means the end of the displayed order, including status-grouped rows.
- Away from bottom, passive changes preserve the first visible transaction and its offset below the header. Expanded allocations belong to their parent transaction. If the anchor disappears, retain the closest surviving neighbor from the previous order, preferring the following row at equal distance. If surviving rows change relative order, prefer movement shared by the visible survivors so one moved row does not pull the viewport to its new location. If no previous row survives, retain and clamp the vertical position.
- Opening the composer reserves space below the rows. It shifts the visible rows upward by the composer's height so rows next to entry remain visible, including a just-revealed backdated save. Composer changes must also keep the most recently revealed saved row visible until user navigation or a view reset. Closing reverses the displacement, subject to row visibility and scroll limits. At bottom, both changes retain bottom.
- User scrolling and arrow-key row navigation update the bottom or reading position. Arrow-key navigation follows displayed parent-row order and loads older history near the top. Older-page reads restore the current position when they finish, including after later user scrolling and under non-Date sorts. Application scroll adjustments and horizontal-only scrolling do not count as user navigation or trigger older-page loading.
- Entering an account, changing filters or explicitly sorting from a column header starts at bottom of the displayed order. Display preferences that remove a sort retain bottom or reading position. Sorting covers loaded rows; older pages can interleave under non-Date sorts. Account scroll positions are not remembered after navigation or reload.
- Manual Sync, background sync, ordinary writes, Undo/Redo and recovery reads use this same preservation rule. Refresh completion never forces a reading position to bottom.
- The existing **Show new transaction after saving** preference permits a confirmed saved-row reveal after a successful fresh read. It scrolls only enough to make that row visible, uses the current order, and does not load older history. User scrolling during manual creation or its fresh read cancels pending reveal. Bottom preservation operates with either preference value.
- Explicit transfer navigation centers its target and can load earlier history. User scrolling cancels pending transfer navigation. Conditional keyboard save/cancel focus restoration can minimally reveal its persisted target; pointer completion retains the user's chosen focus.
- Failed, uncertain or cancelled saves do not request saved-row navigation. Passive layout preservation still applies when their editor changes size or closes.

### Keyboard entry

Amount, Outflow and Inflow entry controls accept digits, decimal points, commas, dollar signs and minus signs. They remove whitespace and normalize the copied Unicode minus sign to `-`. Reject a typing, paste or replacement change containing any other character; do not remove letters to manufacture a different amount. This applies to the shared transaction, schedule and split-allocation amount controls. Allow at most one decimal point and two digits after it during entry, including typing and paste. Keep unfinished values such as `12.` editable. Reject excess precision without rounding or truncating it. Complete amount validation still applies when saving.

The ledger supports keyboard-only entry from Date through Amount.

- An ordinary new composer focuses Date. Description has no manual input or Tab stop in either visibility state. Tab follows Date, Payee, Category, Memo, then Amount or Outflow and Inflow; Shift+Tab reverses the rendered order.
- A fresh New Transfer starts the same composer with today’s date and immediately opens the transfer picker with no active result. Date remains editable. Choosing a target with Enter or Tab moves focus to Payee. Ordinary New Transaction keeps Date, Payee, Category, Memo, then Amount in its keyboard path and skips the transfer button; a dedicated shortcut opens the transfer picker. All entered fields remain intact if the picker is dismissed.
- The register's Date trigger has a visible dropdown affordance. In the new composer, focused Date has a white background and blue focus outline, including after clicking either New control. Focus alone never opens its calendar or the Category picker.
- Enter or F2 on a focused persisted row starts editing through the same eligibility and workflow guards as clicking it and focuses Date when editable, otherwise the first editable field.
- During pending-lifecycle selection, Enter on an eligible cleared row chooses that candidate and F2 does nothing.
- Typing a printable character other than Space without Ctrl, Meta, or Alt on a focused, closed Payee or Category field opens its search with that character and the caret after it, whether the field is empty or already assigned.
- Shift+letter works, and the saved choice changes only when an option is selected.
- Payee and Category results apply search and eligibility filters to the assigned value too; do not pin a nonmatching assignment in the results. The trigger retains the assignment until another option is selected. Clearing search restores it to the list only if it remains eligible and listed; archived or fallback-only assignments remain on the trigger.
- Payee and Category search keep text focus while Up/Down move a visibly active result in the existing display order.
- Picker options mark the assigned value with a checkmark and normal text. The active keyboard candidate uses a blue background and bold text without an outline. An option in both states combines the checkmark with that highlight. Hover uses a lighter treatment and does not change the keyboard candidate.
- Typing a nonblank query activates the first match, Down from no active result starts at the first and Up at the last, and navigation does not wrap.
- In a transaction, schedule or split allocation picker, Enter selects an active result, closes the popup and advances to the next rendered editable cell in the same row. Enter with no active result stays in search.
- Left/Right retain text-caret behavior.
- Opening with no typed query, including the automatic transfer-category search, activates no result.
- Forward Tab in picker search accepts an active result and advances like Enter. With an empty query and no active result, Tab closes and advances without assignment. With a nonblank query and no matches, Tab keeps search open. Tab never creates a payee from search text.
- Shift+Tab from picker search reaches the last enabled popup command. Tab and Shift+Tab traverse those commands; forward Tab from the last command returns to search. Shift+Tab from the first command closes to the field. Escape closes without accepting the highlight and returns to the field. Closed fields retain ordinary forward and reverse cell navigation.
- Explicit picker commands remain keyboard reachable. Picker acceptance and cell continuation do not save the row; leaving the whole new editor follows [new-entry exit behavior](account-workflows.md#new-entry-exit-behavior). Pending or uncertain payee creation retains its focus trap.
- Mouse selection and explicit command activation return focus according to their existing workflows. A transfer review or Split transition owns its focus; ordinary picker continuation must not steal it.
- Bulk toolbar pickers retain Tab navigation through popup controls and return-to-field selection. Flag pickers and other account/frequency selectors retain their behavior; schedule Account and Frequency use the new-entry continuation rules.
- A held Enter must not accept another value or save the row through key auto-repeat after advancing. Arrow-key repeat remains available.
- Keys used by an active input-method composition must not select a picker option, save or cancel a draft, or dismiss a dialog. Apply this rule to ancestor handlers as well as the focused control.
- Enter in a text or amount editor saves. Escape in a new ordinary entry follows [new-entry exit behavior](account-workflows.md#new-entry-exit-behavior); saved-row edits retain their existing cancellation rule.
- A changed existing ordinary transaction or schedule follows [existing-row departure](account-workflows.md#existing-row-departure). Dirty new entries retain field focus after passive clicks without saving or discarding. Disabled controls retain focus without fabricating a click. Popup dismissal closes only the popup; field navigation, dialogs and explicit editor commands retain their ownership.
- After a keyboard-initiated save or cancel, restore focus to the persisted row or New Transaction control only while focus has not moved elsewhere.
- If that target is unavailable, focus the register without scrolling.
- Clicking Save keeps focus on any later deliberately chosen target. Following a newly saved row scrolls only the register and does not change that focus.
- While a new draft is open, a pointer or focus move to either New control does not save it. Activating either control resumes that draft and focuses Date without changing its entry intent. Keyboard save/cancel returns to the draft's initiating New control only when focus has not moved elsewhere.

### Calendar keyboard behavior

On a closed Date field, the first unmodified Up, Down, Left, or Right opens the calendar on the draft's selected day without changing the draft.

- Enter or Space also opens it.
- In the open calendar, Left/Right move one day. Up/Down move seven calendar days in the same weekday column. Within the displayed month, that is the adjacent row. When the destination falls outside it, the calendar shows the destination's month, including across year boundaries.
- Tab or Enter on a focused day selects it, closes the calendar and advances to the next rendered editable cell. Space selects the day and returns to Date. Escape closes without changing the draft, and only one day is in the Tab sequence.
- Shift+Tab from the focused day reaches Today, Next month and Previous month in reverse command order. Tab traverses those commands and returns to the focused day without selecting it. Shift+Tab from Previous month closes to Date.
- Previous/Next month controls keep their own focus while moving the calendar's focused day by one month.

### All Accounts presentation

All Accounts adds a resizable, sortable Account column immediately before Source.

- Saved account cells are display-only.
- Move remains the account-reassignment command.
- Rows from accounts needing initialization are labeled and retain their server restrictions without locking other accounts.
- All Accounts shows each row’s review or clearance controls according to its permissions, aggregate Needs Review, and the selected amount total.
- It omits account balance equations, running Balance, credit availability, and bank discrepancy.
- New Transaction first asks for an open initialized account, then opens the existing composer with that fixed account.
- New Transfer uses the same account chooser and preserves its shortcut through Continue. Chooser Cancel writes nothing.
- Duplication retains the source account.
- Transfer navigation stays in All Accounts and clears filters to reveal the partner.
- Single-account navigation still opens the partner account.
- Combined history uses one global date/chronology-class/ID cursor and follows the shared [paging requirements](#layout-filters-and-totals).

### Server-owned permissions

The server tells the client which fields are editable and which actions are allowed for every persisted row. The browser does not reconstruct those rules from database details.

### Immediate feedback and reconciliation

Ordinary row commands show requested display values immediately and write in submission order.

- Protect the affected row until its save and authoritative reconciliation finish.
- Unrelated row controls remain usable.
- Preserve ordinary editor acknowledgment, failed drafts, and editor-switching rules.
- Provisional row values do not predict matching, visibility, permissions, counts, or balances: those remain at their last confirmed values until fresh server data arrives.
- A confirmed write followed by refresh failure remains saved and offers explicit Refresh.
- Never overwrite a newer command with an older response or discard loaded history during reconciliation.

### Write guards and recovery

Temporary write and refresh guards keep the register's otherwise available controls visually steady while blocking actual conflicts.

- Background fetching alone does not disable the register.
- Do not dim the edited row or every row control during a save.
- Unavailable actions, staged-work restrictions, and recovery blocks retain their disabled styling.
- Undo/Redo with no corresponding action remain dim.
- Outstanding commands still block saved-history actions and entry to token-sensitive workflows and category/payee management.
- A pending or unknown-outcome picker payee creation also holds transaction save/cancel, editor switching, account/filter navigation, and new-transaction/account-settings entry until it settles or its explicit recovery refresh succeeds.
- Uncertain outcomes require explicit inspection before further writes. An ordinary editor cannot save or cancel while its recovery guard is active; retain its values until inspection settles.

### Undo and Redo

- Small labeled Undo and Redo buttons follow the New Transaction and New Transfer actions.
- Use the Lucide Undo icon before the Undo label and the Redo icon after the Redo label.
- Reuse quiet action-button styling and dim unavailable controls.
- Accessible names and hover explanations identify the next action and its account or accounts.
- Keep the existing initialization footer boundary: an unfinished account hides these controls and blocks their shortcuts without discarding other accounts' history.

- One successful, changed register save is one history step.
- Support Enter this occurrence and Skip this occurrence for a schedule, manual creation/duplication, ordinary and split edits, bulk edits and moves/deletions, review, local clearance, manual C*, exclusion/restoration, loan difference resolution, bank/manual match decisions, and transfer saves/linking/unlinking/counterpart creation.
- Capture each row's prior values, allocations, field ownership, and indirect relationship changes.
- Each completed transfer-queue item is its own step.
- Exit the queue before Undo.

- A page has one chronological history across accounts, capped at 100 actions and a bounded record budget.
- A new changed save after Undo discards Redo.
- No-op/failed saves, cancelled drafts, navigation, selection, filters, sorting, paging, and data Refresh do not.
- Browser reload, closing the page, authentication loss, backend restart, history eviction, or database restore ends it.
- Explain expiration rather than guessing an old outcome.
- Undo/Redo history remains temporary backend memory, separate from persistent save confirmations; it does not become a permanent audit log.
- Keep small persistent confirmations for local saves so an uncertain result can be checked after backend restart or temporary outcome expiry. Record completion atomically with the local change. A matching confirmation and fresh authoritative reads can establish success without resending the save. Missing or unavailable evidence does not prove failure; genuinely uncertain outcomes remain flagged and block dependent writes until fresh authoritative reads succeed and the owner explicitly chooses “I checked the result—continue.” This acknowledgment does not establish success or failure, resend the command, or discard an unsaved draft. Failed fresh reads cannot offer this acknowledgment.
- Provider operations retain their named status checks. A local confirmation must not claim an unverified bank or OpenAI operation succeeded. Persistent confirmations do not extend Undo history or authorize automatic replay.
- If page history expires with no unresolved sent command, recover in place after outstanding writes settle and fresh history, account, and ledger reads succeed. Preserve drafts, comparison choices, original domain tokens, navigation, and scroll. Do not replay the rejected command; the user submits it again deliberately.
- Admission remains blocked if recovery reads fail. Offer Retry refresh without requiring re-entry. Explain loss of earlier Undo history once.
- A database-generation change requires reload before any mutation, including writes outside Undo history. A changed history epoch with an unresolved sent command retains the inspection barrier until valid evidence and fresh reads establish its result, or fresh reads and explicit owner acknowledgment release a genuinely uncertain local save. Ordinary history renewal cannot establish that result. Confirmations from another database generation cannot establish a current result.

- Cmd/Ctrl+Z undoes.
- Cmd/Ctrl+Shift+Z redoes, with Ctrl+Y also supported on Windows/Linux.
- Native input editing retains text Undo.
- Drafts, staged bulk work, active writes, recovery, dialogs, popups and matching/transfer/pending workflows block saved-action shortcuts and buttons.
- Undo/Redo needs no extra confirmation.
- Existing confirmations for the original command remain.

- Preserve the selected account, filters, sorting and bottom or reading position under [Scroll behavior](#scroll-behavior) when reversing an action.
- Refresh affected ledger data and totals, remove invalid selection, and announce the result with the action and account context.
- A restored row may remain outside the current filter.

- Verify and restore the complete action atomically.
- Preserve saved identities and reject collisions, changed dependencies, or ineligible lifecycle state without partially restoring anything.
- Undo never rewinds provider balances, identity, raw data, amount/date/status, or sync cursors, and never resurrects a replaced or removed pending transaction.
- Derived suggestions are rebuilt without automatic matching.
- Provider-driven match expiry is not recorded as user work.
- Unrelated imports and balance refreshes alone do not end history.

- A dependency conflict ends the blocked and older history plus Redo, explains why, and leaves saved data unchanged.
- A database-busy rejection preserves history.
- Duplicate or stale requests cannot reverse an extra step.
- Uncertain writes require inspection of the recorded attempt and fresh data before another deliberate write.
- Never automatically replay.
- A committed save or reversal followed by refresh failure remains success.
- Existing workflow refresh controls share the same recorded-outcome inspection and retain their draft-reconciliation guards.

- Initialization/Re-init, starting-balance edits, account/category/payee/rule management, connection changes, and missing-pending resolution/disappearance are outside Undo.
- A changed successful save in these workflows ends this page's earlier history with an explanation, except creating a payee, rule-only create/edit/move/delete, saving Loan details, and saving or dismissing a default-category preference preserve the current Undo and Redo cursor while recording their committed outcomes.
- Schedule create/edit/delete preserve the current Undo/Redo cursor and record their page-session outcomes. Enter this occurrence captures its rows, relationships, schedule advancement, and deletion of an exhausted schedule as one history step. Skip this occurrence captures advancement or deletion as one history step and names the owning schedule account. Undo restores the exact previous definition and ID. A restored due occurrence remains eligible for ordinary background entry; that entry or another later schedule change can reject Redo through dependency validation.
- Explicit default-category history updates are one undoable assignment step.
- Rule Save and apply is one undoable assignment step. Undo restores the transactions and leaves the saved rule.
- Undo restores transaction categories while retaining the default preference.
- Opening/cancelling them, previews, exports, and manual/background sync do not.
- Rules-mode historical application is one assignment step. Undo restores transaction assignments while keeping saved rules and sticky category preferences.

- Explicit Unmatch, Unlink, Restore, and Undo manual clear remain available independently of session history.
- They need not reproduce a complete prior action: Unlink retains transactions, while Undo a counterpart creation restores the complete state before creation.
- A transfer-draft save with an unknown outcome uses the shared command-outcome inspection and persistent confirmation before another write; it has no separate transfer-specific receipt mechanism.

### Transaction context menu

### Row context menu and focus

- Persisted parent rows use one compact right-click menu instead of an ellipsis button.
- With no active transaction edit, right-clicking an unselected row replaces an unstaged selection with that row.
- Right-clicking a selected row targets the complete selection.
- The composer and split-allocation children have no independent menu.
- Right-click inside an active text field retains the native editing menu.
- During any ordinary, split, or new-composer edit, right-clicking the editing row, its controls, or its picker retains the native menu and leaves the draft intact.
- Right-clicking another persisted row while an unchanged ordinary or split draft is open on a persisted row closes that draft without a write before opening the new row menu.
- A context-menu request on another row uses the ordinary departure guard: save a changed existing ordinary edit, then resolve current menu rows and permissions. Split drafts and new composers retain their explicit completion guards.
- Right-click does not commit through pointer or blur handling; the requested guarded action owns departure.
- A clean persisted draft may close synchronously without a write before row actions resume.
- The keyboard Context Menu key and Shift+F10 use the same departure guard, while retaining the native menu for the active editing row.

- Rows use roving focus: Tab enters on one persisted parent, Up/Down moves focus without changing selection, and the Context Menu key or Shift+F10 opens the focused row's menu or the complete selection when that row is selected.
- A plain click on a persisted parent selects it without editing. A subsequent plain click enters editing only when that row is the sole selection and permits editing. Clicking another row replaces the selection first. Enter and F2 retain direct edit entry; row buttons and split expansion retain their explicit actions. Existing draft and staged-work guards apply before selection or editing changes.
- The click that enters editing also targets the clicked cell, including the clicked line of a split. A text or amount field receives focus with the caret at the end; a picker such as Date, Flag, Payee or Category receives focus and opens. A click on a cell without an editable field keeps the editor's default opening focus. Targeting opens only pickers; it never activates another cell button.
- Escape closes the menu and restores row focus. Tab dismisses the menu before continuing from the invoking row. Initial focus selects the first enabled command, or the first disabled command when none is enabled. Arrow keys navigate within the menu without propagating to row navigation.

### Command availability

- Hide commands that do not conceptually apply to the target source, relationship, or selection arity.
- Keep normally applicable but currently blocked commands visible, focusable, and disabled with a hover/focus explanation. An action applies when any target allows it or has a backend blocked-action reason. A staged state field remains visible if eligibility changes. When every blocked target shares one backend reason, show it; otherwise explain the complete selection restriction.
- Bulk writes are all-or-nothing and never skip ineligible rows.

- Single eligible pending Plaid parents offer Mark cleared manually or Undo manual clear under the Plaid-account workflow.
- Every single parent permitting review offers Mark reviewed when it needs review and Mark needs review when already reviewed. With no staged draft, the command changes review immediately without changing clearance or provider facts.
- Single parents permitting ordinary clearance offer Mark cleared or Mark uncleared through their context menu, including while the inline slot shows R. Cleared and Reconciled both offer Mark uncleared. This command does not change review.
- State commands have the same order in every register: Review, ordinary Clearance, then Manual clearance. Live bank rows retain their inline R toggle and separate pending C* commands. Bulk commands use Mark selected reviewed and Mark selected needs review for the same review states.
- Multiple eligible pending Plaid parents, or one eligible selected parent with staged changes, offer Mark selected cleared manually and Undo manual clear for selected through the bulk Save/Cancel flow.
- The immediate single-row commands remain disabled during ordinary/split editing, staged bulk changes, active writes, or matching/pending/transfer workflows.
- Missing-pending parents offer **Resolve pending transaction…**, and suggested pairs offer **Review possible match…**. A visible row with existing connections offers one **Inspect connections…** entry, including when merge or amber occupies its row slot. This replaces the separate linked-match, bank-association and Unlink inspection entries. Keep the distinct finders and transfer navigation. Relationship entry points share the existing admission guard, and explicit resolution and inspection intent must remain distinct. Opening either view performs no correction. Resolution clears selection.
- Menus group state commands, relationship workflows, Duplicate/Make recurring, then Move/Delete/Exclude/Restore. Separators appear only between nonempty groups. A target with no applicable command shows a focusable disabled No actions available explanation.
- An unknown manual-clear write requires successful explicit Refresh and inspection before another attempt.
- A confirmed save followed by refresh failure remains success.

- Paired bulk context-menu commands for review, local clearance, and manual clearance remain visible but dimmed and disabled when every selected row already has that exact target state, using the staged value when present and the saved value otherwise.
- Mixed eligible selections enable both choices.
- Disabled explanations distinguish saved from staged state, and disabled commands remain focusable without activating.
- Existing permission and workflow blocks take precedence.
- All bulk state menu commands are blocked during active ledger work, incomplete selection reads, unknown write outcomes, or transfer review.
- Unrelated ordinary staged fields do not block them.
- Reversing a staged choice preserves the explicit absolute target.
- Reset, or cycling the toolbar C control, restores Leave unchanged.
- Local Reconciled remains distinct from the Cleared command target.

### Staged changes and individual commands

- With staged bulk edits, right-clicking an unselected row preserves the selection/draft and reports `Save or cancel the staged changes first`.
- A selected-row menu may add clearance, review or manual-clearance state to the staged fields, including when only one selected row remains. These use the same Mark selected commands as a larger selection.
- Move, Delete, Find transfer, and other workflow commands stay disabled until Save or Cancel.

### Duplicate, move and delete

- **Duplicate transaction** is single-row only for a persisted visible parent other than a starting balance or missing-pending row.
- It opens a new manual draft dated today in the browser, copies effective Description internally, and copies Payee, target, amount, memo, flag, and the complete ordinary or split category breakdown. It copies no identity, provider payload, rule decision, accepted match, transfer connection, edit token, or workflow state.
- The create command references an eligible visible source in the same account to copy its current effective Description internally. It refuses a removed or ineligible source. The reference is not saved as transaction identity or workflow state.
- Local duplicates start Uncleared.
- Plaid-workflow duplicates start Unmatched and Reviewed.
- **Make recurring** is single-row only for an eligible whole visible parent other than a starting balance, excluded or missing-pending row. It opens the scheduled draft described below, copying effective Payee, target, ordinary Category, memo, and amount without changing the source. Splits are not offered.
- A duplicated transfer carries an open destination only as an unsaved proposal.
- A closed destination is cleared with an explanation.
- Saving enters the shared transfer proposal.
- Cancel writes nothing.

- **Move to account** supports one or many eligible manual parents through one destination dialog and one atomic command.
- Linked/attention transfers require Unlink first.
- Mixed eligibility or stale targets reject the complete command.
- A cleared or reconciled row may select a Plaid destination, but submission rejects with `Cleared transactions can't be moved into a Plaid-connected account; mark uncleared first` and retains the chosen destination.
- An Uncleared manual row moved into a Plaid-workflow account clears any prior feed-history marker, becomes Unmatched, and retains review state.
- A manual unmatched row moved local retains its ordinary clearance.
- Success stays in the source account, clears selection, and reports the moved count and destination.

- **Delete transaction** and **Delete N transactions** apply only to eligible manual parents and use one confirmation showing count, signed total, split scope, affected transfer-link count, and that opposite transactions remain.
- Mixed eligibility or stale targets reject atomically.
- Confirmed deletion is reversible through the current page's Undo history while its dependencies remain unchanged.
- It has no permanent trash or restore workflow.

### Linked-transfer navigation

- Linked transfers offer **Inspect connections…**. The connection view confirms **Unlink transfer** before changing the link.
- **Go to other account** is enabled when the visible partner can be opened, including when transfer amounts disagree. It stays visible but disabled with `The linked transaction is no longer available` when the partner is unavailable. All Accounts uses **Go to linked transaction** in either state.

## CSV export

- One bordered Export button sits in the upper-right workspace action row beside Sync Plaid.
- It opens one two-column dialog: account checklist on the left and an Include group on the right with independent Transaction History and Scheduled Transactions checkboxes.
- Default Transaction History on and Scheduled Transactions off. Require at least one export type. Each selected type produces one CSV for the selected accounts.
- Show date range, split representation and Include bank-pending transactions only while Transaction History is selected. Preserve their drafts while toggled off and ignore their validation and values for a schedules-only export.
- Reuse Weft's shared Modal, Button, picker composition, typography, and colors.
- Stack the columns in narrow windows.

- Default to the current account, or every account from All Accounts, with All dates, Include bank-pending transactions enabled, and One row per transaction.
- Allow multiple accounts or All accounts, including labeled closed accounts.
- Require at least one account.
- Offer All dates, This month, Last month, This year, Last year, and an inclusive Custom range.
- Export presets follow the browser's local calendar and send explicit date bounds.
- Existing register presets continue to follow the server calendar.

- Export full saved history independently of ledger filters, selection, sorting, and loaded pages.
- Use the ledger's current visible-parent projection and effective matched metadata: accepted manual/Plaid pairs once, starting balances included, removed rows excluded, and transfers represented in each selected account.
- Pending exclusion removes active and missing bank-pending rows, including manually cleared pending rows.
- The dialog explains that those rows count in Cleared but are omitted when bank-pending transactions are excluded.
- Included missing pending rows carry an explicit marker.
- Status retains provider lifecycle and Manual clearance is Yes/No.

- One row per transaction exports the parent amount, with Split in Category for split parents.
- One row per category exports each saved allocation's category, subcategory, memo, and amount without an additional parent amount row.
- Preserve repeated-category lines, No category, and Unassigned split.
- Repeat parent metadata and parent memo on each allocation row.
- Keep category memo separate.

- Fixed columns are Transaction ID, Account, Date, Payee, Description, Bank description, Category, Subcategory, Memo, Category memo, Amount, Outflow, Inflow, Balance, Status, Manual clearance, Reviewed, Source, Flag, Transfer account, Transfer state, and Missing pending.
- Bank description matches the ledger’s bank-description column: the visible Plaid row’s own bank text, blank for manual and starting-balance rows. Keep the existing Description field separately for its effective/stored description.
- Amount remains signed. Outflow and Inflow use positive magnitudes with the opposite direction blank; zero belongs to Inflow.
- Balance is the per-account ledger balance after the entire transaction in canonical chronology. Compute it from complete visible account history before export date/pending filters. Leave it blank for missing-pending, excluded or uninitialized contributions under the ledger's balance policy. Allocation rows repeat their parent transaction's balance; they do not have separate running totals. Exported balances are independent of the browser's Balance-column visibility.
- Preserve full stored text and blank null payees.
- Use ISO dates, exact two-place signed decimal amounts, Yes/No booleans, UTF-8 BOM, and standard CSV escaping.
- Neutralize spreadsheet-formula-like textual values.
- Order accounts by retained sort order/ID, then transactions by canonical ascending chronology, preserving allocation order.
- Empty results produce headers only.

- Opening uses the existing ledger-work guard, including active transfer queues.
- Export choices remain local.
- No settings or ledger values are written.
- The footer's Export action downloads one file through the browser's ordinary download mechanism. Selecting only Transaction History or Scheduled Transactions downloads that CSV directly. Selecting both downloads one ZIP containing the two CSVs, without subdirectories. Each CSV retains its columns, generated name and UTF-8 BOM.
- Use the generated account/date filename for history and account-based filename for schedules. The ZIP uses the history filename with .zip in place of .csv. Explain the CSV-or-ZIP choice in the modal.
- The browser controls the save location, filename dialog, collisions and cancellation according to its download settings. Downloads is supported. Do not request directory access or retain folder handles.
- One authenticated read-only request generates the complete artifact within one database snapshot. Both type choices are explicit booleans and at least one must be selected. Recognized history options are ignored when history is not selected; the frontend omits them.
- Freeze controls and closing during preparation and download handoff. Close after handing the file to the browser. The app cannot confirm disk completion or observe cancellation of the browser's save dialog.
- Preserve choices and show errors on failure.
- A fresh opening resets defaults.
- No scope picker, custom columns, preview/count endpoint, or CSV import is included.

### Scheduled-transactions CSV

- Scheduled Transactions in the shared Export modal includes saved schedules from the selected owning accounts. Default to the current account, all accounts from All Accounts, or current open members from a group ledger. Include labeled closed accounts and require at least one selection.
- Export one row per saved schedule owned by a selected account, including paused definitions. Explain that transfer schedules are exported once from their owning account, with the destination in Transfer account. Selecting only the destination does not export its computed mirror.
- Fixed columns are Schedule ID, Account, Frequency, Next date, End date, Anchor day, Payee, Category, Subcategory, Memo, Amount, Outflow, Inflow, +/- Match, Transfer account, Paused and Pause reason. Preserve the stored next date even when the pane displays Paused. Use the schedule owner's pause policy and original signed amount/tolerance.
- Transaction History options never filter the scheduled CSV. Export saved schedules independently of the pane's visibility and Look ahead setting. Exclude ghost occurrences, mirrors, calculated Projected balance and unsaved drafts.
- Order by owner account order/ID, then canonical next-date chronology with paused definitions last. Preserve ordinary and transfer schedules, recurrence anchors and inclusive end dates. Empty results contain headers only.
- Both CSV files use ISO dates, exact two-decimal money, Yes/No booleans, formula-safe text, UTF-8 BOM and ordinary CSV escaping. Neither export writes financial data or enters history. CSV import and future-occurrence exports remain excluded.

## Shared action controls

### Action dimensions and placement

Ordinary commands use the shared native Button component.

- Size follows surface: `lg` is 32px with 11px text and 4px corners for dialogs/login/rail actions.
- `md` is 24px with 10px text and 4px corners for popovers/toolbars/header/footer actions.
- `sm` is 19px with 9px text and 3px corners in the register.
- Text weight is 700.
- Primary commits use blue fill.
- Default alternatives use white with a border.
- Quiet actions use minimal chrome.
- Destructive actions use red.
- The same variant has consistent hover, keyboard focus, press and disabled styling at every size.

### Ledger action bar

The ledger action bar is 24px tall including its bottom border, expanding when its controls wrap.

- New Transaction is a deliberate footer exception: its button fills the entire bordered section, with square corners and no outer horizontal padding.
- Hover fills that section with the quiet action's light blue.
- Keyboard focus stays inside its boundary and pressing does not shift it.

### Native button behavior

Icon-only actions keep an accessible name and use lucide icons in square controls.

- Native types, refs, aria/data attributes, event behavior and pending labels stay owned by their callers.
- Bulk and split editor actions use separate buttons with an 8px gap, individual borders and corners, and both icons and visible labels.
- Save uses primary styling.
- Cancel uses default styling.
- Save is dimmed and disabled when there are no changes to save.
- Reverting an existing split to its saved values returns it to that state.
- Groups wrap to fit.
- Controls retain fixed height and readable labels.
- Full-height footer separators belong to their containers.

### Stateful and specialized controls

Stateful review, clearance and match controls retain their raised state treatments and share compact size tokens.

- The register and scheduled-pane action columns have the same fixed width. Their row actions use this raised compact treatment. **Enter this occurrence** and **Skip this occurrence** use the neutral uncleared `C` tone. Editing-row ✓ Save and ✕ Cancel use the same raised compact treatment; ✕ keeps a red glyph.

- Navigation, menus, picker options, calendar controls, cell editors and underlined text actions retain their specialized semantics and presentation.
- Searchable FilterSelect popups visibly highlight the option Enter will select. Up/Down move the active option among enabled results; Enter selects that option. With no enabled result, Enter selects nothing. Keep the active highlight distinct from the saved selection, and preserve each caller's Tab and post-selection continuation rules.
- The calendar's 27px controls are a deliberate exception.
- Preserve the existing split labels, icon order, behavior and left alignment when applying this styling system.
