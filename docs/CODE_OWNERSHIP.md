# Code ownership

This map names the owner of each responsibility in the source. Read the entries for the files a task touches before changing them. Update an entry when ownership changes.

## Frontend

- `frontend/src/App.tsx` owns authentication and the runtime/query boundary.
- `frontend/src/api/client.ts` owns ordered page-session writes, tab-local pending request identity and the unknown-outcome send barrier.
- `frontend/src/api/hooks.ts` owns the named ledger recovery read set and its awaited refresh; ordinary query invalidation keeps its separate completion policy.
- `frontend/src/features/accounts/` owns account navigation, mixed group/ungrouped ordering and account-specific settings. `accountBalances.ts` owns the shared read-only Bank difference calculation.
- `frontend/src/lib/accountScope.ts` owns individual, All Accounts and group scope identity, membership and read parameters. Group membership changes read and selection identity without resetting editor or command identity.
- `frontend/src/features/accounts/AccountConversionDialog.tsx` owns the staged manual-to-bank connection review and confirmation UI.
- `frontend/src/features/categories/` owns category and subcategory management.
- `frontend/src/features/payees/` owns the Payees/Rules workbench, global rule drafts and order, search, previews, and selection.
- `frontend/src/features/ledger/payeeCategory.ts` owns autofill eligibility and the active-default/remembered-category choice shared by manual and new schedule editors; each editor owns draft provenance.
- `frontend/src/features/settings/SystemSettingsDialog.tsx` owns the system preference, provider setup, backup/restore and diagnostics download dialog.
- `frontend/src/features/settings/BackupSettings.tsx` owns opt-in recovery-key setup, encrypted backup downloads, keyed restore preview/confirmation and uncertain-restore reload within that shell.
- `frontend/src/features/ledger/` owns register reading, presentation, editing, selection, matching, pending-lifecycle UI, and the browser-local presentation settings (account icons, bank-difference highlights, compact mode, amount layout, running balance, new-entry follow and per-account schedule look ahead), the browser-local review-after-edit preference, and entry guard.
- `frontend/src/features/ledger/useLedgerEditor.ts` owns manual drafts, ordinary/split edit state, review-after-edit intent on saved-row commits, save completion, shared new-entry exit decisions and quick-payee creation/recovery; the table owns DOM focus and gesture continuation.
- `frontend/src/features/ledger/LedgerEditors.tsx` owns shared register pickers, field controls, compact editor actions and the new-entry exit dialog; editor owners supply draft validation, save/discard decisions and focus continuation.
- `frontend/src/features/ledger/ledgerFilters.ts` owns column-filter state, selection intent and read parameters; `LedgerCheckboxFilter.tsx` owns categorical filter drafts and keyboard interaction. The backend projection remains the matching/count policy owner.
- `frontend/src/features/ledger/useLedgerSelection.ts` owns selection membership, anchor, shortcut origin, expansion and reconciliation readiness.
- `frontend/src/features/ledger/ledgerFocus.ts` owns entry-field focus, completed click-away gesture admission, clean-editor dismissal and cell advance after picker selection. Continuation respects later focus moves and opened dialogs; workspace and row owners retain exit decisions.
- `frontend/src/features/ledger/useLedgerScroll.ts` owns bottom and reading-position preservation, composer displacement and register-scoped row navigation; the table owns focus, reveal admission and history paging.
- `frontend/src/features/ledger/useLedgerWorkspace.ts` owns workspace action admission, delayed navigation, cross-workflow guards and the split-leave continuation; editor owners retain their drafts and the table retains focus and local guard production.
- `frontend/src/features/ledger/useLedgerCommands.ts` owns ordinary row reservations, provisional display, reconciliation and the departure-only wait for its completion; `useLedgerHistory.ts` owns Undo/Redo readiness, recorded-outcome inspection, fresh-read recovery and explicit acknowledgment of unknown local saves.
- `frontend/src/features/plaid/` owns connection and sync UI.
- `frontend/src/components/Button.tsx` owns ordinary action-button composition; callers select its size and intent instead of inventing surface-specific button styles.
- `frontend/src/components/DialogHeader.tsx` owns ordinary dialog headings and Close presentation; dialogs retain close guards and the custom account identity header.
- `frontend/src/components/ActionMenu.tsx` owns action-menu placement, focus, dismissal and disabled items; callers own commands, reasons and submenus.
- `frontend/src/components/Switch.tsx` and `HelpTooltip.tsx` own shared native switches and noninteractive help presentation.
- `frontend/src/features/ledger/LedgerBulkControls.tsx` owns the shared bulk shell and Payee/Category/Memo fields; toolbar owners retain staging and command policy.
- `frontend/src/features/ledger/ledgerSelection.ts` owns pure selection and gesture calculations; each register retains admission, anchors and navigation.
- `frontend/src/lib/search.ts` owns trimmed case-insensitive substring matching; callers retain searched labels and option eligibility.
- `frontend/src/components/FilterSelect.tsx` owns shared select composition, searchable active-option highlighting and native option focus.
- `frontend/src/components/pickerPosition.ts` owns shared viewport-aware vertical popup and side-flyout placement.
- `frontend/src/components/DeferredDialog.tsx` owns loading, contained import failure and cancellation for management dialogs and match, pending and transfer review views. Feature dialogs retain drafts and close decisions.
- `frontend/src/lib/keyboard.ts` owns the shared input-method composition predicate and action-menu key navigation.
- `frontend/src/components/Modal.tsx` owns shared dialog focus, return targets across nested or replaced shells, portal mechanics, and presentation of the ledger recovery notice; callers own close and dirty decisions.
- `frontend/src/blueprint.css` owns shared design tokens and the visual contract; [DIALOG_LIBRARY.md](DIALOG_LIBRARY.md) describes shared dialog composition under the product contract.
- `frontend/src/lib/diagnostics.ts` owns bounded browser diagnostics and local report export.
- `frontend/src/components/RuntimeErrorBoundary.tsx` owns render failure containment and browser report recovery.
- `frontend/src/features/accounts/LoanDetailsDialog.tsx` owns the Loan details draft, `frontend/src/features/ledger/ResolveDifferenceDialog.tsx` owns the Resolve difference panel, and `LoanDifferenceButton.tsx` owns the footer warning that opens it. `frontend/src/features/ledger/useLoanDialog.ts` owns their context read and saved-outcome inspection/refresh.
- `frontend/src/features/ledger/ScheduledPane.tsx` owns inline schedule drafts, Scheduled selection, batch command/recovery admission, the Send to account flyout and actions under the shared register guards. `ScheduledBulkToolbar.tsx` presents staged metadata and batch actions.
- `frontend/src/features/ledger/rowPermissions.ts` owns the client interpretation of `LedgerRow` permissions; backend ledger policy remains authoritative.
- `frontend/src/features/settings/OpenAISettings.tsx` owns connection controls, status polling and provider-outcome rereads.

## Backend

- `backend/app/diagnostics.py` owns allowlisted structured server events, local retention, HTTP correlation, blocked-summary suppression and report export. The existing ledger write context stages lifecycle observations and publishes through this sink after outer commit; nested scheduled entry stages none.
- `backend/app/services/ledger_projection.py` is the sole read-only ledger projection and action-policy owner, including source visibility, effective fields, relationships, account/group scope filters, balances and Scheduled balance math, edit tokens and initialization admission. It does not import domain command owners.
- `backend/app/services/ledger.py` owns ordinary ledger commands and existing-transaction assignments.
- `backend/app/services/loans.py` owns Loan details and the Resolve difference command. The created charge is an ordinary transaction.
- `backend/app/services/reported_balances.py` owns immutable reported-current-balance capture and its local receipt/provider clocks for sync and connection. Latest account fields own current balances. Provider observations do not enter page-session Undo.
- `backend/app/services/account_initialization.py` owns starting-balance context, previews, suggestions, confirmation and automatic completion.
- `backend/app/services/scheduled_transactions.py` owns recurrence, live schedule projection, management, and occurrence admission; `ledger_projection.py` owns its balance math; ledger and transfers own entered rows. `jobs.py` owns the due-entry background transaction around per-definition savepoints.
- `backend/app/services/account_logos.py` owns the private imported icon library, bounded image normalization, saved-image validation and unused removal. Account assignment stays in accounts; library commands preserve ledger history and join its ordinary outcome/recovery boundary.
- `backend/app/services/accounts.py` owns account create/edit/reorder/delete policy, group normalization and placement, reporting defaults, serialization, deletion previews and last-mapping Item revocation.
- `backend/app/services/commands.py` owns persistent write admission, transaction completion, replay reconciliation, bounded atomic local-save confirmations and their lookup, and recorded page-session outcomes.
- `backend/app/services/ledger_history.py` owns temporary page-session history capture, dependency checks and atomic replay. Its named write context holds request metadata, reservation, capture, completion and match-expiry state; outermost commit/rollback clears transaction state.
- `backend/app/services/categories.py` owns ordinary category hierarchy, assignment, archive, move, and deletion policy.
- `backend/app/services/transfers.py` owns cross-account pair commands and their validation. `transfer_links.py` owns reciprocal pointer link, unlink and anchor rehoming; projection owns visible rows and permissions.
- `backend/app/services/payee_identity.py` owns read-only Payee kinds, transfer targets, labels and combination facts shared by projection and command owners.
- `backend/app/services/openai_connection.py` owns OpenAI registration, encrypted installation state, refresh, revocation, model discovery and synthetic connection checks; provider writes do not enter ledger history.
- `backend/app/services/plaid_settings.py` owns encrypted installation API credentials, immutable configuration reads, provider identity admission and settings revisions. Settings Save reuses the existing maintenance gate and jobs lock; it does not enter ledger Undo. `frontend/src/features/settings/PlaidSettings.tsx` owns the tab draft and uncertain-outcome reread.
- `backend/app/services/payees.py` owns canonical ordinary and protected system Payee identity, default-category preferences, global rule definitions/order, grammar, duplicate detection, and first-match evaluation; the ledger remains the only existing-transaction assignment owner.
- `backend/app/services/rule_regex.py` owns bounded standard-Python regex execution and its isolated subprocess lifetime; payees owns rule semantics and operation budgets.
- `backend/app/services/transaction_matching.py`, `pending_lifecycle.py`, and `plaid_sync.py` own their named workflows. `bank_continuity.py` owns retained bank identity associations, bounded inference, correction and rejection; projection reads field ownership. `transfers.py` owns incremental automatic linking and guarded classification restoration.
- `backend/app/services/account_conversion.py` owns staged account conversion, preview, commit, abandonment, and bank disconnection.
- `backend/app/auth.py` owns optional installation password storage, current-password checks, revision-bound browser sessions, local request admission and stopped-app password reset. `frontend/src/features/settings/PasswordSettings.tsx` owns its settings draft and uncertain-save reload; password settings never enter financial backups or ledger Undo.
- `backend/app/routers/` translates retained HTTP commands; it does not recreate domain policy.
- `backend/app/schema.sql` defines the current schema for fresh databases and its target revision. Historical schema support is outside scope.
- `backend/app/services/backup_package.py` owns current age packages, bounded encrypted/decrypted data, recovery keys and token rewrapping; `backup_state.py` owns installation-local public-recipient/pause storage and bank-provider admission. `database_backup.py` owns financial snapshot/admission, custody comparison, safety copies and shared UI/CLI promotion. Restore persists the pause before generation rotation and SQLite replacement; only an admitted manual Sync Plaid press releases it.
- `backend/app/db.py` owns startup admission, fresh creation, the installation-local database-generation marker and the shared read-snapshot context. It uses `backend/app/schema_admission.py` for the current schema, saved payee-rule amount directions, integrity and foreign-key checks shared with backup restore. Refusal preserves the database; only the current schema is supported.
- `backend/app/models.py` maps the current schema for runtime use.

## Repository

- `README.md` owns setup, ports and check commands.
- `docs/OPERATIONS.md` owns the runtime model, credential handling, diagnostics, and upgrade/restore operating limits.

## Register read boundaries

Register reads filter transaction facts before projecting returned rows. Shared field ownership and one read-local time keep filters, visibility, balances and permissions consistent. Page and full-selection tokens share provider-payload loading; selection builds tokens with each row and its existing category snapshot. Full selection still returns every match. Balance reads use reduced facts and the same visibility resolver, preserving loaded session attributes without reloading expired ones. Preserve the complete-history inputs for counts and running balances.

The page, selection, account-list, payee-assignment-count, schedule and detailed conversion-review GETs hold a database snapshot until their response dictionaries are complete, then release it. Final sync review counting holds its own read snapshot before the existing sync-state save. These read boundaries do not own command writes.
