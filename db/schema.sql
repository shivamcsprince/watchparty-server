-- Database schema for the Watch Party app.
-- Safe to run repeatedly (every statement is idempotent).
-- Tables are added phase by phase: users (Phase 2), rooms/participants/messages (Phase 3+).

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL,
  username      TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: "Bob@x.com" and "bob@x.com" are the same person.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique    ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (lower(username));

-- ---------------------------------------------------------------------------
-- rooms
-- Connected participants live in server memory (they reset to "participant"
-- when they come back), so only the durable room data is stored here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT        NOT NULL,
  host_user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rooms_code_unique ON rooms (code);
