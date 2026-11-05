-- companion-runtime schema v1 (current version: v3, see the v3 block at the end)
-- Authority: cognitive continuity state only. Long-term facts, preferences,
-- relationship notes and revisions stay in companion-memory; this database keeps
-- retractable working projections plus memory references.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT ''
);

-- One projection row per scope. `version` is the optimistic-concurrency anchor
-- shared by every consumer of that scope; `generation` is the run generation that
-- produced it, so a previous writer cannot commit after a reload.
CREATE TABLE IF NOT EXISTS scope_snapshots (
  scope      TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  generation TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- `seq` is the log order (assigned inside the append transaction). `occurred_at`
-- orders the state timeline; the two differ when a late event arrives, which is why
-- replay must follow `seq` and the affect reducer must follow `occurred_at`.
CREATE TABLE IF NOT EXISTS domain_events (
  seq            INTEGER NOT NULL,
  event_id       TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  scope          TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  persona_id     TEXT NOT NULL,
  world_id       TEXT NOT NULL,
  session_id     TEXT NOT NULL DEFAULT '',
  occurred_at    INTEGER NOT NULL,
  recorded_at    INTEGER NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  causation_id   TEXT NOT NULL DEFAULT '',
  root_evidence  TEXT NOT NULL DEFAULT '[]',
  reality_status TEXT NOT NULL DEFAULT 'hypothetical',
  evidence_status TEXT NOT NULL DEFAULT 'observed',
  config_version TEXT NOT NULL DEFAULT '',
  model_version  TEXT NOT NULL DEFAULT '',
  payload        TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS domain_events_seq ON domain_events (seq);
CREATE INDEX IF NOT EXISTS domain_events_scope_time ON domain_events (scope, occurred_at, recorded_at);
CREATE INDEX IF NOT EXISTS domain_events_kind ON domain_events (kind, occurred_at);

-- Execution dedupe is per (consumer, event) and deliberately independent from
-- root-evidence dedupe: two consumers may legitimately apply the same evidence.
CREATE TABLE IF NOT EXISTS consumer_receipts (
  consumer      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  scope         TEXT NOT NULL,
  applied_at    INTEGER NOT NULL,
  state_version INTEGER NOT NULL,
  result        TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX IF NOT EXISTS consumer_receipts_scope ON consumer_receipts (scope, consumer);

CREATE TABLE IF NOT EXISTS goals (
  goal_id        TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  title          TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'conversation',
  authorization  TEXT NOT NULL DEFAULT 'none',
  status         TEXT NOT NULL,
  overdue        INTEGER NOT NULL DEFAULT 0,
  deadline_at    INTEGER,
  revision       INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  completed_steps TEXT NOT NULL DEFAULT '[]',
  next_step      TEXT NOT NULL DEFAULT '',
  waiting_on     TEXT NOT NULL DEFAULT '',
  checkpoint     TEXT NOT NULL DEFAULT '{}',
  superseded_by  TEXT NOT NULL DEFAULT '',
  history        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS goals_scope_status ON goals (scope, status, updated_at);

CREATE TABLE IF NOT EXISTS commitments (
  commitment_id TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  goal_id       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  due_at        INTEGER,
  revision      INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  closed_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS commitments_scope ON commitments (scope, status, updated_at);

-- Working memory is a bounded view for one scope: one focus plus the active
-- commitments snapshot that must survive context trimming.
CREATE TABLE IF NOT EXISTS working_memory (
  scope          TEXT PRIMARY KEY,
  focus_goal_id  TEXT NOT NULL DEFAULT '',
  focus_kind     TEXT NOT NULL DEFAULT '',
  pending_goal   TEXT NOT NULL DEFAULT '',
  revision       INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  view           TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS wm_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  goal_id       TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS wm_checkpoints_scope ON wm_checkpoints (scope, created_at);

CREATE TABLE IF NOT EXISTS beliefs (
  belief_id      TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  proposition    TEXT NOT NULL,
  status         TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0,
  roots          TEXT NOT NULL DEFAULT '[]',
  independence   INTEGER NOT NULL DEFAULT 0,
  valid_until    INTEGER,
  revision       INTEGER NOT NULL DEFAULT 1,
  superseded_by  TEXT NOT NULL DEFAULT '',
  reason         TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS beliefs_scope_status ON beliefs (scope, status, updated_at);

CREATE TABLE IF NOT EXISTS belief_evidence (
  belief_id   TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  root_id     TEXT NOT NULL DEFAULT '',
  relation    TEXT NOT NULL,
  event_id    TEXT NOT NULL DEFAULT '',
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (belief_id, evidence_id, relation)
);

-- Derived conclusions that depend on one or more beliefs. Correcting a belief
-- invalidates its dependents instead of silently keeping a stale projection.
CREATE TABLE IF NOT EXISTS belief_dependents (
  dependent_id TEXT NOT NULL,
  belief_id    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'inference',
  status       TEXT NOT NULL DEFAULT 'current',
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (dependent_id, belief_id)
);
CREATE INDEX IF NOT EXISTS belief_dependents_belief ON belief_dependents (belief_id, status);

-- Short-term affect variables: bounded, baseline-reverting, recomputed from the
-- event timeline. `values` keeps snapshot plus the last evaluated instant.
CREATE TABLE IF NOT EXISTS role_state (
  scope        TEXT PRIMARY KEY,
  state_version INTEGER NOT NULL DEFAULT 0,
  slots        TEXT NOT NULL DEFAULT '{}',
  evaluated_at INTEGER NOT NULL,
  config_version TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS shadow_proposals (
  proposal_id       TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,
  kind              TEXT NOT NULL,
  payload           TEXT NOT NULL DEFAULT '{}',
  expected_revision INTEGER,
  observed_revision INTEGER,
  decision          TEXT NOT NULL,
  detail            TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shadow_proposals_scope ON shadow_proposals (scope, created_at);

-- Single-writer proof: one lease row, monotonic generation, heartbeat expiry.
CREATE TABLE IF NOT EXISTS runtime_lease (
  lease_id     TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  generation   TEXT NOT NULL,
  acquired_at  INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_meta (
  meta_key   TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Outbound bridge queue to companion-memory. Only the runtime writes here; the
-- memory service owns the target records and returns a persistent receipt.
CREATE TABLE IF NOT EXISTS memory_outbox (
  outbox_id    TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  namespace    TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued',
  receipt_id   TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT '',
  claimed_until INTEGER NOT NULL DEFAULT 0,
  claim_owner  TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_outbox_status ON memory_outbox (status, created_at);

-- ---------------------------------------------------------------------------
-- schema v3: H1 sustainable agenda + H2 zero-model rule heartbeat (C5 contract
-- section 12). Additive only: no existing table is altered and no existing row is
-- rewritten, so an older database upgrades in place and the new tables stay empty
-- until the independent `agenda.enabled` / `heartbeat.enabled` switches are on.
-- ---------------------------------------------------------------------------

-- One agenda definition. `request_key` is the host-derived idempotency key: the same
-- request retried later (even in another session) resolves to the same item instead
-- of creating a duplicate definition.
CREATE TABLE IF NOT EXISTS agenda_items (
  item_id        TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 1,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'plan',
  source         TEXT NOT NULL DEFAULT 'tool',
  rule_kind      TEXT NOT NULL,
  time_zone      TEXT NOT NULL,
  local_date     TEXT NOT NULL DEFAULT '',
  local_time     TEXT NOT NULL DEFAULT '',
  weekdays       TEXT NOT NULL DEFAULT '[]',
  at_utc         INTEGER,
  valid_from     INTEGER NOT NULL DEFAULT 0,
  valid_until    INTEGER,
  status         TEXT NOT NULL DEFAULT 'active',
  authorization  TEXT NOT NULL DEFAULT 'plan',
  delivery       TEXT NOT NULL DEFAULT 'none',
  goal_ref       TEXT NOT NULL DEFAULT '',
  commitment_ref TEXT NOT NULL DEFAULT '',
  request_key    TEXT NOT NULL DEFAULT '',
  resolution     TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agenda_items_request ON agenda_items (scope, request_key) WHERE request_key <> '';
CREATE INDEX IF NOT EXISTS agenda_items_scope ON agenda_items (scope, status, updated_at);

-- Occurrence instances. The unique key is (scope, item, slot) and deliberately does
-- NOT include the definition revision: a revision bump may reschedule an unexecuted
-- future slot in place, but it can never create a second row for the same slot.
CREATE TABLE IF NOT EXISTS agenda_occurrences (
  occurrence_id       TEXT PRIMARY KEY,
  scope               TEXT NOT NULL,
  item_id             TEXT NOT NULL,
  slot_key            TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  scheduled_at        INTEGER NOT NULL,
  slot_end_at         INTEGER,
  status              TEXT NOT NULL DEFAULT 'scheduled',
  reason_code         TEXT NOT NULL DEFAULT '',
  revision            INTEGER NOT NULL DEFAULT 1,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT NOT NULL DEFAULT '',
  causation_event_id  TEXT NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agenda_occurrences_slot ON agenda_occurrences (scope, item_id, slot_key);
CREATE INDEX IF NOT EXISTS agenda_occurrences_due ON agenda_occurrences (status, scheduled_at, scope, occurrence_id);

-- Business heartbeat bookkeeping per (scope, consumer). Three distinct watermarks:
-- `settled_until` (settled timeline), `page_anchor` (due pagination + quarantine) and
-- `event_seq` (last applied event). They must not be collapsed into one `lastTick`.
CREATE TABLE IF NOT EXISTS heartbeat_cursor (
  scope         TEXT NOT NULL,
  consumer      TEXT NOT NULL,
  settled_until INTEGER NOT NULL DEFAULT 0,
  page_anchor   TEXT NOT NULL DEFAULT '{}',
  event_seq     INTEGER NOT NULL DEFAULT 0,
  cycles        INTEGER NOT NULL DEFAULT 0,
  paused_at     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (scope, consumer)
);
CREATE INDEX IF NOT EXISTS heartbeat_cursor_fair ON heartbeat_cursor (consumer, updated_at);

-- ---------------------------------------------------------------------------
-- schema v4: P2 autonomous day + real activities (contract logs/p2-autonomous-day/contract-p2.md).
-- Additive only: no existing table is altered and no existing row is rewritten. The
-- event-derived tables are part of replay comparison; the two operational tables
-- (p2_plan_runs / p2_budget_ledger) are deliberately excluded because model tokens and
-- budget reservations are not replay content.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS p2_plans (
  plan_id       TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  day           TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'committed',
  time_zone     TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  window_end    INTEGER NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  source_run_id TEXT NOT NULL DEFAULT '',
  supersedes    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  committed_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS p2_plans_scope_day_version ON p2_plans (scope, day, version);
CREATE INDEX IF NOT EXISTS p2_plans_scope_day ON p2_plans (scope, day, status);

CREATE TABLE IF NOT EXISTS p2_plan_slots (
  slot_id             TEXT PRIMARY KEY,
  plan_id             TEXT NOT NULL,
  scope               TEXT NOT NULL,
  day                 TEXT NOT NULL,
  start_at            INTEGER NOT NULL,
  end_at              INTEGER NOT NULL,
  kind                TEXT NOT NULL,
  activity            TEXT NOT NULL DEFAULT '',
  title               TEXT NOT NULL DEFAULT '',
  detail              TEXT NOT NULL DEFAULT '',
  flexibility         TEXT NOT NULL DEFAULT 'soft',
  locked              INTEGER NOT NULL DEFAULT 0,
  -- Fail-closed: a planned slot is hypothetical until the planner labels it explicitly.
  reality             TEXT NOT NULL DEFAULT 'hypothetical',
  intent              TEXT NOT NULL DEFAULT '',
  target_ref          TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'planned',
  agenda_item_id      TEXT NOT NULL DEFAULT '',
  agenda_occurrence_id TEXT NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS p2_plan_slots_plan ON p2_plan_slots (plan_id, start_at);
CREATE INDEX IF NOT EXISTS p2_plan_slots_scope_day ON p2_plan_slots (scope, day, status);

CREATE TABLE IF NOT EXISTS p2_opportunities (
  opportunity_id TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT '',
  dedupe_key     TEXT NOT NULL DEFAULT '',
  weight         REAL NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'open',
  payload        TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS p2_opportunities_dedupe ON p2_opportunities (scope, dedupe_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS p2_opportunities_scope ON p2_opportunities (scope, status, created_at);

CREATE TABLE IF NOT EXISTS p2_interests (
  interest_id  TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'interest',
  title        TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  revision     INTEGER NOT NULL DEFAULT 1,
  strength     REAL NOT NULL DEFAULT 0.5,
  origin       TEXT NOT NULL DEFAULT '',
  ref          TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_touched INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS p2_interests_scope ON p2_interests (scope, status, last_touched);

CREATE TABLE IF NOT EXISTS p2_activities (
  activity_id      TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  plan_slot_id     TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL,
  adapter          TEXT NOT NULL DEFAULT '',
  capability       TEXT NOT NULL DEFAULT '',
  -- Fail-closed: an activity is hypothetical until something explicitly says otherwise.
  reality          TEXT NOT NULL DEFAULT 'hypothetical',
  status           TEXT NOT NULL DEFAULT 'pending',
  target           TEXT NOT NULL DEFAULT '',
  source_ref       TEXT NOT NULL DEFAULT '',
  source_hash      TEXT NOT NULL DEFAULT '',
  total_units      INTEGER NOT NULL DEFAULT 0,
  consumed_prefix  INTEGER NOT NULL DEFAULT 0,
  checkpoint       TEXT NOT NULL DEFAULT '{}',
  artifact_ref     TEXT NOT NULL DEFAULT '',
  artifact_version INTEGER NOT NULL DEFAULT 0,
  artifact_hash    TEXT NOT NULL DEFAULT '',
  started_at       INTEGER NOT NULL DEFAULT 0,
  paused_at        INTEGER NOT NULL DEFAULT 0,
  ended_at         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS p2_activities_scope ON p2_activities (scope, status, updated_at);

CREATE TABLE IF NOT EXISTS p2_activity_receipts (
  receipt_id    TEXT PRIMARY KEY,
  activity_id   TEXT NOT NULL,
  scope         TEXT NOT NULL,
  operation     TEXT NOT NULL,
  ok            INTEGER NOT NULL DEFAULT 0,
  code          TEXT NOT NULL DEFAULT '',
  detail        TEXT NOT NULL DEFAULT '',
  source_hash   TEXT NOT NULL DEFAULT '',
  consumed_from INTEGER NOT NULL DEFAULT 0,
  consumed_to   INTEGER NOT NULL DEFAULT 0,
  artifact_ref  TEXT NOT NULL DEFAULT '',
  at            INTEGER NOT NULL,
  generation    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS p2_receipts_activity ON p2_activity_receipts (activity_id, at);

-- Share candidates: P2 only produces candidates; contact stays the only sender and the
-- only owner of its ledger. Production sharing defaults to off.
CREATE TABLE IF NOT EXISTS p2_share_candidates (
  candidate_id    TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  activity_id     TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'activity',
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  source_ref      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      INTEGER NOT NULL,
  decision_at     INTEGER NOT NULL DEFAULT 0,
  decision_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS p2_share_scope ON p2_share_candidates (scope, status, created_at);

-- Operational (not event-derived, excluded from replay comparison).
CREATE TABLE IF NOT EXISTS p2_plan_runs (
  run_id         TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  day            TEXT NOT NULL,
  kind           TEXT NOT NULL,
  trigger        TEXT NOT NULL DEFAULT '',
  opportunity_id TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending',
  model_purpose  TEXT NOT NULL DEFAULT 'p2-planning',
  provider       TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  input_chars    INTEGER NOT NULL DEFAULT 0,
  output_chars   INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error_code     TEXT NOT NULL DEFAULT '',
  error_detail   TEXT NOT NULL DEFAULT '',
  snapshot_digest TEXT NOT NULL DEFAULT '',
  plan_id        TEXT NOT NULL DEFAULT '',
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS p2_plan_runs_scope_day ON p2_plan_runs (scope, day, started_at);

CREATE TABLE IF NOT EXISTS p2_budget_ledger (
  entry_id   TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  day        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  amount     INTEGER NOT NULL DEFAULT 0,
  purpose    TEXT NOT NULL DEFAULT '',
  ref        TEXT NOT NULL DEFAULT '',
  at         INTEGER NOT NULL,
  reserved   INTEGER NOT NULL DEFAULT 0,
  settled    INTEGER NOT NULL DEFAULT 0,
  -- 1 once the request actually left the process; such a reservation can never be released.
  issued     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS p2_budget_scope_day ON p2_budget_ledger (scope, day, kind);