PRAGMA foreign_keys = ON;

CREATE TABLE account_logos (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80 AND id NOT GLOB '*[^a-z0-9_-]*'),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    image BLOB NOT NULL CHECK (typeof(image) = 'blob' AND length(image) BETWEEN 8 AND 262144 AND substr(image, 1, 8) = X'89504E470D0A1A0A')
);
CREATE INDEX ix_account_logos_digest ON account_logos (digest);

CREATE TABLE accounts (
    id INTEGER NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    logo_id TEXT REFERENCES account_logos (id) ON DELETE RESTRICT,
    group_name TEXT CHECK (group_name IS NULL OR (length(group_name) BETWEEN 1 AND 80 AND group_name = trim(group_name))),
    cash_flow_reporting BOOLEAN NOT NULL CHECK (cash_flow_reporting IN (0, 1)),
    net_worth_reporting BOOLEAN NOT NULL CHECK (net_worth_reporting IN (0, 1)),
    type TEXT NOT NULL CHECK (type IN ('checking', 'savings', 'credit', 'cash', 'loan')),
    sort_order INTEGER NOT NULL,
    closed BOOLEAN NOT NULL,
    plaid_current_balance_cents INTEGER,
    plaid_available_balance_cents INTEGER,
    plaid_limit_cents INTEGER,
    plaid_balance_iso_currency_code TEXT,
    plaid_balance_updated_at DATETIME,
    starting_balance_initialized_at DATETIME,
    plaid_history_imported_at DATETIME
);

CREATE TABLE payees (
    id INTEGER NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'ordinary' CHECK (kind IN ('ordinary', 'myself', 'starting_balance', 'unknown')),
    default_category_id INTEGER REFERENCES categories (id) ON DELETE SET NULL,
    remembered_category_id INTEGER REFERENCES categories (id) ON DELETE SET NULL,
    category_streak_ids JSON NOT NULL DEFAULT '[]',
    default_category_prompt_dismissed BOOLEAN NOT NULL DEFAULT 0 CHECK (default_category_prompt_dismissed IN (0, 1)),
    CHECK (kind IN ('ordinary', 'myself') OR (
        default_category_id IS NULL AND remembered_category_id IS NULL
        AND category_streak_ids = '[]' AND default_category_prompt_dismissed = 0
    ))
);
CREATE UNIQUE INDEX uq_payees_system_kind ON payees (kind) WHERE kind != 'ordinary';

CREATE TABLE payee_rules (
    id INTEGER NOT NULL PRIMARY KEY,
    payee_id INTEGER NOT NULL REFERENCES payees (id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories (id) ON DELETE RESTRICT,
    account_id INTEGER REFERENCES accounts (id) ON DELETE CASCADE,
    position INTEGER NOT NULL UNIQUE,
    amount JSON,
    text_conditions JSON NOT NULL,
    conditions_key TEXT NOT NULL UNIQUE
);
CREATE INDEX ix_payee_rules_payee ON payee_rules (payee_id);
CREATE INDEX ix_payee_rules_account ON payee_rules (account_id);
CREATE INDEX ix_payee_rules_category ON payee_rules (category_id);

CREATE TABLE categories (
    id INTEGER NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    parent_id INTEGER REFERENCES categories (id),
    archived BOOLEAN NOT NULL,
    is_discretionary BOOLEAN CHECK (is_discretionary IS NULL OR is_discretionary IN (0, 1)),
    CHECK (parent_id IS NOT NULL OR is_discretionary IS NULL)
);
CREATE UNIQUE INDEX uq_categories_parent_name_key ON categories (name_key) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX uq_categories_child_name_key ON categories (parent_id, name_key) WHERE parent_id IS NOT NULL;

CREATE TABLE plaid_items (
    id INTEGER NOT NULL PRIMARY KEY,
    item_id TEXT NOT NULL UNIQUE,
    client_id_hash TEXT NOT NULL CHECK (length(client_id_hash) = 64 AND client_id_hash NOT GLOB '*[^0-9a-f]*'),
    environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
    access_token_enc TEXT NOT NULL,
    cursor TEXT NOT NULL,
    institution TEXT NOT NULL,
    institution_id TEXT
);

CREATE TABLE plaid_sync_state (
    id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    last_sync DATETIME,
    schedule_revision INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL,
    matched INTEGER NOT NULL,
    suggested INTEGER NOT NULL,
    queued INTEGER NOT NULL,
    errors JSON NOT NULL
);

CREATE TABLE scheduled_transactions (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    next_date DATE NOT NULL,
    frequency TEXT NOT NULL CHECK (frequency IN ('once', 'daily', 'weekly', 'every_other_week', 'every_four_weeks', 'monthly', 'every_two_months', 'every_three_months', 'every_four_months', 'twice_yearly', 'yearly', 'every_two_years')),
    anchor_day INTEGER NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
    payee_id INTEGER NOT NULL REFERENCES payees (id),
    transfer_account_id INTEGER REFERENCES accounts (id),
    category_id INTEGER REFERENCES categories (id),
    memo TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    match_tolerance_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(match_tolerance_cents) = 'integer' AND match_tolerance_cents BETWEEN 0 AND 9007199254740991),
    end_date DATE,
    CHECK (end_date IS NULL OR end_date >= next_date)
);
CREATE INDEX ix_scheduled_transactions_due ON scheduled_transactions (next_date);

CREATE TABLE transactions (
    id INTEGER NOT NULL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    date DATE NOT NULL,
    description TEXT NOT NULL,
    payee_id INTEGER NOT NULL REFERENCES payees (id),
    transfer_account_id INTEGER REFERENCES accounts (id),
    transfer_payee_confirmed BOOLEAN NOT NULL DEFAULT 0 CHECK (transfer_payee_confirmed IN (0, 1)),
    category_id INTEGER REFERENCES categories (id),
    category_assigned BOOLEAN NOT NULL DEFAULT 0,
    memo TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    match_tolerance_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(match_tolerance_cents) = 'integer' AND match_tolerance_cents BETWEEN 0 AND 9007199254740991),
    status TEXT NOT NULL CHECK (status IN ('pending', 'uncleared', 'cleared', 'reconciled')),
    manually_cleared BOOLEAN NOT NULL DEFAULT 0,
    approved BOOLEAN NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('manual', 'plaid', 'starting_balance')),
    flag TEXT CHECK (flag IS NULL OR flag IN ('red', 'orange', 'yellow', 'green', 'blue', 'violet')),
    plaid_txn_id TEXT UNIQUE,
    plaid_raw JSON,
    plaid_removed_at DATETIME,
    pending_resolved BOOLEAN NOT NULL DEFAULT 0
        CHECK (pending_resolved IN (0, 1)),
    plaid_excluded_at DATETIME,
    plaid_excluded_amount_cents INTEGER,
    feed_historical_at DATETIME,
    provider_lifecycle_detached_at DATETIME,
    feed_replacement_id INTEGER REFERENCES transactions (id) ON DELETE SET NULL,
    pending_replacement_id INTEGER REFERENCES transactions (id) ON DELETE SET NULL,
    transfer_partner_id INTEGER UNIQUE REFERENCES transactions (id) ON DELETE SET NULL,
    CHECK (source = 'manual' OR match_tolerance_cents = 0),
    CHECK (transfer_partner_id IS NULL OR transfer_partner_id != id),
    CHECK (
        NOT manually_cleared OR (
            source = 'plaid'
            AND status = 'pending'
            AND plaid_removed_at IS NULL
            AND plaid_excluded_at IS NULL
            AND pending_replacement_id IS NULL
        )
    )
);

CREATE INDEX ix_transactions_account_date_id
    ON transactions (account_id, date, id);
CREATE INDEX ix_transactions_amount_date_account
    ON transactions (amount_cents, date, account_id);
CREATE INDEX ix_transactions_account_source_plaid
    ON transactions (account_id, source, plaid_txn_id);
CREATE INDEX ix_transactions_pending_replacement
    ON transactions (pending_replacement_id);
CREATE INDEX ix_transactions_feed_replacement ON transactions (feed_replacement_id);
CREATE INDEX ix_transactions_transfer_memory ON transactions (account_id, transfer_account_id, date, id)
    WHERE transfer_payee_confirmed = 1 AND transfer_account_id IS NOT NULL;

CREATE TABLE bank_continuities (
    id INTEGER NOT NULL PRIMARY KEY,
    source_transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    target_transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('provider', 'explicit', 'inferred_posted', 'inferred_pending')),
    state TEXT NOT NULL CHECK (state IN ('active', 'rejected', 'inactive')),
    payee_source TEXT NOT NULL DEFAULT 'target' CHECK (payee_source IN ('source', 'target')),
    transfer_source TEXT NOT NULL DEFAULT 'target' CHECK (transfer_source IN ('source', 'target')),
    category_source TEXT NOT NULL DEFAULT 'target' CHECK (category_source IN ('source', 'target')),
    memo_source TEXT NOT NULL DEFAULT 'target' CHECK (memo_source IN ('source', 'target')),
    flag_source TEXT NOT NULL DEFAULT 'target' CHECK (flag_source IN ('source', 'target')),
    handoff JSON NOT NULL DEFAULT '{}',
    UNIQUE (source_transaction_id, target_transaction_id),
    CHECK (source_transaction_id != target_transaction_id)
);
CREATE UNIQUE INDEX uq_bank_continuities_active_successor
    ON bank_continuities (source_transaction_id) WHERE state = 'active';
CREATE UNIQUE INDEX uq_bank_continuities_active_predecessor
    ON bank_continuities (target_transaction_id) WHERE state = 'active';

CREATE TABLE automatic_transfer_links (
    id INTEGER NOT NULL PRIMARY KEY,
    outflow_transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    inflow_transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('active', 'rejected', 'inactive')),
    reason TEXT NOT NULL CHECK (reason IN ('destination', 'provider', 'explicit')),
    handoff JSON NOT NULL DEFAULT '{}',
    UNIQUE (outflow_transaction_id, inflow_transaction_id),
    CHECK (outflow_transaction_id != inflow_transaction_id)
);

CREATE TABLE transaction_allocations (
    id INTEGER NOT NULL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    category_id INTEGER REFERENCES categories (id),
    memo TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
    unassigned BOOLEAN NOT NULL DEFAULT 0,
    UNIQUE (transaction_id, position),
    CHECK (NOT unassigned OR category_id IS NULL)
);
CREATE UNIQUE INDEX uq_transaction_allocations_unassigned
    ON transaction_allocations (transaction_id) WHERE unassigned;

CREATE TABLE plaid_account_links (
    id INTEGER NOT NULL PRIMARY KEY,
    plaid_item_id INTEGER NOT NULL REFERENCES plaid_items (id) ON DELETE CASCADE,
    plaid_account_id TEXT NOT NULL,
    balance_history_key TEXT NOT NULL UNIQUE,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    UNIQUE (plaid_item_id, plaid_account_id)
);
CREATE UNIQUE INDEX uq_plaid_account_links_active_account ON plaid_account_links (account_id);

CREATE TABLE account_conversion_attempts (
    id TEXT NOT NULL PRIMARY KEY,
    singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
    account_id INTEGER NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
    plaid_item_id INTEGER NOT NULL UNIQUE REFERENCES plaid_items (id) ON DELETE CASCADE,
    plaid_account_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('fetching', 'review', 'failed')),
    cursor TEXT NOT NULL DEFAULT '',
    history_complete_at DATETIME,
    current_balance_cents INTEGER,
    available_balance_cents INTEGER,
    limit_cents INTEGER,
    currency_code TEXT,
    balance_fetched_at DATETIME,
    provider_account JSON NOT NULL,
    decisions JSON NOT NULL DEFAULT '{}',
    review_all_new BOOLEAN NOT NULL DEFAULT 0,
    error TEXT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE TABLE account_conversion_rows (
    id INTEGER NOT NULL PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES account_conversion_attempts (id) ON DELETE CASCADE,
    provider_transaction_id TEXT NOT NULL,
    raw JSON NOT NULL,
    date DATE NOT NULL,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    pending BOOLEAN NOT NULL,
    removed_at DATETIME,
    pending_transaction_id TEXT,
    UNIQUE (attempt_id, provider_transaction_id)
);
CREATE INDEX ix_account_conversion_rows_attempt_date ON account_conversion_rows (attempt_id, date, id);

CREATE TABLE transaction_matches (
    id INTEGER NOT NULL PRIMARY KEY,
    feed_transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    history_transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('suggested', 'matched', 'dismissed')),
    matched_by TEXT CHECK (matched_by IS NULL OR matched_by IN ('automatic', 'user')),
    payee_source TEXT CHECK (payee_source IS NULL OR payee_source IN ('feed', 'history')),
    transfer_source TEXT CHECK (transfer_source IS NULL OR transfer_source IN ('feed', 'history')),
    description_source TEXT CHECK (description_source IS NULL OR description_source IN ('feed', 'history')),
    category_source TEXT CHECK (category_source IS NULL OR category_source IN ('feed', 'history')),
    memo_source TEXT CHECK (memo_source IS NULL OR memo_source IN ('feed', 'history')),
    flag_source TEXT CHECK (flag_source IS NULL OR flag_source IN ('feed', 'history')),
    UNIQUE (feed_transaction_id, history_transaction_id),
    CHECK (
        state != 'matched' OR (
            matched_by IS NOT NULL
            AND payee_source IS NOT NULL
            AND transfer_source IS NOT NULL
            AND description_source IS NOT NULL
            AND category_source IS NOT NULL
            AND memo_source IS NOT NULL
            AND flag_source IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX uq_transaction_matches_active_feed
    ON transaction_matches (feed_transaction_id) WHERE state = 'matched';
CREATE UNIQUE INDEX uq_transaction_matches_active_history
    ON transaction_matches (history_transaction_id) WHERE state = 'matched';

CREATE TABLE command_confirmations (
    request_id TEXT NOT NULL PRIMARY KEY,
    database_generation TEXT NOT NULL,
    page_session TEXT NOT NULL,
    epoch TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    completed_at DATETIME NOT NULL,
    label TEXT NOT NULL
);
CREATE INDEX ix_command_confirmations_completed ON command_confirmations (completed_at, request_id);

CREATE TABLE loan_details (
    account_id INTEGER NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('mortgage', 'student', 'other')),
    escrow_cents INTEGER NOT NULL CHECK (escrow_cents >= 0)
);

CREATE TABLE account_balance_observations (
    id INTEGER NOT NULL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    feed_key TEXT NOT NULL,
    current_balance_cents INTEGER,
    currency_code TEXT,
    recorded_at DATETIME NOT NULL,
    provider_updated_at DATETIME
);
CREATE INDEX ix_account_balance_observations_account_recorded ON account_balance_observations (account_id, recorded_at, id);

PRAGMA user_version = 36;
