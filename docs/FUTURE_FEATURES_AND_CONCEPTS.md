# Future features and concepts

This is the unfinished-work queue. A recorded defect concerns existing behavior; an authorized fix restores the [product contract](PRODUCT_CONTRACT.md). An idea or pending decision does not expand scope. Listing an item here does not start work.

Distinguish reproduced defects, source-traced leads, unverified acceptance and proposed features. Use synthetic reproductions and public source references. Remove resolved or deliberately dropped entries.

## Unverified defect leads

### Rule restoration UI observations

Unverified lead: typing a full account name into the rule workbench's non-searchable account select landed on another account that shares its prefix. Home and explicit arrow navigation selected the intended account. The observation came from automated input on 2026-10-20; reproduce it by hand before attributing it to application code instead of native typeahead or automation timing.

Pending decision: searching a full Payee name and pressing Enter selected an earlier alphabetic substring result in two cases while the exact Payee was also listed. This follows the [picker contract](contract/register.md#keyboard-entry): Enter accepts the active result, and typing activates the first match. Ranking exact matches first is an unapproved product idea.

Preserve current rule-preview and dirty-draft behavior during any investigation.

### Ordinary rule-editor height

Multi-condition rule editors may shrink or scroll internally in short windows. The amount editor has a scoped height correction in [blueprint.css](../frontend/src/blueprint.css); reproduce a defect in ordinary text/account editors before extending it.

### Calendar month jump

A reported Up/Down month jump remains unconfirmed. Isolated Chrome checks on 2026-10-08 followed the [keyboard contract](contract/register.md#keyboard-entry) in the new-transaction and new-schedule date pickers: Up/Down moved seven days, crossed month and year boundaries only when the destination left the displayed month, and returned on the opposite key. Arrow movement left the draft unchanged, Tab/Enter accepted and advanced, and Escape preserved the draft.

Hypothesis only: at a boundary the calendar redraws and focus lands in the first row of the next month's grid, which satisfies the rule but can look like a jump. Reproduce a mismatch with its starting date, focused control, editor entry point, browser and exact key sequence before changing navigation. Do not add navigation state or neighboring-month presentation without one. Browser-native date inputs in export and conversion are separate controls.

### Ledger ResizeObserver warning

Isolated Chrome entry checks emitted `ResizeObserver loop completed with undelivered notifications.` No visible rendering failure was observed. Identify the observer and reproduce a visible effect before changing layout behavior.

### Pending bank identity investigation

Ambiguous pending/posted chronology needs provider-lifecycle evidence before classifying replacement, duplication or genuine activity. Follow [automatic pending continuity](contract/account-workflows.md#automatic-pending-continuity) and [incremental automatic transfer discovery](contract/schedules-loans-and-transfers.md#incremental-automatic-transfer-discovery). Two active pending records are never inferred as one.

The implemented bank-merchant exception does not settle every provider chronology question. Rule-based identity evidence remains deferred until a missing-merchant or alias case justifies its evidence lifecycle and failure handling. Rules already run before pairing. A dedicated saved-work pending/pending review action is optional and unapproved.

Before resolving a new example, privately capture both local and provider IDs, removal and predecessor links, raw bank facts, saved edits and which row contributes to Working. Keep both rows, and compare after a later ordinary successful sync. The investigation authorizes neither a provider event store nor further automatic merge rules.

## Acceptance gaps

### Screen readers and input methods

Screen-reader and installed input-method acceptance remains pending. Keyboard checks do not prove spoken output or native composition behavior.

- Check searchable FilterSelect announcements, highlighted Payee/Category options and focused calendar dates.
- Check composition-ending Enter on a real input method, including Safari. Dispatched composition events are insufficient.
- Exercise other operating systems and native context-menu/modifier-click combinations. Isolated macOS Chrome, Firefox and WebKit checks cover the exercised calendar, picker, dialog, manual/schedule entry and short-window filter paths only.
- Preserve [saved-row click-away behavior](contract/account-workflows.md#existing-row-departure) and [new-draft exit rules](contract/account-workflows.md#new-entry-exit-behavior) during follow-up.

### Installed Safari keyboard acceptance

Installed Safari remains unverified despite isolated WebKit checks. Check native date-field Tab departure, toolbar focus handoffs and whether the page behind a dialog scrolls. This is a review lead, not a reproduced Safari defect.

## Conditional engineering work

### Automatic Payee cleanup

[Reference inspection and explicit replacement](contract/categories-and-payees.md#reference-inspection-and-replacement) provide deliberate management of retained originals. Automatic cleanup, silent suppression and fuzzy merging remain deferred. A future proposal must distinguish intentional manual Payees from imported fallbacks, preserve original choices on separation and avoid results that depend on import timing. A new import can recreate an old fallback name unless an explicit rule normalizes it. Do not add provenance fields or fallback-restoration state without a new product decision.

Even new-import-only cleanup must rewrite retained Payees to remove the observed clutter. That changes what a later Unmatch or lifecycle correction reveals. Older intentional Payees cannot be distinguished from abandoned fallbacks without an intent policy. [Explicit Delete](contract/categories-and-payees.md#deleting-a-payee) handles retained references only after owner confirmation.

### App UI consolidation

Shared controls are implemented. Deferred behavior choices include main versus Scheduled amount precision, qualified-category search, bulk Memo Enter behavior, main bulk unload warnings, new-schedule initial focus, arrow-key tabs and Scheduled column filtering/sorting/resizing. Specialized pickers keep their focus models and eligibility. Local danger-button overrides remain separate styling work. None is authorized by consolidation alone.

Each choice is a pending owner decision. The current differences are source traces unless marked.

- Amount precision: the main register abbreviates amounts of at least $1 million to whole dollars; the Scheduled pane keeps cents.
- Qualified-category search: the register picker in [LedgerEditors.tsx](../frontend/src/features/ledger/LedgerEditors.tsx) matches parent and child names separately; other select callers search the displayed qualified label. The shared matcher in [search.ts](../frontend/src/lib/search.ts) does not choose the label.
- Bulk Memo Enter: Enter in the Scheduled bulk toolbar opens its confirmation; the main bulk toolbar keeps the staged draft until Save. Both were checked in a browser.
- Unload warning: the Scheduled pane warns about staged bulk edits on unload; the main bulk flow does not.
- New-schedule focus: the Scheduled pane keeps its own initial field, not the main composer's.
- Tabs: System settings and Payees share `bp-tabs` styling and panel semantics without arrow-key activation.
- Danger styles: the AI Disconnect and Payee-row overrides remain in [blueprint.css](../frontend/src/blueprint.css).

Consolidation acceptance did not exercise bank-connected dialog bodies or an induced provider or unknown-outcome failure; those barriers were inspected in source only.

### Alternative bank-data providers

A second bank-data provider remains an exploration. Verify developer access, ongoing cost, institution coverage and transaction semantics before proposing an integration. No additional provider, paid production access or shared credential service is approved.

### Payee amount-rule refinements

The Inflow/Outflow editor is implemented. Two source-traced refinements remain unapproved: Find searches raw amount-rule data rather than every displayed comparison phrase in [usePayeeManager.ts](../frontend/src/features/payees/usePayeeManager.ts), and directional exactly/at-most/less-than-zero conditions can save but never match under [the strict sign gates](../backend/app/services/payees.py). Decide whether to search displayed wording and reject impossible conditions before implementation. Do not rewrite saved rules automatically.

### Directional transfer memory query

Directional Payee suggestions project the source account's visible history; the partial memory index is not used by that path. Measure before optimizing effective-ownership reads. Reconsider the unused index only with an approved schema change; current-schema admission compares every schema object.

### Canonical fallback Payees in conversion review

An existing canonical fallback Payee can conflict with the retained history Payee and require a choice. An unsaved fallback name has no canonical ID during read-only staging and can remain Ready. History owns the saved Payee by default in both cases. Changing name-only comparison admission requires a separate decision.

### Other conversion overlap proposals

A candidate graph for overlap beyond an exactly returning bank identity remains deferred. Exact-identity reactivation is implemented; it does not expand automatic matching or allow nested accepted pairs.

### Atomic installation-file saves

Authentication, Plaid settings, backup state and OpenAI state use temporary files, fsync, atomic replacement and readback. A shared helper is an optional cleanup only if it preserves each owner's validation, limits and uncertain-outcome policy. No refactor is approved.

### Installable distribution

Public distribution still needs an exact reviewed source snapshot, public support/contribution guidance, artwork/source-mark provenance and installation/recovery acceptance. [Third-party notices](../THIRD_PARTY_NOTICES.md) describes artifact-specific obligations. License adoption, privacy cleanup or this queue does not authorize publication.

[Plaid setup](../README.md#plaid-setup) supports one bring-your-own developer account per installation. Fresh-user signup and bank-link acceptance remains unverified. Managed SaaS needs separate provider, authentication, custody and migration decisions.

A proposed native installer would keep the current stack and package one backend with the built frontend. Choose supported platforms, first-run setup, stable secret/data locations, updates, uninstall and recovery under the [data-protection contract](contract/system.md#data-protection-and-schema-upgrades). Historical-format support is outside scope until separately approved.

Start, Stop and Open controls can launch a same-machine browser. An optional native window must share that service, frontend and saved data. Multiple users, remote browsers and internet exposure need separate decisions. Never distribute a shared provider secret as a packaging shortcut.

Defer path restructuring and new launcher modes until an installer has a concrete need. Generated client types require observed drift to justify tooling. Public-release CI is a separate scope.

### LOC efficiency

Source-traced cleanup leads remain unapproved. Require evidence that consolidation removes coordination rather than hiding it.

- [usePayeeManager](../frontend/src/features/payees/usePayeeManager.ts) and [PayeeManagerDialog](../frontend/src/features/payees/PayeeManagerDialog.tsx) have broad interfaces. Preserve dirty rule drafts, selection, separate Save rule/Apply to history and delayed navigation. Splitting a hook alone does not establish a reduction.
- Matching fact and stale-context token builders in [transaction_matching](../backend/app/services/transaction_matching.py) and [pending_lifecycle](../backend/app/services/pending_lifecycle.py) cover different facts. Preserve coverage and ordering.
- Picker outside-pointer dismissal in [LedgerEditors](../frontend/src/features/ledger/LedgerEditors.tsx) and [TransactionFlagPicker](../frontend/src/features/ledger/TransactionFlagPicker.tsx) also owns different focus/Escape behavior. Extracting dismissal alone can split those lifecycles.
- Smaller unmeasured leads remain in [account dragging](../frontend/src/features/accounts/useSortableAccountRail.ts), [Plaid added/modified loops](../backend/app/services/plaid_sync.py) and [Link request metadata](../backend/app/services/plaid_client.py). Preserve touch cancellation, counters, token modes and error handling.

### Shared UI consistency

The [dialog library](DIALOG_LIBRARY.md#lists-and-comparisons) owns shared comparison source choices and the retained conversion density variant. Specialized picker focus, option eligibility and domain decisions remain separate. `FilterSelect` moves option focus and wraps; register pickers keep search-box focus and do not wrap. Rejected alternatives: a universal dropdown, a shared search-field component, a shared inline-error class, and a generic form, confirmation, retry or popup-lifecycle controller. Repeated markup alone did not establish shared behavior. Child-table changes resize through an observer on a later frame; loading and scheduled-pane transitions measure before paint. This is a source-traced timing limit, not a reproduced visual defect.

### Measured responsiveness

Reads still scan relevant history, and full selection returns every matching parent and token. Allocation filters, running balances and matched-side loading remain proportional costs. A synthetic 100,000-row check observed a 3.25-second full-selection read against a five-second busy timeout; this is not a capacity guarantee. The earlier fixtures and traces are unavailable; build new synthetic probes and a fresh baseline when resuming.

Profile a slow interaction before changing transfer search, rule history, exports, initialization, command admission, bundle splitting or image compression. Preserve freshness, browser Find, keyboard navigation, selection and scrolling.

### Report construction

Account groups and reporting defaults follow the [account contract](contract/accounts.md#account-groups-and-ordering). Report construction is deferred. A Sankey income/saving/spending diagram is a proposal. Distinguish account groups, report scope, financial types and transaction classification. Transfer inclusion remains unresolved.

Pending decisions before a first report:

- Cash-flow meaning: income versus expenses, or cash crossing a selected account boundary. Credit payments, loan payments and investment transfers make these differ.
- Income/expense classification. Categories store no income or expense role, and the seeded Income parent is an editable name. Refunds, loan proceeds, opening balances and adjustments need explicit treatment; an inflow alone is not income.
- Net worth inputs: asset or debt treatment derived from financial type, consistent balance signs, a dated balance source and disclosed history coverage. An uninitialized balance must not count as zero.
- Saved group filters: current string membership or saved account IDs. A group string has no stable identity. A name that no account uses must give an empty scope, never all accounts.

Proposals, not approved scope: start with spending breakdown, spending trends and income versus expenses with account, group and date filters, and add net worth after its balance source is defined. Apply the current group and reporting defaults to all report dates, without effective-dated setting history. Show cash assets and credit debt separately; do not label a total that includes cards as available cash. Exclude transfers between included accounts from activity while keeping their saved categories. Tax reports, investment performance and debt payoff projections stay outside that first scope. Published YNAB, Actual, Monarch and Simplifi documentation, checked 2026-10-29, shares these report families and keeps net-worth inclusion separate from transaction-report inclusion.

Observed-balance trends could use [reported balance observations](contract/account-workflows.md#reported-balance-history). They are sampled bank values, not daily closing balances. Reports and statement-reconciliation checkpoints require separate decisions.

### Account drag visual timing

A source review suggests a possible old-order flash when an accounts refetch is already in flight at drop. This has not been reproduced. Distinguish active-drag cleanup from admission of a new drag; preserve optimistic order, rollback and the delayed-save lock.

## Optional product ideas

### Ledger checkbox filters

Account, Source and Flag checklist reuse, scoped-history option lists and advanced criteria remain deferred. Category, Payee and Status filters with separate Needs review are implemented under the [filter contract](contract/register.md#layout-filters-and-totals). The proposals do not authorize work.

- Account: a searchable checklist in All Accounts and group views, limited to the current scope. It is a read filter, not navigation.
- Source: the current menu mixes visibility scope and source type, and sends source type only with Active. A checklist must split visibility (Active, Excluded, All sources) from source types (Plaid, Manual, Starting balance). Under Excluded only Plaid applies. Source-type filtering under All sources is a new API and product decision.
- Flag: a new filter with labelled swatches and No flag.
- Date and text: an explicit from/to range beside the presets. Memo and Bank description keep text contains; Amount keeps its range.
- Advanced criteria: text operators, wildcards, numeric ranking, a Reviewed status, a transfer-target filter and Scheduled-pane header filters each need a separate decision.
- Option lists: scoped-history option reads, cascading facets and per-value result counts add an API and read cost. A Show selected control and selected-first reordering were rejected because choices must not move while toggled.
- Reuse [LedgerCheckboxFilter.tsx](../frontend/src/features/ledger/LedgerCheckboxFilter.tsx) and [ledgerFilters.ts](../frontend/src/features/ledger/ledgerFilters.ts). Do not turn the assignment `FilterSelect` into a multiselect.
- Acceptance gap: the popup's native mixed-state checkboxes and composition handling were not exercised with a screen reader or a real input method.

### Collapsed Scheduled bar label

The collapsed bar's **Scheduled Transactions: N** label differs from the [pane contract](contract/schedules-loans-and-transfers.md#pane-and-interaction), which specifies **Scheduled · N**. Reconcile it as a separate presentation fix without expanding pane behavior.

### User documentation page

Projected balance help must explain that entered transactions merge with remaining enterable schedules at saved amounts. Explain same-day ordering and that a received bank payment can count beside an unentered schedule until entry/matching resolves it. The [Projected balance contract](contract/schedules-loans-and-transfers.md#projected-balance) owns the rules.

### Variable transfer schedules

Schedule tolerance, including transfer schedules, follows the [current contract](contract/schedules-loans-and-transfers.md#scheduled-transactions). A tolerant transfer match updates a manual partner; bank amounts are never rewritten. When the other account later imports a different bank amount, that import stays unmatched beside the updated manual counterpart.

Pending decision: how two unequal bank sides of one transfer resolve without rewriting either bank amount or relaxing reciprocal transfer equality. One-to-many payroll merging or adding a lifecycle mode is unapproved.

Precedents checked 2026-10-22 cover schedule association only: [Actual schedules](https://actualbudget.org/docs/schedules/) offer Exact, Approximately and Between amounts, and [Simplifi](https://support.simplifi.quicken.com/en/articles/9174873-amount-matching-for-recurring-transactions-in-quicken-simplifi) offers per-series amount modes. Neither shows a merge of unequal entered rows; Actual's two-row merge shortcut [requires equal amounts](https://actualbudget.org/docs/getting-started/tips-tricks/).

### Transfer classification and reporting

Transfer targets, Payees and categories follow the [transfer contract](contract/schedules-loans-and-transfers.md#account-transfers). Reports still need inclusion rules, account/direction scope and handling of misleading net-zero totals. Merchant-wide totals are a separate optional idea.

A feed with balance updates but no corresponding transaction history may need a clearer unmatched-row explanation. A balance-only account mode remains unapproved. Lead: a linked loan account returned no transaction rows across successful syncs; check the next payment before inferring a feed limit. Preserve cross-account links separately from same-account matches.

### Ledger and management

- Verify Balance-header announcements with assistive technology. The header and its focusable note share an `aria-description` in [LedgerTable.tsx](../frontend/src/features/ledger/LedgerTable.tsx); repetition is source-traced, not reproduced.
- Optionally reveal the preselected Payee when picker Edit opens management. The panel loads, but a late-alphabet list item can remain below view. This is a source-traced suggestion.
- Statement reconciliation could compare the cleared register balance with a supplied statement balance and save a checkpoint. Transaction review remains separate.

### Later platform work

- Forecasting and a temporary what-if simulator, with optional saved scenarios later.
- Loan principal tracking, amortization, variable rates and Payoff Simulator remain deferred. Approved loan behavior is [Resolve difference](contract/schedules-loans-and-transfers.md#resolve-difference); escrow disbursements and an escrow asset balance remain excluded.
- YNAB 4 register import with a preview and atomic commit using staged-review concepts.
- Receipt scanning, email bill extraction, dark mode, mobile layouts, multiple currencies/users, Plaid webhooks and durable off-host backup storage.
