# Manual and Plaid account workflows

This file is part of the [product contract](../PRODUCT_CONTRACT.md). It owns the approved requirements for the sections below.

## Manual-account workflow

- Manual accounts have Review controls, Needs review filtering, review counts, and bulk review. They have no new bank/manual matching, pending-lifecycle, or unmatched-bank concepts. Disconnected accounts retain inspection and Unmatch for earlier accepted pairs.
- Cross-account transfers remain available.

- `+ New Transaction` opens an anchored composer that reserves space below the scrollable rows without moving the action bar. [Scroll behavior](register.md#scroll-behavior) keeps the rows adjacent to entry visible.
- `+ New Transfer` sits between New Transaction and Undo. It opens that same composer with no target, Payee, Category or amount assigned. Fresh New Transaction focuses Date; fresh New Transfer uses today’s date and immediately opens the transfer-target picker. Target selection followed by Enter or Tab focuses Payee. Either resumes an existing draft unchanged at Date; a fresh entry requires finishing or cancelling that draft. New Transfer is unavailable with an explanation when no eligible tracked-account destination exists.
- With **Show new transaction after saving** enabled, confirmed creation and a successful fresh read scroll the actual saved row into view. A subtle translucent blue wash holds briefly, then fades within two seconds while preserving the normal row background and selection borders. Reduced motion uses a static blue edge for two seconds. Neither treatment covers active row editing. This includes duplicates, new splits and confirmed transfer-draft creation.
- Follow respects the current sorting and status grouping. It must not change accounts, filters, selection or focus, or load additional history.
- If the row is outside the loaded or filtered view, explain that it was saved. Name adjusting filters and scrolling to the register's top for earlier history when more history remains.
- Ordinary successful creation gets a polite screen-reader announcement. Automatic matching gets a visible explanation that the entry was saved and matched with a bank transaction.
- If the setting is disabled, retain bottom or reading position under [Scroll behavior](register.md#scroll-behavior). A failed or uncertain save or cancellation must not trigger saved-row follow.
- A confirmed creation followed by a failed fresh read stays saved and reports that the register needs refreshing. A changed view, another editor or a transfer dialog cancels pending follow.

- Date and a valid amount are required. Users cannot author or edit manual Description. New ordinary manual transactions store empty Description; generated or copied internal text remains available to existing workflows.
- Payee is required when creating or editing a manual transaction, including scheduled entry, split parents and duplicates in local or Plaid-workflow accounts. A transfer keeps the actual counterparty in Payee and its destination in the separate target.
- Category, memo, and flag are optional.
- A saved row marked Unknown Payee must select a real Payee before a later edit, including memo or flag changes. Bulk metadata/category saves enforce this on every selected affected row and refuse the whole batch if any retains Unknown Payee. Review/clearance-only commands, moves, provider workflows and Undo/Redo retain their separate rules.

- A new row is manual, approved, and uncleared.

- Existing ordinary unsplit editors support Save/Enter and [existing-row departure](#existing-row-departure). An unchanged editor closes without a write. New ordinary entries follow the separate exit rules below.
- Failed saves retain the editor draft.
- The row’s editors lock during its save and become editable again after failure.
- Moving into another editor, multi-selection or a different workspace saves a changed existing ordinary edit before continuing. Refused, failed or uncertain completion stops departure and retains its applicable draft or recovery state.
- Cancel does not persist.
- Escape cancels an ordinary saved-row edit from its row, text fields or closed picker controls. In an open picker, Escape closes only that picker. New entries use the exit rules below.

- Manual accounts use the shared [two-slot row actions](register.md#layout-filters-and-totals). R acknowledges Needs review, then C toggles ordinary clearance and refreshes balances. Review and clearance stay independent. Eligible rows retain the same review filtering, exhausted-filter reset, row shading and bulk review behavior as Plaid-workflow rows.
- Local account views have no Status column. While a local row shows R, its clearance is available through the context-menu label; after review, the filled or unfilled C shows it inline.

- A local multi-selection can stage Mark selected cleared or Mark selected uncleared through the context menu and bulk toolbar.

- An unmatched standalone manual row can move to another open account.
- Linked transfers require unlinking first.
- Unlinked transfers cannot move into their named destination.

- Eligible manual rows can be deleted after explicit confirmation.

### Existing-row departure

- A completed plain primary click outside a changed existing ordinary transaction or schedule editor saves the whole row. Blank register space counts. Save/Enter remain available; Cancel/Escape discard through the editor's current rules. New entries, bulk staging, split editors and comparison reviews retain explicit completion.
- Row selection, edit entry, account/filter/sort/management navigation and row commands use the same departure guard. After a confirmed save and authoritative reconciliation, continue the latest requested action once in the same view. Resolve its target by stable identity and current permissions/tokens. If the target disappeared or the intent is no longer eligible, stop with feedback; never substitute the row now occupying its screen position.
- Validation failure, stale state, an uncertain result, failed refresh or a required review/confirmation pauses departure. A saved response followed by refresh failure remains saved/recovery and must not be sent again. A departure that required transfer or duplicate-schedule review does not resume the original action afterward.
- A gesture that dismisses an open picker or popover only closes that popup. It does not save or activate another outside destination. Controls inside the editing row retain explicit commands. Unselected search text never becomes an assignment.
- Pointerdown alone, dragging, scrolling, scrollbar/column/pane resizing, focus changes and browser/app switching do not save. A real completed click after activation follows normal click rules. Undo/Redo activation never saves a dirty editor first.
- Click-away uses the normal individual edit command, review-after-edit preference, matching, Payee memory, Undo and outcome/recovery rules. Default-category suggestions retain their asynchronous admission: an already-open dialog pauses continuation; a later suggestion can appear after a completed action or wait for its conflicting workflow. No permanent recovery guarantee is added.

### New-entry exit behavior

These rules apply to new ordinary manual transactions, including New Transfer and duplicates, and new schedule definitions, including Make recurring. Saved ordinary edits follow [existing-row departure](#existing-row-departure). Split editing retains its existing explicit Save and Keep editing/Discard changes protection.

- Clicking outside an entry with only its automatic opening defaults closes it without a write and allows the clicked action to continue. A passive outside click on an entry with work leaves it open without saving, discarding or showing a dialog. Focus moves alone, resizing a pane and switching browser tabs or applications retain the draft. A click outside an open picker closes only the popup and never assigns its highlighted option.
- An entry with only its automatic opening defaults closes without a write when the user activates Cancel, presses Escape or deliberately requests a guarded action that replaces or resolves the entry. Main defaults include today's date; schedule defaults include tomorrow, monthly recurrence, the default source account and no end date.
- Payee, Category, nonblank Memo, an entered Amount or Flag, a changed Date, or changed schedule account/frequency/end date counts as work. Restoring every field to its opening defaults makes a fresh entry empty again. Explicit zero counts as an entered amount. Copied and Make recurring values are work even before further edits; copied zero amounts display as entered.
- Save or Enter in a text/amount field attempts to save. An incomplete entry uses the existing dialog with all locally determinable missing or invalid fields, including for a default-only entry. Ordinary Payee/Date/Amount, transfer eligibility/nonzero amount, schedule recurrence and date conditions remain unchanged; optional fields are not missing requirements.
- With work present, Escape, Cancel, or an account/filter/sort/management/selection/other-editor action that resolves the entry asks whether to discard. It never saves implicitly, even if the entry is valid. Offer **Continue editing** and a danger **Discard transaction** or **Discard schedule** action. Continue receives initial focus; dialog Escape and overlay clicks continue editing. Validation continuation focuses the first blocking field; discard continuation restores the prior field.
- Continue editing, refusal or unresolved recovery cancels the intended action. Discard completes the guarded action once, subject to remaining guards. New Transaction/New Transfer resume an existing manual draft at Date without changing its intent. New Scheduled and its New Transfer resume an existing schedule draft without changing its origin or values. Collapsing the scheduled pane resolves its new draft first. Editor presence continues to block conflicting writes and automatic suggestion dialogs even when empty.
- Date, Payee and Category retain picker acceptance and cell continuation. Schedule Account and Frequency accept the focused option with Tab or Enter and advance. Picker Escape closes only the popup; a subsequent Escape requests editor cancellation. Search text is a filter, not an assigned value.
- When an entry owns an unknown sent-write outcome, discard and exit wait for prescribed inspection. A committed save followed by failed refresh stays saved and requires recovery; it must not become an unsaved entry or be sent again. Quick-payee creation retains its independent persistence and recovery rules.
- Keyboard close/discard returns to its initiating entry control only while focus has not moved elsewhere. Pointer continuation retains destination focus. The browser's refresh/close warning protects open register and schedule drafts; it is separate from in-app departure and cannot save them.

Both ledgers show an ordinary editor's controls in its fixed-width Actions cell: a raised ✓ Save button (**Create** for a new entry) and a raised ✕ Cancel button with a red glyph, with hover text **Save (Enter)** and **Cancel (Esc)**. Disable Save on unchanged saved edits. Clicks on these controls do not change row selection. Split editors keep their own controls.

## Plaid-account workflow

### Connection and six-hour background sync

- Plaid Link token creation and exchange either map selected provider accounts into new local accounts or stage the approved existing-account connection workflow, and store encrypted access tokens under the applicable custody state.

- Startup, initial connection, on-demand, and six-hour background sync import added and modified transactions, track removed pending rows, refresh balances, and run guarded first initialization. The [post-restore bank-activity pause](system.md#bank-activity-after-restore) takes precedence until the first admitted manual Sync Plaid action.
- Startup sync is immediate and nonblocking.
- Successfully fetched but incomplete initial histories receive at most ten one-minute follow-ups scoped to incomplete items through the existing serialized sync owner and scheduler.
- Failed items use ordinary or manual retry.
- Exhausted follow-ups show a retry path.
- Readiness is committed with applied history and cursor.
- Before any Item's transaction apply or cursor advancement, its fetched provider account IDs must include every currently mapped account ID.
- If one is missing, stop that Item atomically and name the affected local accounts.
- Siblings on that Item pause together until access is restored or the missing mapping is explicitly disconnected.
- Other Items continue.
- Local status polling exposes background completion without reloading.
- Manual **Sync Plaid** keeps its button disabled as **Syncing…** until the account and register refresh finishes. It preserves sorting, filters, selection, focus and loaded history. Its refreshed rows obey [Scroll behavior](register.md#scroll-behavior), including retaining a reading position away from bottom.
- Manual, six-hour background, startup, status-driven, initial-connection and initialization-retry syncs share that preservation rule. Sync does not request separate scroll navigation.
- One institution's failure never blocks successful institutions.

### Reported balance history

- Successful bank refreshes retain one immutable reported-current-balance observation per mapped account, including repeated and unavailable values. Store the accounts-response receipt time on the existing local application clock, currency, optional provider balance-update time normalized to that clock, and a per-mapping identity that changes on reconnection. Commit observations with the existing provider transaction; failed refreshes, page reads and abandoned connection staging add none. Connection confirmation retains the selected staged balance at its original fetch time. No additional provider request is made.
- Latest account fields remain the sole balance source for Bank difference, the footer and initialization. Historical observations never fill a missing current balance. Closing, disconnection and Re-init preserve observations; account deletion removes them. Financial backup/restore includes observations. Keep all observations without automatic pruning. This is sampled reported-balance evidence, not daily closing balances, a historical net-worth report or statement reconciliation.

### Sync status and workspace notices

- Last-sync time, result counts, review count, missing-pending count, and account-attributable, safely worded success/failure notices remain visible and survive an ordinary process restart. While recovery pauses bank activity, the [red recovery label](system.md#bank-activity-after-restore) occupies the sync-time location instead.
- Each Plaid Item stores two freshness times, which survive restarts: **Bank to Plaid sync**, Plaid's last successful transactions update from the bank (read with a free Item status request during each Item sync), and **Plaid to Weft sync**, the end of that Item's last successful Weft sync. Weft reads the Item status before transactions, so a failed Item sync still records Plaid's status; it does not change Plaid to Weft sync.
- The sync-time location beside **Sync Plaid** shows both times stacked on two lines, labels aligned left and times aligned right. For a single Plaid account it shows that account's Item. For All Accounts, a group or a manual account it shows the oldest time of each kind across the Items in scope, or across all Items when none is in scope. An unknown time shows **—**, and an unknown time counts as oldest. Hovering lists both times for every Item.
- When the shown Bank to Plaid sync time is more than 24 hours old, its whole line sits in a soft amber box with bold amber text. No warning text is added. This is a display only; it adds no notice and does not change sync.
- Hover text for each Item adds **Plaid's last attempt failed {time}** when it is Failing and **Needs sign-in** when it needs sign-in.

#### Bank health

- Each Item also stores Plaid's last failed transactions update (`last_failed_update`) when Plaid reports one. An Item is **Needs sign-in** when a current sign-in/consent issue covers any of its accounts; otherwise **Failing** when its last failure is newer than its last success, or it has a failure and no success; otherwise healthy. **Behind** is the existing 24-hour amber state.
- Failing and Needs sign-in show the red account icon described in the [account rail](accounts.md#account-rail-and-selection). Health is display only; it adds no notice, does not sync and costs nothing.

#### Refresh from bank

- **Refresh from bank…** asks Plaid to contact the bank now for one Item through Plaid's `/transactions/refresh`, which can count toward the Plaid plan's usage. Sync Plaid never requests a refresh.
- It opens a confirmation naming the institution and every Weft account on that Item, stating that each refresh may count toward the Plaid plan's usage. Each confirmation sends at most one request; Weft does not retry it automatically and does not coordinate refreshes across browser tabs or installations.
- After Plaid accepts it, Weft runs two ordinary syncs of all Items about two and six minutes later, without further refresh requests, so new data arrives without another press.
- Outcomes are distinct notices: Plaid refuses the endpoint for this Plaid account (**Refresh isn't enabled on your Plaid plan.**); the bank or Item does not support Refresh; sign-in is required (recorded as the Item's sign-in issue, so Repair and the red icon appear); a temporary provider failure or rate limit; or a lost response, which may still have reached Plaid and counted toward usage, so the notice says to wait for the next sync instead of retrying.

- Provider sign-in/consent errors, missing mapped accounts, local token custody failures, temporary provider failures, and non-fatal transaction warnings are distinct.
- Missing-account notices identify the account actually needing access restored and explain that shared-Item siblings pause.
- Warnings do not imply a failed repair.
- Raw Item IDs, access tokens, and provider exception text never appear in user-facing errors.

- Sync summaries contain counts only.
- Bank errors and nonfatal transaction notices appear as independently dismissible, account-attributable cards.
- The first observed payload for a new completion timestamp supplies its cards.
- Same-timestamp polling cannot replace them with in-progress counts or issues.
- Dismissal remembers the completion timestamp and individual card keys in the browser across reloads.
- A new completion shows a new summary.
- Dismissed issue keys remain suppressed while the same semantic issues persist, including scoped initial-import follow-ups, and clear once a later observed completion omits them.
- Undismissed issues can appear and announce again on reload.
- Required write-recovery alerts remain visible until their owning condition clears.

### Provider lifecycle and manual pending clearance

- Plaid owns imported identity, date, description, amount, and pending/cleared lifecycle.
- After starting-balance initialization, an active pending Plaid parent offers **Mark cleared manually** or **Undo manual clear** through its context menu.
- Eligible selections also support staged bulk manual clearance.
- This separate user-owned override moves its signed amount from Uncleared to Cleared without changing Working, provider status, review state, matching eligibility, or its transfer counterpart.
- Ordinary, split, accepted-match, and transfer parents are eligible.
- Manual, posted, missing-pending, excluded, starting-balance, allocation, and draft rows are not.
- After account initialization, visible unmatched planned manual parents permit ordinary Cleared/Uncleared status. Ordinary, split and transfer parents share this permission. Clearing preserves Working, review, matching eligibility and the other account's transfer side. Amount and metadata edits preserve ordinary manual clearance. Historical manual rows retain their local status controls.
- Planned manual clearance uses ordinary status, not the bank-pending C* override. It can align Cleared with the bank-reported balance before a bank transaction arrives. Bank difference remains Cleared minus bank current; no balance equality infers clearance or suppresses the warning.

- Manual-clear commands validate current row state and edit token atomically and use explicit set/undo intent.
- Unchanged pending imports retain the override.
- Posting retires it.
- A changed amount on an overridden row retires it and marks Needs review, including ordinary unsplit rows.
- Removal retires it before the existing missing-pending workflow.
- Reappearance does not restore it.
- Pending/posted consolidation and conflicts retain existing survivor and visibility rules, never duplicate its contribution, and never carry the override to a posted survivor.
- Explicit resolution retains its existing Reviewed result.
- Overrides are not copied to duplicate drafts, hidden manual sources, or transfer counterparts.

- Manually cleared pending rows display `Cleared*` with a green status dot and red asterisk.
- Hover/focus and accessible text say `Manually cleared. Still pending at the bank.` All status-column labels use identical neutral text color, font family, size, and regular weight.
- Dots alone carry status color, with the manual-clear asterisk as the sole text-color exception.
- Posting returns the label to ordinary Cleared.
- Status filtering says **Bank pending** for pending provider membership and **Cleared** for ordinary cleared rows, including local accounts. Planned rows retain their separate Unmatched identity.
- A manually cleared pending row remains Bank pending and cannot serve as a posted replacement.

### Review and matching

- Each row’s `R` toggles only that row.
- Bulk review is staged through the multi-apply toolbar.
- After a successful review save and fresh register response, an exhausted review queue clears only Needs review, preserving selected statuses and all other filters.

- Confirming a match, link, or merge in a transaction comparison dialog sets the resulting visible row or rows Reviewed in the same atomic operation.
- Already-reviewed rows remain Reviewed.
- Hidden manual originals keep their own review state.
- Opening, inspecting, choosing candidates, cancelling, dismissing, unmatching, unlinking, or confirming disappearance does not newly review surviving rows.
- Automatic matching and Plaid lifecycle updates retain their existing review inheritance and reset rules.

- Suggested and manual matching under the amount rules below compare both rows, let the user choose field sources, project one accepted ledger row, allow inspection, dismissal, and unmatch.
- Match comparisons use a frozen field-label column and horizontally scrollable source columns. Show actual retained bank predecessors in association order, the current bank comparison, then Manual. Open with the current bank and manual columns in view. Each source column can collapse independently. Same-ID posting does not imply a retained pending snapshot. Earlier bank columns show their own stored fields and applicable Pending?, Pending or Cleared status; the current bank comparison retains its bank-continuity field ownership. Read-only history adds no field choices.
- Connection inspection is titled **Transaction connections**. Accepted matches keep their existing comparison; bank-only and transfer-only rows share the existing source inspector. A transfer-only view shows the local original and **Transfer · account name** with both columns visible initially, without an empty Manual column or field-choice controls. Label a manual local source Manual and identify its account. Only real retained bank identities appear. The two account sides can have different source counts.
- With local bank/manual history, append one read-only current visible transfer counterpart labelled **Transfer · account name**, initially offscreen to the right. It shows current effective values without the other account's lifecycle variants. Explain an unavailable counterpart without manufacturing a row. Suggested comparisons show only the bank group's existing counterpart, not a speculative combined link. A suggested manual row can inspect its own stored connection separately from its menu.
- Server-owned read admission for connection inspection is distinct from correction permissions. It can expose stored connections without enabling Unmatch, bank-edge correction or Unlink before the required account setup finishes. The setup ledger stays blurred and inert. Hidden originals and unlinked destination intent do not gain an inspection entry. A hidden counterpart retains an explanation and any permitted Unlink; navigation remains unavailable.
- Connection inspection shows controls for actual bank edges, the accepted manual match and the transfer link, subject to the effective visible representative's permissions. Unmatch controls name both endpoints: **Unmatch ‹source› from ‹target›**. The transfer control reads **Unlink Transfer** and does not name the anchor. Suggested, manual and finder comparisons have no destructive relationship controls. Transfer finding/creation has no separate linked inspection or Unlink branch.
- Each correction opens one inline danger confirmation with server-derived evidence and consequences, Cancel and the confirming action. Disable conflicting controls while saving, retain errors and choices after failure, and use the existing unknown-outcome recovery. Connection-inspection footers contain only Close. Suggested keeps Cancel, Not a match and Match, its rationale and possible-duplicate consequence. Put bank-edge evidence in heading tooltips and confirmations; omit generic notes below the grid. Reads, scrolling, collapse and cancellation never write or mark Reviewed.
- Explicit Unmatch requires the inspected relationship token. It reveals the manual original and rebuilds suggestions without automatic acceptance. The manual entry stays separate through local edits until a later successful Plaid sync for its account. Explicit Match can override this hold. A failed sync cannot release it. Lifecycle expiry creates no such hold. Dismissed logical bank/manual pairs remain blocked through active bank-continuity identities. A successful sync that releases the hold changes history dependencies and can invalidate Undo of Unmatch or later dependent commands under the existing conflict policy.
- On explicit or automatic acceptance of a cleared planned manual row, hand its clearance decision to the bank parent once and set the hidden manual original Uncleared. An eligible pending bank parent receives C*; a posted parent already counts as Cleared. An uncleared manual row does not change the bank parent's clearance. Suggestions and historical matching do not hand off clearance.
- Undo manual clear on a matched pending parent changes only the bank flag. Unmatch reveals the consumed manual original Uncleared and retains the bank parent's own clearance. Existing provider posting, changed-amount, removal and reappearance rules retire the transferred override; match expiry does not restore it on the manual original. Capture both rows for undoable match saves. Provider lifecycle remains outside Undo.
- Suggested matches show a rounded-square amber button with embossed shading and the tooltip and accessible label `Possible match — review` on both the Plaid row and the manual row. Its icon shows two filled, vertically offset half-circles: the row's own half is bright and its partner half is dimmed. The Plaid row's left half is bright. The manual row's right half is bright. Either row opens the same suggested-match review. The blue chain means the visible row has existing transaction connections: an accepted match, retained bank association, or reciprocal transfer link. A transfer target without a partner does not qualify. Both visible transfer sides, including local/manual accounts, can show it. Pending? resolution keeps the merge icon and takes priority; a possible match keeps amber next; otherwise show the chain. The chain tooltip and accessible label are **Inspect connections**.
- A single eligible live bank row, planned manual row, or historical Manual/Plaid parent in a Plaid-workflow account offers **Find match…**.
- It searches active visible eligible rows in the same account with the same signed amount, or an unequal pair admitted by the entered schedule tolerance below, excluding starting balances, excluded and missing-pending rows. Ordinary planned matching retains opposite-source and unmatched admission. Historical and conversion matching remain exact-only.
- Explicit historical matching admits one live, non-historical Plaid row and one historical Manual or Plaid parent. A historical accepted parent can be superseded; a live accepted parent cannot accept another pair. Historical matching never runs automatically.
- Nearby dates means seven calendar days.
- All dates removes only that limit.
- Results are stably ordered by date distance, date, then visible ID and page on demand.
- A sole result is selected for preview even when that pair was previously dismissed.
- With multiple results, the first non-dismissed result is selected.
- Dismissed pairs remain visibly labeled as previously marked not a match, and **Match** remains the only write.
- Selecting a candidate reloads the authoritative comparison and token.
- The two-row shortcut remains exact-only and opens its deliberately selected comparison for one live bank row and one eligible planned or historical parent, including a previously dismissed pair. Use the single-row Find match command to inspect an unequal pair within an entered schedule tolerance.

### Missing-pending resolution

- A missing pending row explains its state, recommends a cleared candidate when evidence supports one, allows choose-from-ledger, resolves atomically after field comparison, or can be confirmed as disappeared.
- Recommendations and automatic pending inference share the complete account candidate pool and explain competition in either direction.
- Explicit resolution marks the chosen surviving row Reviewed even when the posted amount differs.
- The pending column is read-only. The chosen cleared target supports explicit Payee, Category and Memo edits, saved atomically after association, anchor rehoming and matching under ordinary ledger permissions and ownership. Editing selects Cleared ownership for that field; selecting Pending discards that field override. Description, date, amount, status and provider payload remain bank-owned. Keep complete split choices and disable inline Category replacement when either input has allocations. Partner-owned targets retain their existing locks.
- Explicit resolution confirms the resulting real Payee for directional transfer memory only when the surviving row has a transfer target. It never edits or teaches the remote cross-account partner. Show that resolution and its inline edits cannot be undone and end earlier page Undo history; retain the existing outside-Undo policy. No target editor appears before choosing a cleared row or for Charge disappeared.
- Missing/live pending cleanup can hide an attention-only duplicate under the narrow rules below. Saved-work pending/pending replacement remains manual: edit the live row and confirm disappearance. No dedicated pending/pending carry-details action is offered.

### Automatic pending continuity

- Settle authoritative provider identities before inferred bank continuity, manual matching and cross-account discovery. Run inside the complete Item or existing command boundary; no separate worker or historical sweep.
- Same provider ID updates that retained record in place. A distinct posted ID naming a pending predecessor creates or uses its own row. Retain both IDs, raw facts and local fields, including superseded IDs. The posted row becomes visible and the pending row points to it. This replaces the former pending-local-ID survivor rule.
- Require an active feed and complete historical download for inference; account initialization is not required. Revisit eligible records on empty successful syncs.
- Without a provider predecessor, active pending/posted pairs require exact signed cents and the same reported date. Missing pending/posted pairs require exact signed cents and at most four calendar days. Prove strict uniqueness in both directions across seven days, including live pending and actionable missing pending competitors, independently of payee agreement, filters and pagination. A crowded pending/posted neighborhood can instead prove uniqueness through complete bank-merchant groups: after trimming and case folding, every context record must have a nonblank bank merchant name, and every merchant group must have exactly one pending and one posted record satisfying the same amount/date/stage and rejection checks. Payees and Payee rules do not supply this evidence.
- After withdrawing intrinsically invalid inferred associations, freeze merchant-pair proofs over the complete same-amount records within seven days of either candidate before competition rechecks or new pairs. Apply bank availability per record. Include original members of simple `inferred_posted` associations, and retain otherwise available expired pending records as context only. Expired records remain ineligible for new pairing. Exclude complete provider-linked and explicitly associated components and resolved records. Any available member of an inferred pending/pending or multi-hop component blocks the merchant exception in that window; its existing coarse-unique path remains. Orphan, missing-name, repeated-merchant and structurally rejected groups block the whole exception. Existing saved-work conflicts still require review for each pair under the association owner. Rechecks use the same proof, so pairing order, Payee/rule edits and grace expiry alone do not alter the merchant proof. Provider facts and new competitors retain their existing invalidation rules.
- New missing/live pending cleanup requires exact signed cents/date, agreeing available merchant/name and ordinary payee/category/memo/flag, strict uniqueness including posted alternatives, and no split, accepted manual match or transfer anchor. Hide only the missing zero-contribution warning. Copy no metadata; retain the live row's clearance and review state. Later user work on an established live representative does not undo the cleanup. Two active pending rows are never inferred as one.
- Conflicting splits, destinations, partners and accepted manual relationships require explicit review. A conflicting pending predecessor remains actionable without a duplicate contribution. An unsupported predecessor claim between already-posted facts leaves both contributions visible and Needs review.
- Permit at most missing pending to live pending to posted: two inferred hops. Do not extend same-stage chains or create cycles. Valid associations compete once after contradiction checks.
- Retain field ownership per association. Default to the pending saved Payee, assigned Category/breakdown, nonempty memo and flag; fill absent fields from posted. Transfer target ownership is independent of Payee and Category. A partner-owning source fixes the target to the partner account. A representative edit writes that representative and selects its ownership. Hidden originals retain their fields except when an [explicit Payee assignment](categories-and-payees.md#selection-and-assignment) updates their Payee. Amount-corrected splits materialize before ownership changes.
- Retarget an accepted manual relationship and bank-owned transfer anchor atomically. A manual original's anchor stays on that manual. Preserve automatic review inheritance; structural conflicts and amount-corrected splits become Needs review. Explicit resolution remains Reviewed. Never carry C* to posted.
- Reappearance or independent posting of a source, amount/date changes and new competition invalidate inference when its rule no longer holds. Automatic withdrawal marks the representative Needs review. A genuine provider contradiction blocks re-inference until authoritative evidence overrides it. Unchanged replay retains valid association and later review decisions. A late authoritative predecessor overrides local inference without deleting identities or independently imported contributions.
- Inspection on the representative shows original retained bank records and the current bank original, with per-edge controls under the matching rules above. The effective representative supplies permissions separately; never label its combined fields as the current bank original.
- Rejecting one selected bank edge leaves the other edges intact. Use the current full-chain token, including grace visibility and relationship consequences, through the ordinary ordered command and Undo capture. Persist all rejected member pairs across the cut so later splits cannot erase the negative decision. Explicit decisions may override them.
- Confirmation states whether the separated source contributes, returns as zero-contribution Pending?, or remains hidden after grace. Restore unchanged saved manual-match and explicit bank-anchor handoffs for the selected edge. Preserve later explicit work and mark the visible representative Needs review when guarded restoration cannot apply. A manual-owned anchor stays with its manual original. Never restore a retired C* override. Explain when a restored match can expire under removal rules; expiry permits later matching on an edit or sync and does not create the explicit-Unmatch hold.
- Withdraw automatic transfer links only when their stored original endpoint depends on the separated source side. Preserve links belonging to the surviving side. Reuse guarded restoration of unchanged automatic classifications and preserve later edits.

### Resolved markers and selection evidence

- Provider-confirmed continuity, explicit resolution and in-place posting set the persistent pending-resolved marker. Inferred continuity uses its separate association record. Later imports retain markers. Marked cleared rows remain outside new inferred replacement candidates; explicit comparison remains available.
- Manual/bank matching requires exact signed cents, mutual uniquely closest dates across the seven-day pool, and at most six calendar days for automation. Saved-payee equality and mandatory PFC evidence are not gates. Ordinary splits remain eligible; whole transfer rows require compatible intent and structural relationships. Ties remain for review.
- Conversion's historical matching retains its staged four-day preselection and explicit acceptance; ordinary automation never adopts historical overlap.
- Payee rules normalize import assignments and can explain suggestions. They cannot override saved fields or decide identity by themselves.
- A changed effective field writes the representative and selects its bank ownership. No-op saves preserve ownership. Ordinary edits retain the hidden manual and bank originals' data. Transfer materialization selects the representative even if effective values already agree.

### Field conflicts during pending resolution

- Explicit comparison retains complete source-owned Category/breakdown choices and Payee/memo/flag choices. Transfer combinations choose Payee and target independently, subject to the partner-owning source fixing its target. Category remains independent.
- Provider-confirmed continuation uses pending-owned defaults when structurally compatible; imported fallback payee disagreement alone does not block continuation.
- Preserve conflicting saved categories, splits, targets and partners for explicit comparison. Keep provider-linked conflicts actionable and excluded from duplicate balances.

### Excluded bank imports

- **Exclude transaction** is a reversible single-row command for a visible posted Plaid parent or standalone frozen detached-bank parent after historical sync and starting-balance initialization.
- Ordinary and split rows in either review state are eligible.
- Manual rows, starting balances, allocation children, drafts, multi-selection, pending/missing-pending rows, and active edits/writes are not.
- Accepted matches require Unmatch first.
- Linked/attention transfers require Unlink first.

- Exclusion retains provider identity and user-owned payee, category/splits, memo, flag, and review state but removes the row from the active ledger projection, balances, running totals, category usage, payee history, transfer/match candidates, and ordinary exports.
- It never changes starting balance or creates a compensating entry.
- A suggested bank/manual match is removed atomically without recording Not a match.
- The manual row remains active and restoration may generate a new suggestion.

- Confirmation says bank identity and user fields are retained and the transaction can be restored. It previews Cleared and Working before/after and adapts its message: say when exclusion brings Cleared in line with the bank-reported balance, otherwise show the resulting difference as a yellow warning.
- After success, clear selection and remain in scope.
- The row disappears from All and remains crossed out in All sources.

- The default scope is **All**.
- When the account has excluded rows, the footer shows one scope toggle: **Excluded (N)** from All and **All (N)** from Excluded.
- The Source dropdown offers All, Excluded bank imports, and All sources.
- All sources combines active and excluded rows and is never the default or a footer-toggle destination.
- Plaid imports show a generic bank source icon. Excluded rows are read-only, never affect totals, and show that icon under a thick red X whose accessible/hover text is `Excluded Plaid transaction`.

- Mixed active/excluded selection is allowed in All sources and Selected total includes every selected amount, but every write is disabled with `Active and excluded transactions can't be changed together`.
- No partial action runs.

- Excluded rows offer **Restore transaction** or atomic **Restore N transactions** through the same context menu.
- Confirmation previews aggregate Cleared/Working changes.
- Restore uses Plaid's latest date, description, amount, and posted state while preserving user-owned fields.
- A changed ordinary transaction stays ordinary.
- Only an already-split row receives an Unassigned split for the amount delta and becomes Needs review.
- Otherwise preserve review state.

- Restored rows disappear from Excluded or lose the red X in All sources.
- Remain in the current scope, clear selection, and report the count.
- Restoring the final excluded row returns an excluded-only view to All because the toggle disappears.

- If Plaid reports an excluded posted transaction removed, retain a hidden suppression record with its provider identity but omit it from the Excluded view/count and restoration.
- If the same identity returns, update it and return it to Excluded, never active.
