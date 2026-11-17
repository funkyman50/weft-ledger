# Weft project guidance

Weft is a pre-1.0 personal account register. This file guides coding agents and maintainers working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) owns contribution policy; pull requests are not accepted yet.

[PRODUCT_CONTRACT.md](docs/PRODUCT_CONTRACT.md) and its area files under `docs/contract/` own approved product requirements. The maintainer's explicit current direction controls product decisions. Future ideas and existing or old routes do not expand scope.

## Read and work within the boundary

Read this file and the contract's opening scope, section index, terms, and exclusions. Then read the complete sections affected by the task and their dependencies. Register changes can affect history, matching and transfers. Connection changes can affect initialization, pending lifecycle and data custody. Before changing source, read the entries for the affected files in the [owner map](docs/CODE_OWNERSHIP.md). [README.md](README.md#documentation) provides the documentation map and operating instructions.

If implementation and the contract disagree, state the mismatch. A requested defect fix restores approved behavior. An approved product change must update the affected contract before implementation. Do not rewrite a requirement to justify accidental behavior.

Maintain one current runtime, schema, API and caller set. Do not add speculative dual readers/writers, aliases, deprecated routes/parameters, old API payload parsers, internal-shape adapters or historical migration support. Obsolete runtime code can be removed without maintaining compatibility with discarded formats.

Beyond the approved deterministic Scheduled projected balance, do not restore forecasting, budgeting, amortization, loan planning, split transfers, automatic counterpart creation beyond approved scheduled transfers, synchronized twin editing, generic database-shaped transaction writes, or compatibility routes without a new product decision. `loan` remains an account-type label; Loan details and Resolve difference follow the loan contract.

Preserve unrelated working-tree changes. Make surgical changes and keep APIs intent-shaped. Render client permissions from `LedgerRow.allowed_actions` and `editable_fields`; the backend ledger remains the policy owner.

Use the supported [runtime with one backend process](docs/OPERATIONS.md#runtime-model). Do not add workers that separate page history, recorded outcomes or scheduled jobs across processes.

The regex evaluator subprocess is a bounded computation helper, not another backend runtime. It receives only pattern/text pairs with no inherited environment, database, page history, jobs or provider credentials.

## Saved data

The [data-protection contract](docs/contract/system.md#data-protection-and-schema-upgrades) governs saved data. These rules always apply:

- A schema mismatch never authorizes deletion. Startup and restore refuse an incompatible schema without replacing saved data.
- A schema change must state how it handles existing installations before execution.
- A destructive reset requires explicit approval of the data lost and retained, and a recovery copy.
- Only explicitly designated isolated test data is disposable. Never experiment on a real database; use synthetic data.
- Historical schema migrations, legacy-data conversion and older-backup recovery are outside scope.
- Never commit databases, backups, recovery keys, `.env` files, logs or real financial data.

## Code ownership

The [owner map](docs/CODE_OWNERSHIP.md) names the owner of each responsibility and the register read boundaries. The source is arranged as follows:

- `frontend/src/App.tsx` and `frontend/src/api/` own authentication, the runtime/query boundary, ordered page-session writes and recovery reads.
- `frontend/src/features/<area>/` owns the accounts, categories, payees, ledger, plaid and settings interfaces.
- `frontend/src/components/` and `frontend/src/lib/` own shared controls and pure helpers. `frontend/src/blueprint.css` owns design tokens.
- `backend/app/services/` owns domain policy, with one owner for each workflow.
- `backend/app/routers/` translates retained HTTP commands; it does not recreate domain policy.
- `backend/app/db.py`, `schema.sql`, `schema_admission.py` and `models.py` own the current schema and startup admission.

These rules apply across owners:

- `backend/app/services/ledger_projection.py` is the sole read-only ledger projection and action-policy owner. Do not add a second one, and do not import domain command owners into it.
- A ledger command passes through the ordered client transport and the backend command boundary. An unknown sent-write outcome blocks later writes until the prescribed inspection and fresh reads succeed. Provider sync and staged connection use their named provider boundaries. Preserve those distinctions when changing callers; do not add a second persistence-policy owner.
- Bump `LIFECYCLE_RULE_VERSION` in `backend/app/diagnostics.py` when automatic matching or lifecycle policy changes.
- Use the shared owner for buttons, dialogs, menus, pickers and search before adding a surface-specific variant.

## Documentation

Before completion, update the permanent document whose facts changed. Unresolved findings go to the [future-concepts queue](docs/FUTURE_FEATURES_AND_CONCEPTS.md). Do not create historical audit or plan archives. Never put real financial data, credentials or personal details in documentation.

Check affected local links, heading anchors, source paths and commands. Update only documents whose behavior or guidance changed. Add a concise flow/invariant explanation to the owner map only when it resolves a recurring question or difficult handoff.

## Writing style

Use simplified technical English principles. Lead with the purpose or answer. Explain behavior and limits before commands, fields and source references.

- Use one term for one concept. Define unfamiliar project terms or link to their owner.
- Put conditions before the rules they affect. Use `must` for requirements and `can` for capability.
- Keep code facts, project requirements, dated checks, proposals and unanswered questions distinct. Use present tense for verified current behavior.
- Preserve necessary precision: exact labels, identifiers, states, formulas and failure classes. Put dense detail in subordinate sections, tables, lists or examples.
- Avoid unsupported claims such as safe, complete, guaranteed or production-ready.
- Give each explanation one home. Link to that home instead of copying it.

A rewrite must preserve approved behavior, conditions, exceptions and visual requirements. Exact APIs, schema and token values live in source.

## Verification and automated tests

Default: no new automated tests. Add one only for a reproduced defect. It must fail against the broken behavior, pass with the fix, protect a stable observable boundary, and justify its maintenance. Do not add tests for features, refactors, coverage targets, hypothetical failures or implementation structure.

Use applicable non-test checks: compilation, linting, builds, schema/startup validation and deliberate manual acceptance. For documentation-only changes, check facts, links, anchors and whitespace.

Run the source checks from the repository root. [README.md](README.md#verification) lists the existing regression tests.

```bash
(cd backend && uv run python -m compileall -q app)
(cd frontend && npm run lint)
(cd frontend && npm run build)
```

Every new persistent write route must enter its command or provider boundary, state its history/outcome policy, and pass a persisted-after-success acceptance check on disposable data.

Before shipping a schema change, verify its stated handling of existing installations on synthetic data. Check saved values, IDs, relationships, initialization, provider custody/cursors and schedules through fresh reads. Verify that failed admission preserves the original data and blocks normal work.

## Comments and docstrings

Default: none. Add a comment only for a fact the code cannot encode: an invariant, a rejected alternative likely to recur, a hazard, an intentional omission, a copied algorithm with its source, or an external workaround with a resolvable issue reference. Prefer names, types, structure or assertions. Use one sentence by default and at most three.

Do not narrate code, restate helper bodies, add section banners, record history in source, retain commented-out code, or add TODO/FIXME without a ticket.
