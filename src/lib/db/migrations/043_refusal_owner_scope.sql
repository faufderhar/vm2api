-- 043_refusal_owner_scope — refusal fingerprints and device bans are per owner.
-- Historical rows stay on the platform owner (''). A client-supplied device id
-- banned for one tenant does not ban anyone else. nearest() scans one owner's
-- newest rows, and remember() drops expired rows plus the oldest past the cap.

CREATE TABLE refusal_guards_owner (
  owner_user_id TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  source_request_id TEXT,
  error_message TEXT,
  preview TEXT,
  expires_at TEXT,
  signature TEXT,
  PRIMARY KEY (owner_user_id, fingerprint)
);

INSERT INTO refusal_guards_owner (
  owner_user_id, fingerprint, model, first_seen_at, last_seen_at, hit_count,
  source_request_id, error_message, preview, expires_at, signature
)
SELECT
  '', fingerprint, model, first_seen_at, last_seen_at, hit_count,
  source_request_id, error_message, preview, expires_at, signature
FROM refusal_guards;

DROP TABLE refusal_guards;
ALTER TABLE refusal_guards_owner RENAME TO refusal_guards;

CREATE INDEX idx_refusal_guards_model ON refusal_guards(model);
CREATE INDEX idx_refusal_guards_last_seen ON refusal_guards(owner_user_id, last_seen_at);

CREATE TABLE refusal_device_blocks_owner (
  owner_user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  source_request_id TEXT,
  fingerprint TEXT,
  reason TEXT,
  PRIMARY KEY (owner_user_id, device_id)
);

INSERT INTO refusal_device_blocks_owner (
  owner_user_id, device_id, first_seen_at, last_seen_at, hit_count,
  source_request_id, fingerprint, reason
)
SELECT
  '', device_id, first_seen_at, last_seen_at, hit_count,
  source_request_id, fingerprint, reason
FROM refusal_device_blocks;

DROP TABLE refusal_device_blocks;
ALTER TABLE refusal_device_blocks_owner RENAME TO refusal_device_blocks;

CREATE INDEX idx_refusal_device_last_seen ON refusal_device_blocks(owner_user_id, last_seen_at);
