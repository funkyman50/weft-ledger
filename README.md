# Weft Ledger

Weft is a self-hosted, single-user account register for local and Plaid-backed history. It supports transaction review, matching, pending resolution, editing, filtering, sorting, categories, payees, scheduled transactions, whole-transaction account transfers and loan bank-difference resolution. Forecasting and loan planning are outside the approved product.

This pre-alpha is for a browser on the same computer as the service. Only the current database format is supported; there is no automatic schema-upgrade path. Keep a verified encrypted backup and its recovery key separately before updating. This project makes no v1.0 stability or public-internet deployment promise.

Existing bank refreshes retain small [reported balance observations](docs/contract/account-workflows.md#reported-balance-history). History does not automatically change transactions.

## License

Original Weft code and the project artwork listed below are licensed under [PolyForm Noncommercial 1.0.0](LICENSE), to the extent rights are held, with [the required copyright notice](NOTICE) for Daniel Piechowski. This is a source-available project. The license permits personal and other noncommercial use, modification and sharing; commercial use needs separate permission unless the license expressly permits it, including its listed organization exceptions.

Third-party software, fonts and artwork retain their own terms. [Third-party notices](THIRD_PARTY_NOTICES.md) maps the notices generated with each frontend build and retained in source installations and locally built containers. The notice guide describes additional checks before distributing prebuilt images. The project license grants no trademark rights. No additional internal-business license or custom exception is included.

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

OAuth returns to `http://127.0.0.1:<port>/auth/callback` on the existing backend. The local launcher supplies its backend port; Compose supplies its published host port `9099`. Custom runtimes must set `WEFT_OPENAI_CALLBACK_PORT` to the port reachable by the local browser. A remote browser or unexposed container port cannot deliver this loopback callback. The result page directs the user back to Weft; settings then reads connection status.

Disconnect clears local tokens and retains registration identity for reconnect. If remote revocation could not be confirmed, settings directs the user to disconnect the app's registration in ChatGPT. An uncertain settings/connection response triggers a status read before another dependent action. Provider errors do not log out the Weft session.

## Plaid setup

Every installation uses its own Plaid developer account. Open **System settings → Plaid** and follow the Dashboard link. Create or sign into your developer account, obtain access to Transactions and the banks you need, then copy its Client ID and environment-specific Secret. Save settings, then use **Check credentials**. This check creates no bank connection and proves credential acceptance only. Account creation and account settings retain their separate bank sign-in and repair flows.

New installations use **Real banks (Production)**. Eligible new US/Canada developers can apply for [Plaid Trial](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan). Free Weft does not guarantee Trial eligibility, bank access or free Plaid service. Trial allows ten total connection creations; deleting a connection does not replenish this allowance. One connection can supply several accounts. Reuse or repair an existing login before creating another; an unsuccessful new connection can still use a slot after token exchange. Complete any app-profile or institution-access steps requested in the Dashboard. Weft currently selects US banks and USD accounts.

**Advanced → Environment** offers Sandbox for a separate test installation. Existing bank custody locks the account identity and environment, including staged and cleanup records. Same-account Secret replacement stays available. To switch to another Plaid account, explicitly disconnect feeds and resolve staged or unused custody first; history remains. After restoring into different settings, enter the original connection owner's credentials. Saving them does not release the restore pause; press **Sync Plaid** when ready.

Plaid API credentials live beside the database in `<database filename>.plaid.enc`, encrypted with the installation's `WEFT_SECRET`, with owner-only permissions and atomic replacement. The profile also retains a stable Plaid Link user ID that does not depend on the encryption key. A new installation creates its own ID. API credentials are excluded from financial backups; each bank connection's non-secret provider ownership is included. Preserve the installation secret and credential file. Offline financial recovery needs neither Plaid credentials nor this file. An uncertain Save requires a settings refresh before another dependent operation. Save waits for admitted work and provider jobs, changes no financial rows and starts no sync.

The runtime does not read `PLAID_CLIENT_ID`, `PLAID_SECRET` or `PLAID_ENV`. Use the saved profile in System settings for setup and credential changes. Local ordinary-browser use remains the supported scope; this feature adds no public-internet deployment guarantee.

## Local development

On macOS, install Python 3, `uv`, Node.js and npm. The backend uses Python 3.12 or later through `uv`. Install frontend dependencies from the checkout:

```bash
(cd frontend && npm ci)
```

From the repository root, open the development menu:

```bash
./weft
```

Choose **Start**, then **Open browser** to open Weft in Google Chrome. The menu also offers Stop, Restart, Status and Logs. Both servers bind to `127.0.0.1` and retain hot reload. Exit menu or closing the terminal leaves them running under macOS `launchd`; use Stop to end them. The service does not start automatically at login and ends at logout or shutdown.

Each action is also available directly:

```bash
./weft start
./weft open
./weft status
./weft logs
./weft restart
./weft stop
```

Start waits for both servers to respond. Repeated Start reuses the managed instance. Defaults are frontend `9099` and backend `8000`. Occupied ports and an existing unmanaged backend in this checkout block Start; the launcher never kills their processes or silently starts another backend on fallback ports. If an older terminal launch is running, stop it in that terminal before using this menu. To choose other ports explicitly, set `PORT` and `WEFT_BACKEND_PORT` when starting:

```bash
PORT=9100 WEFT_BACKEND_PORT=8001 ./weft start
```

Restart retains the running service's ports and launcher environment while rereading `.env`. Stop and Start apply new environment overrides. A startup failure leaves its attempt available for Logs, Stop or Restart. Logs shows the last 100 output lines. Private launcher state and combined server output live in `data/launcher/`; each new start retains one previous log. The active output log has no size cap. Existing bounded application diagnostics remain separate.

Development data is stored in `data/dev.db` and is protected saved data. Set `WEFT_DEV_SECRET` explicitly before starting, following [local security and credentials](docs/OPERATIONS.md#local-security-and-credentials). Preserve the installation's existing key when it holds encrypted connections.

If `.env` does not exist, copy `.env.example` to it. For bank connections, use **System settings → Plaid**. `PLAID_*` environment variables are not read by the runtime. The development launcher overrides `WEFT_SECRET` and `WEFT_DB_PATH` with its development values. An eligible account's settings can repair an existing Item; that repair affects the accounts sharing the Item. See [bank mapping and repair](docs/contract/accounts.md#mapping-and-repairing-bank-connections) for its admission rules.

Use the same `./weft` controls from every terminal and open the managed URL. Do not launch `scripts/dev-local.sh` directly alongside it.

Launch behavior is defined in [weft](weft) and [dev-local.sh](scripts/dev-local.sh). This is a development launcher; dependencies and this checkout are still required. Docker remains the alternative runtime below.

## Docker

For a new installation, copy the environment template from the repository root and set `WEFT_SECRET` using the [credential requirements](docs/OPERATIONS.md#local-security-and-credentials). Use Docker Engine 28 or later for loopback port isolation. If `.env` already exists, edit it instead of replacing it. Set up optional bank connections in **System settings → Plaid** after signing in. Preserve the secret for the installation: it decrypts this installation’s stored connection credentials. An encrypted recovery package can restore them under a destination secret without the original secret.

```bash
cp .env.example .env
# Edit .env before starting the service.
docker compose up -d --build
```

Open [localhost:9099](http://localhost:9099). The Compose configuration maps `127.0.0.1:9099` to backend port `8000` and mounts `./data` at `/data`. Compose defaults to `data/weft.db`, a separate database from local development’s `data/dev.db`; starting it does not import the development installation. See [docker-compose.yml](docker-compose.yml) and the [Dockerfile](backend/Dockerfile).

The image contains the built frontend and serves it with the API through one backend process. Node, Vite and version-pinned uv are used during the image build and are absent from the runtime image. Frontend builds include `dist/licenses/`; the image retains this at `/app/app/static/licenses/`, alongside installed Python, CPython and Debian notices. See [third-party notices](THIRD_PARTY_NOTICES.md) for locations and the additional checks required before distributing prebuilt images.

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

Start and open the app with `./weft` and inspect the affected user flow deliberately. New automated tests require a reproduced defect and a durable observable boundary. Documentation-only changes require fact, link, anchor and whitespace checks.
