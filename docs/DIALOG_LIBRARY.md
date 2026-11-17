# Dialog library

Use the shared dialog components to keep account, category, payee and system workflows consistent. This guide owns composition conventions. The [product contract](PRODUCT_CONTRACT.md) owns approved user behavior, including visual requirements. Source owns exact component APIs and CSS token values. If those owners conflict, flag the specific rule before changing it.

## Owners

| Owner | Responsibility |
| --- | --- |
| [Modal.tsx](../frontend/src/components/Modal.tsx) | Portal, dialog role, Tab cycling, initial/return focus and close requests. |
| [DialogHeader.tsx](../frontend/src/components/DialogHeader.tsx) | Ordinary title, subtitle, header actions and Close composition; callers retain close admission. |
| [ActionMenu.tsx](../frontend/src/components/ActionMenu.tsx) | Compact action-menu placement, item semantics, navigation and dismissal. Feature owners retain commands and submenu state. |
| [TransactionComparison.tsx](../frontend/src/features/ledger/TransactionComparison.tsx) | Shared comparison headings, read-only fields and selectable source rows. |
| [DeferredDialog.tsx](../frontend/src/components/DeferredDialog.tsx) | Management and row-review view loading, contained import failure and cancellation; actual dialogs retain their own drafts and close policy. |
| [Button.tsx](../frontend/src/components/Button.tsx) | Action variants, size classes, disabled state and busy accessibility attributes. |
| [blueprint.css](../frontend/src/blueprint.css) | Shared tokens, shell dimensions, typography, motion and viewport rules. |
| [NewEntryExitDialog in LedgerEditors.tsx](../frontend/src/features/ledger/LedgerEditors.tsx) | Shared transaction/schedule exit presentation; editor owners supply validation and decisions. |
| [AccountLogoPicker.tsx](../frontend/src/features/accounts/AccountLogoPicker.tsx) | Institution search and logo selection above the account draft. |
| [ExportDialog.tsx](../frontend/src/features/ledger/ExportDialog.tsx) | One Export modal, transaction/schedule checkboxes, account selection and one browser download: a CSV for one type or a ZIP for both. |
| [BackupSettings.tsx](../frontend/src/features/settings/BackupSettings.tsx) | Opt-in key setup, encrypted downloads and keyed restore within System settings. The child owns secret drafts and reports busy/uncertain state to the shell. |
| Feature caller | Drafts, pending writes, confirmation, dirty guards and whether a close request is accepted. |

Dialogs use the register's Instrument Sans, compact text, blue accent, hairline rules and tinted bands. Features must compose these owners instead of recreating their mechanics.

## Shell and sizing

Every modal must use `Modal`. Do not create another overlay, portal or dialog role in feature code, or use `window.confirm`. `Modal` adds the `.bp-modal-overlay` marker and renders its portal into `document.body`.

The default size is `md`; the default role is `dialog`. Use `alertdialog` for a confirmation that deletes, discards, replaces, disconnects or removes data. Choose size by content:

| Size | Typical content |
| --- | --- |
| `sm` | Brief confirmation or single-field prompt. |
| `md` | Ordinary form. |
| `lg` | Comparison or export. |
| `xl` | Category management. |
| `workbench` | Account conversion or payee management. |

The `.bp-overlay`, `.bp-dialog` and `.bp-dialog--<size>` rules define the scrim, width, border, corners, shadow and viewport fit. The shell must keep header and footer in place while its body scrolls. A workbench can use `.bp-dialog-body--flush` when its panes own scrolling and insets.

Use the shared animation and reduced-motion rules. Their source selectors include `@keyframes bp-overlay-fade`, `@keyframes bp-dialog-rise` and the related media queries.

A dialog opens once, with its content. Pass `loading` to `Modal` while the content the dialog opens with is still loading. The shell stays invisible and hidden from accessibility tools for up to 300 milliseconds, then shows its loading body. During that wait, Tab keeps focus on the opener and Escape can cancel. A shell that replaces another in the same render inherits that wait. If the replaced shell was visible, the new shell appears in place without replaying the entrance. Later loading inside a visible dialog does not hide it again.

Management dialogs and match, pending and transfer review views are imported when opened through `deferDialog`. Their workflow hooks and command guards remain eager. The automatic payee-default prompt stays eager because it can appear after an ordinary save. The `deferDialog` loading surface uses the same shell and yields to the actual dialog when ready. Closing suppresses late reopening. A failed module load offers Close and explains how to preserve unsaved work before manually reloading or reopening in a new tab; it must not reload the page or retry a saved command.

## Header

Use `DialogHeader` for ordinary headers. It renders one `.bp-dialog-header` with a `.bp-dialog-heading`, an `h2.bp-dialog-title` and a `p.bp-dialog-subtitle`. Supply a subject or consequence subtitle for confirmations. Loading shells and tabbed System settings can use a title-only header. Account settings retains its approved logo/name/rename header; its confirmations use the ordinary header.

The title states the task. The subtitle identifies its subject or consequence in one line. Use sentence case. Confirmation titles end with a question mark; other titles have no final punctuation. Do not add an eyebrow or uppercase micro-label. Loading and errors belong in the body.

Every dialog must expose a visible close button. `DialogHeader` supplies the shared large quiet Close button and accepts the caller's pending guard. The custom account header uses the same Button composition. Use the shared typography steps instead of adding intermediate font sizes.

## Body and fields

Use `.bp-dialog-body` for normal scrolling and spacing. Use `.bp-dialog-body--flush` only when the panes provide those functions. Group related content in `.bp-dialog-section` with `.bp-dialog-section-heading`. Do not add child margins to imitate the body's spacing.

| Selector | Use |
| --- | --- |
| `.bp-dialog-copy` | Main explanatory text. |
| `.bp-dialog-list` | A list of fields, items or affected records in dialog copy. Combine it with `.bp-dialog-copy`. |
| `.bp-note` | Muted supporting text or table explanation. |
| `.bp-label` | Section, rail, pane, column or table heading. |
| `.bp-field` | A labeled control group. |
| `.bp-field-hint` | Supporting text for a field. |
| `.bp-field-grid`, `.bp-field-grid--even` | Related fields in columns. |
| `.bp-control` | Ordinary text, date or select control. |
| `.bp-field--dense`, `.bp-control--sm` | Compact workbench fields. |
| `.bp-check` | Inline checkbox labels. |
| `.bp-search` | Search controls. |

Account forms keep group names and reporting choices in the same draft as name, type and logo. Group selection uses `FilterSelect` with typed creation enabled: Enter chooses an existing name or Use “typed name”; No group clears the draft. Save persists the draft atomically, and Cancel discards it. There is no separate group-management dialog.

`Switch` supplies a named native checkbox with switch semantics. Disabled switches retain their checked state, dim the track and use a neutral cursor. Use `HelpTooltip` for the shared hover/focus explanation while preserving the caller’s span or button trigger.

Native `select` and `FilterSelect` are both permitted. Prefer `FilterSelect` for long or searchable lists. Search highlights the enabled result Enter will choose; arrows move native focus and the highlight, and the saved selection stays distinct. A filter trigger in a field must use the shared control composition. Use the existing focus, disabled and checkbox rules; do not add dialog-specific copies.

## Footer and buttons

Use `.bp-dialog-footer`. When a destructive secondary action or status belongs at the start, use `.bp-dialog-footer-start`. Put dismiss, secondary and primary actions after it. Keep at most one primary or danger action in the right-hand group.

Use `.bp-pane-footer` for workbench pane actions. Pane headings use `.bp-pane-head` with `.bp-label` or `.bp-pane-title`.

Payee management opens in Payees. Its list footer owns New payee; the selected-payee header owns the ordinary Payee's Rename, Replace and danger Delete actions; the payee column owns the default category, the payee's rules and the rule editor, with Cancel/Save rule in its footer while a rule is open. The right pane orders Payee transactions, All transactions, conditional Schedules and the temporary Matches rule tab. The transaction tabs retain assignment, filters and paging. Schedules shows every saved definition for the selected Payee as compact history-style rows with its own selection, a destination picker and Assign selected. It appears only for a positive saved schedule count, and returns to the remembered transaction tab when emptied. All Rules uses the global ordered list with Edit and move controls, and the transaction check on the right. Save rule and Apply to history remain separate actions. Move controls are unavailable while filters are active. See the [Payees contract](contract/categories-and-payees.md#payees) for guards and selection behavior.

`PayeeReferencesDialog` uses one medium shared shell for deletion and explicit replacement. It leads with a plain consequence summary, then a collapsed **Affected items** disclosure of compact history-style rows (description, plain reason, account, the Payee each record takes, amount and date) that shares numeric pagination with Schedules and stays open across pages. A blocked Delete uses a warning callout naming the transactions and schedules to reassign. Saved originals stay together under their current transaction without transaction selection. Full confirmation previews retain every reference and owned rule, regardless of the selected tab or filters. Delete discloses displayed-transaction and saved-schedule blockers, retained-record destinations and rule removal. Affected-record details start collapsed. Replacement uses the shared searchable select and a danger confirmation; Cancel receives initial focus and focus returns to the opener. The manager hook owns preview identity, writes and recovery. See [reference inspection and replacement](contract/categories-and-payees.md#reference-inspection-and-replacement) for scope and persistence rules.

During register session recovery, `Modal` shows the ledger's recovery notice and Retry refresh control inside the dialog. This keeps recovery accessible without closing the dialog or discarding staged choices. The ledger history hook owns recovery; the modal only presents its notice.

Feature callers must use `Button` and select its size and intent. They must not restyle `.bp-button`.

| Size | Placement |
| --- | --- |
| `lg` | Header close, dialog/pane footer and primary history action. |
| `md` | Callout action, pagination or preview trigger. |
| `sm` | Row action or inline recovery. |

A row-level destructive action uses `variant="danger"`. Destructive confirmations use a danger confirming action. The contract's [shared action controls](contract/register.md#shared-action-controls) retain their approved dimensions and placement requirements; do not infer permission to change them from this guide.

For actions that remove or replace saved data, explain the affected records and recovery limits before confirmation. A destructive schema reset also requires the explicit approval defined by [data protection](contract/system.md#data-protection-and-schema-upgrades); an error dialog or schema mismatch does not supply that approval.

Use labels that explain the consequence:

- **Cancel** abandons staged work.
- **Close** dismisses read-only, completed or informational content.
- **Keep editing** and **Discard changes** resolve a dirty guard.
- **Continue editing** and **Discard transaction** or **Discard schedule** resolve a new-entry exit decision.
- **Finish later** is appropriate when staged work is retained.

Labels use sentence case and “and” rather than “&”. An ellipsis indicates pending work or an action that opens another step.

During a saved command, the acting button must use `busy={pending}` and a present-participle label with an ellipsis. `Button` disables itself and supplies busy accessibility attributes. The caller must disable conflicting controls and header close, and reject dismissal during the write. Dirty-state and close decisions remain with the caller.

## Callouts and workspace notices

Use `.bp-callout` with the modifier for its purpose: `--info`, `--warning`, `--error` or `--danger`. Errors use `role="alert"` and appear last in the body. An inline destructive confirmation uses a danger callout, a strong title, consequence text and `.bp-callout-actions` with Cancel followed by the danger action.

Floating workspace notices use the base `.bp-notice` for neutral styling and `.bp-notice--warning` or `.bp-notice--error` for the other severities. `.bp-notice--neutral` is a markup marker, not a separate CSS rule. Their frame provides a title, wrapped body and an action area that does not shrink. Persistent recovery notices use `role="alert"`. Neutral arrivals use the toast-specific polite announcer. Timing, dismissal and captured-sync behavior belong to the [contract's notice rules](contract/register.md#register) and [sync status](contract/account-workflows.md#sync-status-and-workspace-notices).

## Lists and comparisons

Use `.bp-list`, optionally `.bp-list--scroll`, with `.bp-list-row`. `.is-selected` means saved selection and must remain distinct from keyboard focus or the active option. Use `.bp-rail`, `.bp-rail-list` and `.bp-rail-row` for navigation rails. Tags and status marks can use uppercase; dialog tabs use `.bp-tabs` and `.is-active`.

Use the existing `.bp-empty` rules for empty content. Reuse the shared heading selectors and tokens.

`TransactionComparison` places the lock icon in the left selector cell and labels the amount row **Amount**. It shows an em dash for an empty value, a swatch with each flag, and `LedgerSourceIcon` plus a strong source label. Preserve this alignment when a workflow reuses the comparison. Match, pending resolution and connection review use `ComparisonChoiceRow` for selectable fields. The value labels select their source; each row has its own native radio group. Callers retain field eligibility and disable choices during a pending write. Returning bank identities and fixed fields remain read-only. Connection review retains its compact spacing and difference edge.

Connection inspection shares the frozen-field `SourceGrid` and inline `RelationshipControls` in [BankContinuityDialog.tsx](../frontend/src/features/ledger/BankContinuityDialog.tsx). Its title is **Transaction connections**. Accepted matches keep their source comparison; bank-only and transfer-only rows reuse the inspector. Retained local sources precede one read-only **Transfer · account name** counterpart. A transfer-only view shows its two columns immediately; layered comparisons open at the current bank/manual pair with the counterpart to the right. Label a manual local source Manual and identify its account. Preserve independent collapse and aligned rows. Separate read admission from correction permissions, and inspection intent from pending resolution. Correction confirmations use server evidence, consequences, current tokens, one confirmation at a time, Cancel focus and busy guards. The footer contains only Close. Suggested retains its rationale and Match workflow without destructive controls. The transfer finder handles finding and creation, with no linked correction branch. Follow the [matching contract](contract/account-workflows.md#review-and-matching).

## Focus and close requests

`Modal` handles each forward or reverse Tab step across its visible, enabled controls and any caller-supplied `extraFocusSelector` controls. It excludes negative-tabindex controls and uses the checked radio, or the first radio when none is checked, as one Tab stop per group. Radio arrows keep their native behavior. Native date inputs retain Tab between their date segments; a deferred boundary check contains a departure and yields to a later key or pointer action. Other dialog controls remain reachable even when WebKit’s platform setting skips buttons outside dialogs. A child handler that prevents the key event retains control. It initially focuses `initialFocusRef`, the first eligible control, or the dialog itself. A replaced loading or review shell retains the original return target. On close, Modal restores that target after the current render commit, without scrolling, if it remains visible, enabled and outside inert content. A later deliberate focus move takes precedence. Changes to `initialFocusRef` do not recapture the opener. Each transfer-queue item mounts a new Modal shell, which receives initial focus and inherits the original return target. Existing feature-specific focus continuations retain their ownership.

A modal covered by a child passes `inactive`. Its section becomes inert and hidden from accessibility in the same render; it stops handling Tab, Escape and backdrop dismissal. Its overlay becomes transparent so the child supplies the single scrim. Payee confirmations use this pattern and focus Cancel first. Modal remembers the parent’s last focused control when applying inert has already moved browser focus to the body. Closing both layers retains the outer opener; closing only the child returns to the parent control. Account settings uses this while its logo picker is open. The picker supplies the Choose logo button as `returnFocusRef`; closing the child restores focus after the parent becomes active, without discarding the account draft.

Initialization supplies `returnFocusRef` because its ledger-picker phase temporarily removes the setup dialog and its outside button. The current ref takes precedence over the captured opener. The initialization card owns return to Edit account when completion removes the card. The register owns fallback and its Tab entry point when a refreshed result removes the focused row; it yields to active editors, writes, dialogs and later focus moves.

Transaction-menu commands focus their row before opening another surface. Escape also returns to the row; outside-pointer dismissal does not move focus or scroll. System settings and row review actions focus their trigger when activated, then use the shared return behavior.

Escape and overlay mouse-down request closure through `onRequestClose`. Overlay mouse-down suppresses the browser's default focus change so it cannot undo return focus. They do not decide whether drafts can be discarded. The caller must apply its pending and dirty guards to the request. Choose initial focus explicitly when the task needs a particular first action, such as Cancel in a destructive confirmation. Cancelling the inline pending-disappearance confirmation returns focus to Charge disappeared, unless the user has already moved focus elsewhere.

New transaction and schedule entries reuse `NewEntryExitDialog`. Continue editing receives initial focus. Its Close button, Escape and overlay return to editing; only the danger action discards. The editor restores the first blocking field for an incomplete entry or the prior field for a discard question. See [new-entry exit behavior](contract/account-workflows.md#new-entry-exit-behavior) for admission and recovery rules.

The shared modal recovery notice also exposes uncertain local-save inspection, explicit acknowledgment after fresh reads, and database-replacement reload. The history hook owns the barrier; dialogs keep their draft and domain-specific recovery decisions.

Loan details and Resolve difference use the shared Modal, DialogHeader, fields and action buttons. Resolve difference uses the Modal's corner placement: `ModalCornerProvider` supplies the area, the ledger screen supplies the register above its footer, and the window is the fallback. See the [loan contract](contract/schedules-loans-and-transfers.md#loan-accounts).
