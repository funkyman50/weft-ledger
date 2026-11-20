# Operations

This guide covers the runtime model, credentials, diagnostics, backup and restore, and schema revisions for one installation. The [product contract](PRODUCT_CONTRACT.md) owns approved behavior.

## Runtime model

Run one backend process. Page-session Undo/Redo, write admission, scheduled jobs and diagnostic memory are process-local. Multiple backend workers are not supported. Each backend holds an exclusive lock on `<database>.lock` for its lifetime, so a second backend on the same database refuses to start. Ordinary restarts preserve saved data and local-save confirmations but end temporary Undo history. The register renews its session in place and keeps drafts and comparison choices. A rejected action needs a second deliberate click; the app never replays it automatically.

Local saves record a small confirmation in the same database transaction. The tab retains only the request identity in session storage so Refresh can inspect an uncertain save after restart or page reload. Recovery requires fresh authoritative reads. If evidence is still missing, the owner can choose **I checked the result—continue**; the result remains unknown and the draft remains available. Failed reads keep saving blocked. Bank operations use their own status checks. Database replacement requires reload. If browser storage is unavailable, the app warns that recovery information cannot survive reload. Confirmations are bounded by age and count in [commands.py](../backend/app/services/commands.py); they do not extend Undo history or contain financial snapshots.

The backend lazily starts one isolated regex evaluator subprocess to bound payee-rule execution. It receives only patterns and tested text, has an empty environment, and owns no database, application history, schedules or provider credentials. Rule limits produce actionable errors; the rules list stays editable when its counts are unavailable. The evaluator uses POSIX signals and pipes; the supported runtimes are macOS and Linux.

Scheduled transactions enter due occurrences before the existing six-hour background sync and at startup, including when no bank is connected. Automatically entered rows start as Needs review. The job reserves one write batch, isolates definition failures with savepoints, and matches after the successful due pool exists. Schedule status has its own refresh signal; a publication failure is diagnosed and the runner retries that signal on its next run. See [scheduled transactions](contract/schedules-loans-and-transfers.md#scheduled-transactions) for recurrence, account pauses, and Enter this occurrence history.

The backend reads runtime environment settings at startup; restart to apply those changes. Plaid credentials and login password changes use saved installation settings and apply without restart. Use absolute paths for `WEFT_DB_PATH` and an optional `WEFT_LOG_DIR`, including the database path supplied to stopped-app restore.

Plaid uses the certifi CA bundle for TLS verification. The OpenAI HTTPX client uses it by default unless an SSL_CERT_FILE or SSL_CERT_DIR override is set. Plaid requests use explicit SDK transport timeouts without automatic retries. Transaction downloads request up to 500 records per page and reject repeated cursors before applying a batch. Healthy pagination can finish a large backlog without an arbitrary overall time limit. Last-Item revocation retains its shorter timeout and existing custody transaction. A timed-out public-token exchange reports an unknown provider outcome and directs the operator to check Plaid before linking again. Transport timeouts do not provide hard cancellation of DNS resolution or a response that continuously delivers bytes.

## Local security and credentials

Weft supports one local user. Keep both supported runtimes on this computer; LAN access, public hosting and reverse proxies are outside this setup. Requests must use `localhost`, `127.0.0.1` or `[::1]`. Login and API writes must come from the same browser origin, including its port. Direct API tools must supply that matching `Origin` header for writes. The OpenAI GET callback keeps its separate state and nonce checks. Forwarded headers do not change request admission.

Passwords are optional. New installations open without a login prompt. In **System settings → Security**, turn on **Require password**, enter a new password twice, and choose **Set password**. An enabled password must have 12 to 4096 characters. Enter the current password to change or remove it. Saving renews the submitting browser's session and invalidates older cookies; tabs sharing that browser's cookies follow normal browser behavior. Closing a browser does not reliably end its session.

Without a password, other people, accounts and programs on this computer can open Weft, export data and change settings, including recovery keys. The Host/Origin/browser protections stay active, and APIs still require a session established by same-origin login. Password-free mode is not isolation from other computer users.

The password file is `<database-stem>.auth.json`, beside the database. It stores a salted scrypt hash and random session revision with owner-only permissions and atomic replacement. Settings is the sole runtime password source; `WEFT_PASSWORD` and `WEFT_DEV_PASSWORD` are not read. Authentication reads the file afresh. A missing or unreadable file for an existing database blocks access; startup never silently removes its password. Financial backups exclude this file, and restore keeps destination password settings. A new-machine recovery starts password-free. If a password save has an uncertain result, reload and sign in with the saved password, then inspect Security before trying again.

The installation encryption key is mandatory. It must be 64 lowercase hexadecimal characters. Startup and offline financial restore refuse invalid keys before touching saved data. Replacing an existing key without re-encrypting all protected stores makes bank tokens, Plaid settings and OpenAI state unreadable. Password changes never rotate this key. The backend never generates or replaces a key.

The installed runtime keeps its key in `installation.key` in the [data folder](../README.md#install-and-run), with owner-only permissions. When neither the key file nor the database exists, Start generates the key from the system random source, writes it durably before first use and prints its path. Back it up privately, separately from financial backups. Start never rewrites an existing key. If the database exists without the key file, Start refuses; restore the key file from its backup.

Development reads `WEFT_DEV_SECRET` from `.env` in the checkout. Generate it once:

```bash
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

Format validation does not prove randomness; use the generator. Copy `.env.example` only for a new development configuration. Edit existing `.env` files in place and use `chmod 600 .env`. Never commit key files or `.env`, or paste their contents into reports. There is no fallback key.

### Private installation files

Keep databases, credentials, backups, recovery keys, diagnostic exports and browser sign-in state in the runtime data folder, in `data/`, or elsewhere outside the source checkout. Repository ignore rules cover common installation filenames and downloaded exports, including custom database paths with `.db` or `.sqlite` names. Databases with other filenames must stay outside the checkout or receive an explicit ignore rule. They do not remove files already tracked by Git or clear earlier history. Review an explicit source-file list before sharing a checkout.

### Local password recovery

Stop Weft before using the local reset command. It needs the existing database's absolute path, not its encryption key. It prompts privately for a new password and confirmation. A blank password is refused; add `--remove` only to deliberately remove login protection. The command preserves any existing password file in an owner-only `*.auth.json.before-reset-*` copy, rotates the session revision, and changes no financial data or provider credentials.

Run it from the repository root. Set `DATA` to the installed runtime's [data folder](../README.md#install-and-run): `"$HOME/Library/Application Support/Weft"` on macOS, `"${XDG_DATA_HOME:-$HOME/.local/share}/weft"` on Linux.

```bash
./weft stop
(cd backend && uv run python -m app.auth --database "$DATA/weft.db")
./weft start
```

For development, set `DATA="$PWD/data"` at the repository root, then use `./weft dev stop`, `--database "$DATA/dev.db"` and `./weft dev start`.

Retain the private recovery copy until the new login succeeds. Password recovery does not recover a lost installation encryption key or a lost backup recovery key.

## Diagnostics

After a failure, open **System settings → Diagnostics → Download diagnostics** before reloading. The JSON download combines retained server events with the current page's browser events. If the server request fails or reaches its ten-second timeout, the download contains browser events only. A render failure also offers a browser report before reload.

No report is uploaded automatically. Browser events disappear on reload. Reports omit credentials, cookies, tokens, request/response payloads, query strings, financial values and account/payee/institution names. They still contain operational identifiers and timestamps. Keep reports private and inspect them before sharing.

### Storage and retention

Server events are JSON lines in the terminal and rotating local files. Default paths are:

| Installation | Host log path |
| --- | --- |
| Installed runtime | `logs/weft.db/events.jsonl` in the data folder |
| Local development | `data/logs/dev.db/events.jsonl` |

`WEFT_LOG_DIR` overrides the directory. Different server processes must not write to the same directory. Files use private permissions. Retention has size and count limits, with no guaranteed number of days:

| Record | Limit |
| --- | --- |
| Server files | Active file plus three older files; each rotates at 5 MiB, for up to 20 MiB. |
| Server report | Up to 1,500 ordinary events and 500 warning/error events, from files and current process memory. |
| Browser page | Up to 150 ordinary events and 50 warning/error events. |

Successful requests under one second use the ordinary-event quota. Requests taking one second or longer are warnings and can consume the warning/error quota. If file storage fails, the terminal emits `diagnostics.storage_unavailable`. The process keeps bounded memory events and the report marks storage unavailable. Logging failure does not reject an otherwise valid save. Restarting loses the memory fallback.

### Correlating a failure

Use these fields to follow one operation through its owners:

| Field | Meaning |
| --- | --- |
| `diagnostic_id` | Request UUID returned in the application response's `X-Diagnostic-ID` header. Server events supply route, status and duration. |
| `ledger_request_id` | Separate UUID for a page-session save and its recorded-outcome inspection. |
| `job_run_id` | One background job invocation. |
| `item_id` | Local numeric Plaid Item identifier. |
| `attempt_id` | Staged account-conversion UUID. |
| `plaid_request_id` | Provider request reference when the SDK response or error supplies one. |
| `plaid_error_code`, `plaid_error_type` | Allowlisted provider failure classifications when available. |

Events record SDK operation and pagination progress. Failures retain exception classes and bounded stack locations, including chained causes. Raw exception messages are omitted. Browser reports identify the production entry bundle and retain same-origin JavaScript chunk filenames with line and column offsets. Messages, function names, URL origins and queries are omitted. Use the reported build and chunk to locate a minified frame.

Diagnostics do not change provider retries or recover evidence discarded before instrumentation existed. The stopped-app restore CLI keeps its human-readable output. See [server diagnostics](../backend/app/diagnostics.py) and [browser diagnostics](../frontend/src/lib/diagnostics.ts) for the record formats.

### Matching lifecycle evidence

The same server logs and download record `lifecycle.decision` for automatic matches, bank associations, corrections, rejection, transfer restoration and Undo/Redo. Relationship-bearing provider changes record status, removal/reappearance and amount/date-change flags. Imports retain the existing batch counts instead of a per-row event.

Events include the database generation, rule version, workflow, reason, local endpoints and applicable evidence. `candidate_count` and `peer_count` describe eligible competition; `neighborhood_count` describes the bank inference's same-amount loaded neighborhood. Date distances are day counts, not transaction dates. No amount, name, note, raw provider ID or payload is recorded.

The existing ledger write context publishes only after outer commit. Rollback and discarded sessions publish no decisions. Scheduled-entry savepoints stage none; their matching runs afterwards at the root. Logging and summary failures do not change save outcomes. `LIFECYCLE_RULE_VERSION` identifies matching/lifecycle policy and must change with that policy.

`lifecycle.blocked_summary` groups a pass's observations by workflow, account and reason. It carries a count and at most two example endpoint pairs; evidence fields describe the first example. An unchanged summary is suppressed by a 1,000-entry process-local LRU cache. Changed counts or sampled evidence, restart or eviction can produce another event. Each root transaction admits up to 800 transition events and 200 blocked groups. `lifecycle.omitted` reports observations beyond those limits or with invalid diagnostic classifications. Existing rotation and report quotas still apply; these logs are sampled operational evidence, not a permanent or exhaustive audit trail.

## Backups and restore

System settings → Backup & restore creates a whole-file encrypted `.age` package. It contains saved financial records, account settings and logos, schedules, relationships and protected bank connections. OpenAI connection/settings, browser preferences, temporary Undo, requests and diagnostics are excluded. See the [backup Contract](contract/system.md#backup-restore).

Backup setup begins only when you first request a backup. Confirm the current Weft password when one is enabled, save the generated recovery key separately, and paste it back to confirm. Later backups ask for the current Weft password only when one is enabled. Weft retains the public recipient, never the private recovery key. The download filename includes its key identifier. Keep the private key independently from a verified current package stored off this machine. Files on the live machine alone do not protect against losing it.

Choose a `.age` package and enter its recovery key to preview accounts, Working balances and latest ordinary transaction dates. Confirm replacement explicitly, with the current destination password when one is enabled. The key stays only in the open form and clears on cancel, tab departure or completion. An uncertain restore result blocks further operations and offers Reload to inspect the current database; another restore needs a fresh preview. Decryption proves integrity, not who created the package. Inspect the preview before continuing.

Restore replaces the entire dataset and discards later local edits. It permits unchanged-bank-custody rollback or recovery into an empty installation with no accounts, bank records or staged conversion. Populated destinations with different custody are refused. A fresh recovery does not require the original secret or configuration. It adopts the matching public recipient; rollback preserves the destination’s current recipient. Provider access still needs compatible Plaid configuration and may require repair or reconnection. Financial recovery makes no provider calls. Finish or abandon staged conversion before backup or restore.

After restore, a red message replaces the sync times beside Sync Plaid: **Bank sync paused after restore — press Sync Plaid to resume.** The pause survives restarts and blocks all bank-provider calls, including repair and revocation. The first admitted manual Sync Plaid press releases it and starts ordinary sync; a failed refresh does not reinstate it. The button remains available with no bank connections. Local work remains available. Other tabs must reload before saving.

The public recipient and pause live in owner-only `<database-stem>.backup.json`, separate from financial SQLite. Keep that file with the active installation; do not delete it to clear the pause. Corrupt settings refuse startup. A separate private UUID file at `<database path>.generation` changes before database replacement, including safety fallback. Do not replace live databases or generation markers manually. Ordinary rollback preserves the destination’s separate OpenAI state.

Only the current package format and exact current schema are supported. The encrypted file and decrypted payload are limited to 256 MiB, shown as 256 MB. Encryption overhead can put a near-limit database over the file limit. At that limit, buffer-based encryption/decryption may need approximately 1 GiB of process memory. There is no backup schedule, backup library or cloud destination beyond the release backups below.

To verify a download, select it under Restore, enter its matching recovery key and wait for the preview. Cancel without confirming replacement. Retain one verified current package off this machine and its key independently. Replacing a lost key on a working installation protects future backups only; old packages need their old keys. Keep old keys and existing raw recovery copies until the replacement package passes a recovery rehearsal. The app does not prune recovery files; only release commands prune their own release backups. Take and verify a fresh package after each schema upgrade. See [data protection](contract/system.md#data-protection-and-schema-upgrades).

The owner's release commands in the development checkout also create packages. `./weft release publish` backs up the development database to `data/backups/weft-dev-v<version>-<time>-<key id>.age` before it starts the release. `./weft release update` stops the installed runtime, backs it up to `backups/weft-prod-v<version>-<time>-<key id>.age` in its data folder, and then installs the new release; any failure returns it to the previous release. Each name carries the version of the code that created it. Each folder keeps release backups from its two newest versions and deletes older ones; other files are never deleted. These packages stay on this machine and are unverified until previewed under Restore. A package restores with any checkout whose schema matches it. After a schema change, restore an older package with the matching older release into an empty data folder.

### Emergency restore

Stop every Weft process before using the CLI. Supply the destination installation's key as `WEFT_SECRET` and set the destination database path. For an empty new installed runtime, run `./weft start` once to create its key and empty database, then `./weft stop`; the source installation’s original secret is unnecessary. The CLI prompts privately for the recovery key. Do not put that key in a command argument or environment variable. A missing database is an empty recovery destination; an existing destination must pass current-schema and custody admission. Incompatible or unreadable current data is refused. Preserve damaged data and its matching sidecars; recover into a new empty destination instead of bypassing admission.

For the installed runtime, run from `backend/` with `DATA` set to its data folder as in [local password recovery](#local-password-recovery):

```bash
WEFT_SECRET="$(cat "$DATA/installation.key")" WEFT_DB_PATH="$DATA/weft.db" uv run python -m app.restore_backup /absolute/path/to/backup.age
```

For development, run from `backend/` with the development secret from `.env` as `WEFT_SECRET`:

```bash
WEFT_DB_PATH=/absolute/path/to/weft/data/dev.db uv run python -m app.restore_backup /absolute/path/to/backup.age
```

Preserve the installation key for existing bank records and the separate OpenAI file.

Both restore paths use the same admission, token rewrapping, safety snapshot and SQLite replacement owners in [database_backup.py](../backend/app/services/database_backup.py). Existing data gets a private safety copy beside the destination. The bank pause is persisted before generation rotation and replacement. A failed replacement recovers from the retained safety copy; a failed fallback stops normal admission and requires operator recovery. SQLite sidecars block stopped-app replacement. Follow [SQLite recovery](#sqlite-recovery); never delete sidecars by guesswork.

### SQLite recovery

An interrupted save can leave SQLite recovery files beside the database. If startup cannot read the database while `-journal`, `-wal` or `-shm` files are present, it reports those files and preserves them. This does not by itself mean the database is corrupt.

Stop every Weft process. Preserve a private copy of the database, its generation marker and all matching sidecars together before recovery. Keep their original names and keep the installation secret available. Create a second working copy in a separate folder that also contains the database and all matching recovery files under their original names. Use SQLite to open that working copy read-write and read its schema; SQLite can then replay its rollback journal or recover its write-ahead log. Check integrity, foreign keys and Weft's current schema on that recovered copy before choosing a restore path. If recovery fails, retain both copies for investigation. Never delete a sidecar to force startup, replace only the main database file, or use an older backup before checking recovery of the latest data.

## Schema revisions

Schema changes require an explicitly reviewed [preserving upgrade procedure](contract/system.md#data-protection-and-schema-upgrades) for the existing format. The runtime accepts only the current format and provides no automatic schema migration. Keep the working application version and matching recovery material until an update is accepted and its current-format backup is verified.

[backend/app/schema.sql](../backend/app/schema.sql) defines the current schema and target `PRAGMA user_version`. Only revision 38 is supported. Each retained bank connection records its Plaid Client ID fingerprint and environment, and the times of its latest bank update and Weft sync; API credentials stay in separate encrypted installation storage. Databases and backups with a different schema are refused without modification. Keep a verified current-format backup and its separately saved recovery key.

The schema also includes loan details (kind and escrow amount), immutable reported-balance observations, account logos/groups/reporting defaults and account order. Full financial backups include those saved facts.

Startup and restore share [schema_admission.py](../backend/app/schema_admission.py). They check the revision, full schema objects, SQLite integrity, foreign keys, saved payee-rule amount directions and icon-library image/size rules. Amount conditions require Inflow or Outflow; rules without an amount condition remain valid. A failed check preserves the database and blocks normal startup.

[db.py](../backend/app/db.py) refuses a revision mismatch without replacing the database. This is the supported behavior, not an unfinished upgrade feature. A future schema change must define its handling of the current installation before execution. A mismatch never authorizes a reset; changing the revision number alone does not make a database compatible.

An ordinary restart with the same revision preserves saved data. Changes to the current installation also preserve initialization progress and starting balances unless a reset is explicitly approved. Startup sync imports linked accounts in the background. Accounts initialize automatically only when history, bank balance and pending-state conditions permit it; other accounts remain **PEND**. See [account initialization](contract/accounts.md#account-initialization) for manual setup, the introduction and Re-init.

[category_seeds.sql](../backend/app/category_seeds.sql) supplies 17 ordinary categories and 65 subcategories for fresh databases. Its generic starter labels apply only to new databases. Editing that file never renames, recreates or reclassifies saved categories. UI edits do not rewrite it. Changes to the current installation preserve existing categories, edits, deletions and assignments instead of reapplying starter data unless a reset is explicitly approved. Tracked-account transfer targets retain their account relationships. A separately approved destructive reset must state its seed and retention behavior explicitly.
