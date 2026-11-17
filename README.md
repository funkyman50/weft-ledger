# Weft Ledger

Weft is a self-hosted, single-user account register for local and Plaid-backed history. It supports transaction review, matching, pending resolution, editing, filtering, sorting, categories, payees, scheduled transactions, whole-transaction account transfers and loan bank-difference resolution. Forecasting and loan planning are outside the approved product.

This pre-alpha is for a browser on the same computer as the service. Only the current database format is supported; there is no automatic schema-upgrade path. Keep a verified encrypted backup and its recovery key separately before updating. This project makes no v1.0 stability or public-internet deployment promise.

Existing bank refreshes retain small [reported balance observations](docs/contract/account-workflows.md#reported-balance-history). History does not automatically change transactions.

## License

Original Weft code and the project artwork listed below are licensed under [PolyForm Noncommercial 1.0.0](LICENSE), to the extent rights are held, with [the required copyright notice](NOTICE) for Daniel Piechowski. This is a source-available project. The license permits personal and other noncommercial use, modification and sharing; commercial use needs separate permission unless the license expressly permits it, including its listed organization exceptions.

Third-party software, fonts and artwork retain their own terms. [Third-party notices](THIRD_PARTY_NOTICES.md) maps the notices generated with each frontend build and retained in source installations. The notice guide describes additional checks before distributing prebuilt binaries. The project license grants no trademark rights. No additional internal-business license or custom exception is included.

### Project artwork

The [W wallet mark](frontend/artwork/wallet-mark.svg) was drawn as a vector from a concept supplied by Daniel Piechowski. It uses app blue `#245edb`. The app uses square PNG exports at [512 px](frontend/public/icon.png), [32 px](frontend/public/favicon.png) and [180 px](frontend/public/apple-touch-icon.png).

These images were created for the project with OpenAI image tools under Daniel Piechowski's direction:

- All Accounts icon: [all-accounts-piggy.png](frontend/public/all-accounts-piggy.png).
- Setup illustrations: [Starting Balance](frontend/src/features/accounts/assets/initialization/v2-01-starting-balance.png), [Already included](frontend/src/features/accounts/assets/initialization/v2-02-already-included.png), [Suggested selections](frontend/src/features/accounts/assets/initialization/v2-03-suggested-selections.png) and [Manually cleared](frontend/src/features/accounts/assets/initialization/v2-04-manually-cleared.png).

The published files omit embedded generation metadata; this list records their origin. AI generation does not establish exclusive copyright. User-imported account images retain their owners' rights and are outside this project-artwork list.

## Documentation

| Document | Read it for |
| --- | --- |
| [Product contract](docs/PRODUCT_CONTRACT.md) | Approved behavior, conditions and exclusions. Use its section index for the affected workflows. |
| [Operations](docs/OPERATIONS.md) | Running one installation: the runtime model, credentials, diagnostics, backup and restore, and schema revisions. |
| [Code ownership](docs/CODE_OWNERSHIP.md) | The source owner of each responsibility and the register read boundaries. |
| [Dialog library](docs/DIALOG_LIBRARY.md) | Shared dialog and action composition. |
| [Future features and concepts](docs/FUTURE_FEATURES_AND_CONCEPTS.md) | Known defects, unverified leads, acceptance gaps, pending decisions and optional ideas. |
| [Reports and feedback](CONTRIBUTING.md) | Bug reports, ideas, documentation feedback, privacy and support expectations. Pull requests are not accepted yet. |
| [Security policy](SECURITY.md) | Supported versions and private vulnerability reporting. |

The contract states intended behavior. Source files define the implementation. If they disagree, record the mismatch; a proposal does not change either one. Saved data is protected, including development data. Historical formats are outside scope; updates must protect saved data, and destructive resets require explicit approval. See [data protection](docs/contract/system.md#data-protection-and-schema-upgrades).

## Register entry

New Transaction focuses Date and skips the transfer picker during ordinary keyboard entry. Fresh New Transfer assumes today and opens the transfer target picker; Tab or Enter after target selection moves to Payee. Alt+T opens the transfer picker from an editor. Tab or Enter accepts the highlighted date, Payee or Category and advances to the next cell. Schedule pickers use the same continuation. See [keyboard entry](docs/contract/register.md#keyboard-entry) for popup commands and reverse navigation.

In either ledger, the first plain click selects a row. Clicking the selected row again enters editing. Enter opens the focused row directly; the main register also supports F2. Row action buttons retain their direct actions.

Transactions and schedules save through Enter in a text/amount field or Save. A completed click-away can save a changed ordinary existing row; focus departure alone retains the draft. New drafts do not autosave: clean drafts can close on click-away, while dirty drafts stay open and guarded departure asks before discarding work. Both ledgers show ✓ Save and ✕ Cancel in an ordinary editor’s Actions cell. Split editors retain explicit completion. See [existing-row editing](docs/contract/account-workflows.md#existing-row-departure) and [new-entry exit behavior](docs/contract/account-workflows.md#new-entry-exit-behavior).

The register preserves bottom or reading position through ordinary refreshes. With Show new transaction after saving enabled, a confirmed save reveals its row with a brief fading blue wash; reduced motion uses a static edge. See [scroll behavior](docs/contract/register.md#scroll-behavior) and [saved-row feedback](docs/contract/account-workflows.md#manual-account-workflow).

## CSV exports

**Export** sits beside Sync Plaid. Its modal offers **Transaction History** and **Scheduled Transactions** independently. Select accounts and either type to download a CSV, or both types to download one ZIP containing the two CSVs. The browser controls the save location and any filename dialog through its ordinary download settings, including saving to Downloads.

Transaction export includes the ledger's data columns, including Bank description, Outflow, Inflow and Balance. Balances follow full account history even when export dates or pending transactions are filtered. Split category rows repeat the balance after the whole transaction.

Scheduled export contains one row per saved schedule, including paused schedules. Select the owning account to include a transfer schedule; its destination appears in the same row. Look ahead occurrences and Projected balances are excluded. Exports do not change saved data. See [CSV export](docs/contract/register.md#csv-export) for fields and options.

## Payees and rules

The Payees window manages payee names, default categories, explicit assignment and rules, which are created and edited beside the transaction list. A rule's conditions cover account, description, merchant and amount; all must match. The first matching rule in the global order assigns a Payee and an optional Category on first bank import. Its All Rules tab shows that order, reorders rules, and checks which rule would decide a given transaction. Saving a rule can also apply it to the matching transactions it would change; Matches rule and Apply handle selected history explicitly.

Manual entry uses the payee's default category, then its remembered category. Individual transaction category choices teach that memory; new schedules consume it without teaching it. Three distinct consecutive uses of one category offer to make it the payee default. See [Payees](docs/contract/categories-and-payees.md#payees) for admission, protected choices and history behavior.

## Account icons

Accounts use a stable initial and color from their connected institution or account name. Choose logo in account settings opens the shared icon library. Select any number of PNG, JPEG or WebP files. Import processes one image at a time and shows progress. Stop import finishes the current image and keeps earlier imports. Invalid images are reported individually; other save/connection errors stop the selection for inspection. Recovery never resumes the import automatically. Import filenames supply initial library labels. Each tile has a pencil (Rename) and a red trash can (Remove). Rename turns the label into a text field; leaving the field or pressing Enter saves the shared searchable label, and Escape cancels. The label also changes for icons used by accounts; it leaves the image and account names/selections unchanged. A failed rename keeps the field open for correction; Escape cancels it. Imports and saved label changes stay in the library even if you cancel the account form; Save changes applies the selected icon to that account. Use default restores the automatic initial. The trash can appears on unused images only.

The database holds image bytes and selections, including unassigned imports. Encrypted financial backups include the whole library. User images do not enter application source or static builds. Weft ships no institution artwork; importing an image does not grant redistribution rights. The library accepts still images of at most 4 million pixels and normalizes them to 128px PNGs. There is no library count or size ceiling. Individual images retain processing-memory and resolution checks. A sufficiently large database can exceed the existing 256 MB backup-package limit and prevent backup creation; imports and ordinary use remain available.

## OpenAI connection

System settings → AI offers Continue with ChatGPT, saved registrations, a model selector and Check connection. Disable all AI starts enabled. Connecting does not enable AI or share ledger data. Check connection uses a fixed synthetic example and consumes the selected ChatGPT plan's usage; enable AI and acknowledge plan usage before starting it. No feature currently sends ledger data to OpenAI.

The connection uses locally hosted Sign in with ChatGPT. The user completes authorization in their browser. Identity sign-in, granted plan-use permission and successful model access are separate states. Unsupported access never falls back to an API key or another model. Manage usage opens ChatGPT settings.

Encrypted installation state lives beside the configured database as `<database-stem>.openai.enc`. It includes registration identity, renewable credentials, AI enablement and the selected model. It uses the installation's `WEFT_SECRET`, owner-only file permissions and atomic replacement. Database backup/restore does not include or replace it. Keep the original secret; do not copy the connection state to another host or commit it.

OAuth returns to `http://127.0.0.1:<port>/auth/callback` on the existing backend. The launcher supplies the backend port in both modes. Custom launches must set `WEFT_OPENAI_CALLBACK_PORT` to the backend port reachable by the local browser. A remote browser cannot deliver this loopback callback. The result page directs the user back to Weft; settings then reads connection status.

Disconnect clears local tokens and retains registration identity for reconnect. If remote revocation could not be confirmed, settings directs the user to disconnect the app's registration in ChatGPT. An uncertain settings/connection response triggers a status read before another dependent action. Provider errors do not log out the Weft session.

## Plaid setup

Every installation uses its own Plaid developer account. Open **System settings → Plaid** and follow the Dashboard link. Create or sign into your developer account, obtain access to Transactions and the banks you need, then copy its Client ID and environment-specific Secret. Save settings, then use **Check credentials**. This check creates no bank connection and proves credential acceptance only. Account creation and account settings retain their separate bank sign-in and repair flows.

New installations use **Real banks (Production)**. Eligible new US/Canada developers can apply for [Plaid Trial](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan). Free Weft does not guarantee Trial eligibility, bank access or free Plaid service. Trial allows ten total connection creations; deleting a connection does not replenish this allowance. One connection can supply several accounts. Reuse or repair an existing login before creating another; an unsuccessful new connection can still use a slot after token exchange. Complete any app-profile or institution-access steps requested in the Dashboard. Weft currently selects US banks and USD accounts.

**Advanced → Environment** offers Sandbox for a separate test installation. Existing bank custody locks the account identity and environment, including staged and cleanup records. Same-account Secret replacement stays available. To switch to another Plaid account, explicitly disconnect feeds and resolve staged or unused custody first; history remains. After restoring into different settings, enter the original connection owner's credentials. Saving them does not release the restore pause; press **Sync Plaid** when ready.

Plaid API credentials live beside the database in `<database filename>.plaid.enc`, encrypted with the installation's `WEFT_SECRET`, with owner-only permissions and atomic replacement. The profile also retains a stable Plaid Link user ID that does not depend on the encryption key. A new installation creates its own ID. API credentials are excluded from financial backups; each bank connection's non-secret provider ownership is included. Preserve the installation secret and credential file. Offline financial recovery needs neither Plaid credentials nor this file. An uncertain Save requires a settings refresh before another dependent operation. Save waits for admitted work and provider jobs, changes no financial rows and starts no sync.

The runtime does not read `PLAID_CLIENT_ID`, `PLAID_SECRET` or `PLAID_ENV`. Use the saved profile in System settings for setup and credential changes. Local ordinary-browser use remains the supported scope; this feature adds no public-internet deployment guarantee.

## Install and run

Weft runs natively on macOS and Linux as one local backend process that serves the app and its API. Windows is not supported yet. Install these first:

- macOS: Python 3, `uv`, Node.js 22 or later and npm, for example with Homebrew.
- Linux: Python 3, `uv`, Node.js 22 or later, npm and `lsof`, and a systemd user session (a normal desktop or console login).

The launcher runs on the system Python 3. The backend needs Python 3.12 or later, which `uv` downloads when the system lacks it.

From a checkout, install the interface dependencies once, then open the menu:

```bash
(cd frontend && npm ci)
./weft
```

Choose **Start**, then **Open browser**. Start installs the Python packages, builds the interface and starts Weft at [localhost:9099](http://localhost:9099). Run `npm ci` again after updating the checkout. Each action is also available directly:

```bash
./weft start
./weft open
./weft status
./weft logs
./weft restart
./weft stop
```

Weft runs as a per-user background service: `launchd` on macOS, a transient `systemd --user` unit on Linux. Closing the menu or terminal leaves it running; use Stop to end it. It does not start at login. On macOS it ends at logout or shutdown; on Linux it ends when the user's systemd manager stops, normally after the last session ends, or later when lingering is enabled. Over SSH without a user manager, Start explains the requirement instead of starting. To use another port, set `PORT` when starting, for example `PORT=9100 ./weft start`. Restart keeps the running port.

Weft keeps its data in a per-user folder outside the checkout:

| System | Data folder |
| --- | --- |
| macOS | `~/Library/Application Support/Weft` |
| Linux | `$XDG_DATA_HOME/weft`, normally `~/.local/share/weft` |

The folder holds the database `weft.db`, its installation key `installation.key`, credential and password files, diagnostics and launcher logs. The first Start of a new installation creates the key and asks you to back it up. Keep that backup private and separate from financial backups: the key decrypts saved bank and AI connections, and Weft cannot recover it. If the database exists without its key, Start refuses and changes nothing. See [local security and credentials](docs/OPERATIONS.md#local-security-and-credentials).

Only one Weft backend can use a database at a time; a second one refuses to start. Occupied ports block Start; the launcher never stops another program's process. Logs shows the last 100 lines of launcher output, and each Start keeps one previous log.

## Development

`./weft dev` controls the hot-reload development servers with the same actions, for example `./weft dev start`. They bind to `127.0.0.1`: the Vite frontend on `PORT` (default `9199`) and the backend on `WEFT_BACKEND_PORT` (default `8000`), so development and the installed runtime on `9099` can run side by side. Choose other ports with, for example, `PORT=9100 WEFT_BACKEND_PORT=8001 ./weft dev start`.

Development data is stored in `data/dev.db` in the checkout and is protected saved data. If `.env` does not exist, copy `.env.example` to it and set `WEFT_DEV_SECRET` there (on Linux the launcher does not pass a shell-exported value to the service) following [local security and credentials](docs/OPERATIONS.md#local-security-and-credentials). Preserve an existing key when it holds encrypted connections. The development launcher supplies `WEFT_SECRET` and `WEFT_DB_PATH` from these development values. Restart keeps the running ports and rereads `.env`; Stop and Start apply new environment overrides. Launcher state and output live in `data/launcher/`.

An occupied port or an unmanaged development backend in this checkout blocks Start. Use the same `./weft dev` controls from every terminal; do not launch `scripts/dev-local.sh` directly alongside them. Launch behavior is defined in [weft](weft), [dev-local.sh](scripts/dev-local.sh) and [run-local.sh](scripts/run-local.sh).

For bank connections, use **System settings → Plaid**; `PLAID_*` environment variables are not read. The development servers are read-only toward Plaid, so a development copy can share an installed runtime's bank connections without changing them. They sync only when you press **Sync Plaid** (never on the six-hour schedule) and read accounts; starting a new bank sign-in, repairing a sign-in and removing a connection at Plaid are refused. Local changes that need no Plaid change still work: mapping an account to an existing connection, and disconnecting one account while another account keeps that connection. An eligible account's settings in the installed runtime can repair an existing Item; that repair affects the accounts sharing the Item. See [bank mapping and repair](docs/contract/accounts.md#mapping-and-repairing-bank-connections) for its admission rules.

## Verification

From the repository root, run the applicable source checks:

```bash
(cd backend && uv run python -m compileall -q app)
(cd frontend && npm run lint)
(cd frontend && npm run build)
```

The regression tests for category names, reconciliation, Plaid connection and sync, and OpenAI connection checks use disposable databases. Run them when relevant to the change:

```bash
(cd backend && uv run python -m unittest discover -s tests -p 'test_transaction_reconciliation.py')
(cd backend && uv run python -m unittest discover -s tests -p 'test_category_names.py')
(cd backend && uv run python -m unittest discover -s tests -p 'test_plaid_sync.py')
(cd backend && uv run python -m unittest discover -s tests -p 'test_openai_connection_check.py')
```

Start and open the app with `./weft dev` and inspect the affected user flow deliberately. New automated tests require a reproduced defect and a durable observable boundary. Documentation-only changes require fact, link, anchor and whitespace checks.
