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
