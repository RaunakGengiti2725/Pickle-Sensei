export const RUN_JOURNAL_TABLE = 'analysis_run_journal';

export const ANALYSIS_RETRYABLE_FAILURES = [
  'reservation_transport',
  'inference_technical',
  'local_commit',
] as const;

export const RUN_JOURNAL_STATES = [
  'reserve_pending',
  'reserved',
  'committed',
  'release_pending',
  'released',
  'terminal',
] as const;

export const RUN_JOURNAL_RELEASE_OUTCOMES = [
  'low_confidence',
  'cancelled',
  'failed',
  'unsupported',
  'incorrect_recognition',
] as const;

export const RUN_JOURNAL_TERMINAL_REASONS = [
  'reservation_rejected',
  'permit_not_reserved',
  'permit_not_found',
  'permit_already_finalized',
  'release_rejected',
] as const;

export const RUN_JOURNAL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS analysis_run_journal (
    owner_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    owner_generation INTEGER NOT NULL CHECK (owner_generation >= 0),
    capture_id TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    api_origin TEXT NOT NULL CHECK (length(api_origin) BETWEEN 1 AND 2048),
    reservation_key TEXT NOT NULL,
    permit_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('reserve_pending','reserved','committed','release_pending','released','terminal')),
    result_id TEXT,
    release_outcome TEXT CHECK (release_outcome IN ('low_confidence','cancelled','failed','unsupported','incorrect_recognition')),
    terminal_reason TEXT CHECK (terminal_reason IN ('reservation_rejected','permit_not_reserved','permit_not_found','permit_already_finalized','release_rejected')),
    last_http_status INTEGER CHECK (last_http_status BETWEEN 100 AND 599),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (owner_key, operation_id),
    UNIQUE (owner_key, analysis_id),
    UNIQUE (owner_key, api_origin, reservation_key),
    UNIQUE (owner_key, api_origin, permit_id),
    CHECK (
      (state = 'reserve_pending' AND permit_id IS NULL AND result_id IS NULL AND release_outcome IS NULL AND terminal_reason IS NULL) OR
      (state = 'reserved' AND permit_id IS NOT NULL AND result_id IS NULL AND release_outcome IS NULL AND terminal_reason IS NULL) OR
      (state = 'committed' AND permit_id IS NOT NULL AND result_id IS NOT NULL AND result_id = analysis_id AND release_outcome IS NULL AND terminal_reason IS NULL) OR
      (state = 'release_pending' AND result_id IS NULL AND release_outcome IS NOT NULL AND terminal_reason IS NULL) OR
      (state = 'released' AND permit_id IS NOT NULL AND result_id IS NULL AND release_outcome IS NOT NULL AND terminal_reason IS NULL) OR
      (state = 'terminal' AND result_id IS NULL AND release_outcome IS NOT NULL AND terminal_reason IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS idx_analysis_run_journal_recovery
    ON analysis_run_journal (owner_key, api_origin, attempt_count, created_at_ms, operation_id)
    WHERE state IN ('reserve_pending','reserved','release_pending')`,
  `CREATE TRIGGER IF NOT EXISTS analysis_run_journal_monotonic
    BEFORE UPDATE ON analysis_run_journal
    WHEN NEW.owner_key IS NOT OLD.owner_key
      OR NEW.operation_id IS NOT OLD.operation_id
      OR NEW.owner_generation IS NOT OLD.owner_generation
      OR NEW.capture_id IS NOT OLD.capture_id
      OR NEW.analysis_id IS NOT OLD.analysis_id
      OR NEW.request_hash IS NOT OLD.request_hash
      OR NEW.api_origin IS NOT OLD.api_origin
      OR NEW.reservation_key IS NOT OLD.reservation_key
      OR NEW.created_at_ms IS NOT OLD.created_at_ms
      OR (OLD.permit_id IS NOT NULL AND NEW.permit_id IS NOT OLD.permit_id)
      OR (OLD.result_id IS NOT NULL AND NEW.result_id IS NOT OLD.result_id)
      OR (OLD.release_outcome IS NOT NULL AND NEW.release_outcome IS NOT OLD.release_outcome)
      OR (OLD.terminal_reason IS NOT NULL AND NEW.terminal_reason IS NOT OLD.terminal_reason)
      OR NEW.attempt_count < OLD.attempt_count
      OR NOT (
        NEW.state = OLD.state OR
        (OLD.state = 'reserve_pending' AND NEW.state IN ('reserved','release_pending')) OR
        (OLD.state = 'reserved' AND NEW.state IN ('committed','release_pending')) OR
        (OLD.state = 'release_pending' AND NEW.state IN ('released','terminal'))
      )
    BEGIN
      SELECT RAISE(ABORT, 'Invalid analysis run journal transition');
    END`,
  `CREATE TABLE IF NOT EXISTS analysis_reservation_refusal (
    owner_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
    message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 512),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (owner_key, operation_id)
  )`,
  // The refusal row belongs to exactly one settled run (a plain journal row or
  // an original attempt) and is bound to it by identity on read. Ownership is
  // enforced by deletion instead of a foreign key so the owner purge, which
  // deletes each journal by owner_key, always takes the refusal rows with it.
  `CREATE TRIGGER IF NOT EXISTS analysis_reservation_refusal_follows_run_journal
    AFTER DELETE ON analysis_run_journal
    BEGIN
      DELETE FROM analysis_reservation_refusal
        WHERE owner_key = OLD.owner_key AND operation_id = OLD.operation_id;
    END`,
];

/** Additive storage version. Never migrate a legacy request into an invented
 * original snapshot, or remove its unique analysis-id/transition controls. */
export const ORIGINAL_ANALYSIS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS analysis_logical_operations (
    owner_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    api_origin TEXT NOT NULL CHECK (length(api_origin) BETWEEN 1 AND 2048),
    original_settings TEXT NOT NULL CHECK (length(CAST(original_settings AS BLOB)) BETWEEN 1 AND 65536),
    settings_hash TEXT NOT NULL CHECK (length(settings_hash) = 64),
    model_policy_hash TEXT CHECK (length(model_policy_hash) = 64),
    observation_seal TEXT CHECK (length(CAST(observation_seal AS BLOB)) BETWEEN 1 AND 131072),
    execution_hash TEXT CHECK (length(execution_hash) = 64),
    current_attempt_id TEXT,
    final_record_id TEXT,
    winning_attempt_id TEXT,
    completion_kind TEXT CHECK (completion_kind IN ('scored','low_confidence','needs_technique_confirmation','partial')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY (owner_key, operation_id),
    UNIQUE (owner_key, capture_id),
    UNIQUE (owner_key, analysis_id),
    UNIQUE (owner_key, analysis_id, capture_id, api_origin, execution_hash),
    FOREIGN KEY (owner_key, capture_id) REFERENCES local_capture(owner_key, id),
    FOREIGN KEY (owner_key, current_attempt_id) REFERENCES analysis_execution_attempts(owner_key, operation_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (owner_key, winning_attempt_id) REFERENCES analysis_execution_attempts(owner_key, operation_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (owner_key, final_record_id) REFERENCES local_analysis_record(owner_key, id) DEFERRABLE INITIALLY DEFERRED,
    CHECK ((observation_seal IS NULL AND execution_hash IS NULL AND current_attempt_id IS NULL) OR
      (observation_seal IS NOT NULL AND execution_hash IS NOT NULL AND model_policy_hash IS NOT NULL)),
    CHECK ((final_record_id IS NULL AND winning_attempt_id IS NULL AND completion_kind IS NULL) OR
      (final_record_id IS NOT NULL AND final_record_id = analysis_id AND winning_attempt_id IS NOT NULL AND
       current_attempt_id IS NOT NULL AND winning_attempt_id = current_attempt_id AND completion_kind IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS analysis_execution_attempts (
    owner_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    owner_generation INTEGER NOT NULL CHECK (owner_generation >= 0),
    capture_id TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    api_origin TEXT NOT NULL CHECK (length(api_origin) BETWEEN 1 AND 2048),
    reservation_key TEXT NOT NULL,
    attempt_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (attempt_ordinal >= 1),
    predecessor_operation_id TEXT,
    technical_failure TEXT CHECK (technical_failure IN ('reservation_transport','inference_technical','local_commit')),
    permit_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('reserve_pending','reserved','committed','release_pending','released','terminal')),
    result_id TEXT,
    release_outcome TEXT CHECK (release_outcome IN ('low_confidence','cancelled','failed','unsupported','incorrect_recognition')),
    terminal_reason TEXT CHECK (terminal_reason IN ('reservation_rejected','permit_not_reserved','permit_not_found','permit_already_finalized','release_rejected')),
    last_http_status INTEGER CHECK (last_http_status BETWEEN 100 AND 599),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (owner_key, operation_id),
    UNIQUE (owner_key, analysis_id, attempt_ordinal),
    UNIQUE (owner_key, api_origin, reservation_key),
    UNIQUE (owner_key, api_origin, permit_id),
    FOREIGN KEY (owner_key, analysis_id, capture_id, api_origin, request_hash)
      REFERENCES analysis_logical_operations(owner_key, analysis_id, capture_id, api_origin, execution_hash),
    FOREIGN KEY (owner_key, predecessor_operation_id) REFERENCES analysis_execution_attempts(owner_key, operation_id),
    CHECK ((attempt_ordinal = 1 AND predecessor_operation_id IS NULL) OR
      (attempt_ordinal > 1 AND predecessor_operation_id IS NOT NULL AND predecessor_operation_id <> operation_id)),
    CHECK (
      (state = 'reserve_pending' AND permit_id IS NULL AND result_id IS NULL AND release_outcome IS NULL AND terminal_reason IS NULL) OR
      (state = 'reserved' AND permit_id IS NOT NULL AND result_id IS NULL AND release_outcome IS NULL AND terminal_reason IS NULL) OR
      (state = 'committed' AND permit_id IS NOT NULL AND result_id = analysis_id AND result_id IS NOT NULL AND release_outcome IS NULL AND terminal_reason IS NULL AND technical_failure IS NULL) OR
      (state = 'release_pending' AND result_id IS NULL AND release_outcome IS NOT NULL AND terminal_reason IS NULL) OR
      (state = 'released' AND permit_id IS NOT NULL AND result_id IS NULL AND release_outcome IS NOT NULL AND terminal_reason IS NULL AND attempt_count > 0 AND last_http_status IS NULL) OR
      (state = 'terminal' AND result_id IS NULL AND release_outcome IS NOT NULL AND terminal_reason IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_attempt_one_successor
    ON analysis_execution_attempts (owner_key, predecessor_operation_id) WHERE predecessor_operation_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_attempt_one_commit
    ON analysis_execution_attempts (owner_key, analysis_id) WHERE state = 'committed'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_attempt_one_pending
    ON analysis_execution_attempts (owner_key, analysis_id) WHERE state IN ('reserve_pending','reserved','release_pending')`,
  `CREATE INDEX IF NOT EXISTS idx_analysis_attempt_recovery
    ON analysis_execution_attempts (owner_key, api_origin, attempt_count, created_at_ms, operation_id)
    WHERE state IN ('reserve_pending','reserved','release_pending')`,
  `CREATE TRIGGER IF NOT EXISTS analysis_logical_operations_insert
    BEFORE INSERT ON analysis_logical_operations
    WHEN NEW.current_attempt_id IS NOT NULL OR NEW.final_record_id IS NOT NULL OR NEW.winning_attempt_id IS NOT NULL
      OR NEW.completion_kind IS NOT NULL OR NEW.observation_seal IS NOT NULL OR NEW.execution_hash IS NOT NULL
      OR EXISTS (SELECT 1 FROM analysis_logical_operations WHERE owner_key = NEW.owner_key AND
        (operation_id = NEW.operation_id OR capture_id = NEW.capture_id OR analysis_id = NEW.analysis_id))
      OR EXISTS (SELECT 1 FROM analysis_run_journal WHERE owner_key = NEW.owner_key AND (capture_id = NEW.capture_id OR analysis_id = NEW.analysis_id))
      OR EXISTS (SELECT 1 FROM local_analysis_record WHERE owner_key = NEW.owner_key AND (capture_id = NEW.capture_id OR id = NEW.analysis_id))
    BEGIN SELECT RAISE(ABORT, 'An original analysis cannot replace history'); END`,
  `CREATE TRIGGER IF NOT EXISTS analysis_attempt_commit_product
    BEFORE UPDATE ON analysis_execution_attempts
    WHEN NEW.state = 'committed' AND OLD.state <> 'committed' AND NOT EXISTS (
      SELECT 1 FROM analysis_logical_operations p
      JOIN local_analysis_record r ON r.owner_key = p.owner_key AND r.id = p.analysis_id AND r.capture_id = p.capture_id
      JOIN local_shot s ON s.owner_key = r.owner_key AND s.id = r.id AND s.source = 'real' AND s.result_kind = 'scored'
      JOIN outbox o ON o.owner_key = r.owner_key AND o.kind = 'shot.sync'
        AND CASE WHEN json_valid(o.payload) THEN json_extract(o.payload, '$.id') = r.id
          AND json_extract(o.payload, '$.analysisPermitId') = NEW.permit_id ELSE 0 END
      WHERE p.owner_key = NEW.owner_key AND p.analysis_id = NEW.analysis_id AND p.current_attempt_id = NEW.operation_id
        AND p.final_record_id IS NULL)
    BEGIN SELECT RAISE(ABORT, 'An attempt commits with its actual product and outbox'); END`,
  `CREATE TRIGGER IF NOT EXISTS analysis_execution_attempts_admission
    BEFORE INSERT ON analysis_execution_attempts
    WHEN NEW.state <> 'reserve_pending' OR NEW.technical_failure IS NOT NULL
      OR EXISTS (SELECT 1 FROM analysis_run_journal WHERE owner_key = NEW.owner_key AND
        (operation_id = NEW.operation_id OR (api_origin = NEW.api_origin AND reservation_key = NEW.reservation_key)))
      OR EXISTS (SELECT 1 FROM local_analysis_record WHERE owner_key = NEW.owner_key AND capture_id = NEW.capture_id)
      OR EXISTS (SELECT 1 FROM local_shot WHERE owner_key = NEW.owner_key AND id = NEW.analysis_id)
      OR EXISTS (SELECT 1 FROM outbox WHERE owner_key = NEW.owner_key AND kind = 'shot.sync'
        AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') = NEW.analysis_id ELSE 1 END)
      OR EXISTS (SELECT 1 FROM sync_receipt WHERE owner_key = NEW.owner_key AND kind = 'shot.sync' AND entity_id = NEW.analysis_id)
      OR NOT EXISTS (
        SELECT 1 FROM analysis_logical_operations p WHERE p.owner_key = NEW.owner_key AND p.analysis_id = NEW.analysis_id
          AND p.final_record_id IS NULL AND p.current_attempt_id IS NEW.predecessor_operation_id
          AND ((NEW.attempt_ordinal = 1 AND p.current_attempt_id IS NULL) OR EXISTS (
            SELECT 1 FROM analysis_execution_attempts old WHERE old.owner_key = NEW.owner_key
              AND old.operation_id = NEW.predecessor_operation_id AND old.analysis_id = NEW.analysis_id
              AND old.attempt_ordinal + 1 = NEW.attempt_ordinal AND old.state = 'released'
              AND old.release_outcome = 'failed' AND old.technical_failure IS NOT NULL
              AND old.permit_id IS NOT NULL AND old.attempt_count > 0 AND old.last_http_status IS NULL
              AND old.terminal_reason IS NULL AND old.result_id IS NULL)))
    BEGIN SELECT RAISE(ABORT, 'Original analysis admission is not proven'); END`,
  `CREATE TRIGGER IF NOT EXISTS analysis_execution_attempts_monotonic
    BEFORE UPDATE ON analysis_execution_attempts
    WHEN NEW.owner_key IS NOT OLD.owner_key OR NEW.operation_id IS NOT OLD.operation_id
      OR NEW.owner_generation IS NOT OLD.owner_generation OR NEW.capture_id IS NOT OLD.capture_id
      OR NEW.analysis_id IS NOT OLD.analysis_id OR NEW.request_hash IS NOT OLD.request_hash
      OR NEW.api_origin IS NOT OLD.api_origin OR NEW.reservation_key IS NOT OLD.reservation_key
      OR NEW.attempt_ordinal IS NOT OLD.attempt_ordinal OR NEW.predecessor_operation_id IS NOT OLD.predecessor_operation_id
      OR NEW.created_at_ms IS NOT OLD.created_at_ms
      OR (OLD.technical_failure IS NOT NULL AND NEW.technical_failure IS NOT OLD.technical_failure)
      OR (OLD.technical_failure IS NULL AND NEW.technical_failure IS NOT NULL AND OLD.state NOT IN ('reserve_pending','reserved'))
      OR (OLD.permit_id IS NOT NULL AND NEW.permit_id IS NOT OLD.permit_id)
      OR (OLD.result_id IS NOT NULL AND NEW.result_id IS NOT OLD.result_id)
      OR (OLD.release_outcome IS NOT NULL AND NEW.release_outcome IS NOT OLD.release_outcome)
      OR (OLD.terminal_reason IS NOT NULL AND NEW.terminal_reason IS NOT OLD.terminal_reason)
      OR NEW.attempt_count < OLD.attempt_count
      OR NOT (NEW.state = OLD.state OR
        (OLD.state = 'reserve_pending' AND NEW.state IN ('reserved','release_pending')) OR
        (OLD.state = 'reserved' AND NEW.state IN ('committed','release_pending')) OR
        (OLD.state = 'release_pending' AND NEW.state IN ('released','terminal')))
    BEGIN SELECT RAISE(ABORT, 'Invalid analysis attempt transition'); END`,
  `CREATE TRIGGER IF NOT EXISTS analysis_logical_operations_immutable
    BEFORE UPDATE ON analysis_logical_operations
    WHEN NEW.owner_key IS NOT OLD.owner_key OR NEW.operation_id IS NOT OLD.operation_id
      OR NEW.capture_id IS NOT OLD.capture_id OR NEW.analysis_id IS NOT OLD.analysis_id OR NEW.api_origin IS NOT OLD.api_origin
      OR NEW.original_settings IS NOT OLD.original_settings OR NEW.settings_hash IS NOT OLD.settings_hash
      OR NEW.model_policy_hash IS NOT OLD.model_policy_hash OR NEW.created_at_ms IS NOT OLD.created_at_ms
      OR (OLD.observation_seal IS NOT NULL AND NEW.observation_seal IS NOT OLD.observation_seal)
      OR (OLD.execution_hash IS NOT NULL AND NEW.execution_hash IS NOT OLD.execution_hash)
      OR (OLD.final_record_id IS NOT NULL AND (NEW.final_record_id IS NOT OLD.final_record_id OR
        NEW.winning_attempt_id IS NOT OLD.winning_attempt_id OR NEW.completion_kind IS NOT OLD.completion_kind))
      OR (NEW.current_attempt_id IS NOT OLD.current_attempt_id AND NOT EXISTS (
        SELECT 1 FROM analysis_execution_attempts a WHERE a.owner_key = NEW.owner_key AND a.analysis_id = NEW.analysis_id
          AND a.operation_id = NEW.current_attempt_id AND a.predecessor_operation_id IS OLD.current_attempt_id AND a.state = 'reserve_pending'))
      OR (NEW.final_record_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM analysis_execution_attempts a JOIN local_analysis_record r ON r.owner_key = a.owner_key AND r.id = a.analysis_id
        WHERE a.owner_key = NEW.owner_key AND a.operation_id = NEW.winning_attempt_id AND a.analysis_id = NEW.final_record_id
          AND ((NEW.completion_kind = 'scored' AND a.state = 'committed' AND a.result_id = NEW.analysis_id) OR
            (NEW.completion_kind = 'partial' AND a.state = 'terminal' AND a.terminal_reason = 'reservation_rejected'
              AND a.permit_id IS NULL AND a.result_id IS NULL AND a.technical_failure IS NULL) OR
            (NEW.completion_kind NOT IN ('scored','partial') AND a.state = 'release_pending' AND a.release_outcome = 'low_confidence'))))
    BEGIN SELECT RAISE(ABORT, 'Original analysis is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS analysis_reservation_refusal_follows_attempt
    AFTER DELETE ON analysis_execution_attempts
    BEGIN
      DELETE FROM analysis_reservation_refusal
        WHERE owner_key = OLD.owner_key AND operation_id = OLD.operation_id;
    END`,
];
