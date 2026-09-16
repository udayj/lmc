CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE TABLE estimator_sessions (
  token_hash TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_estimator_sessions_expiry ON estimator_sessions(expires_at);
CREATE TABLE otp_challenges (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  verification_sid TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_otp_challenges_expiry ON otp_challenges(expires_at);
CREATE TABLE otp_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_otp_limits_expiry ON otp_limits(expires_at);
