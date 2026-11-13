CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(30) NOT NULL UNIQUE,
  email VARCHAR(320) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  profile_photo_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connection_requests (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_id <> receiver_id)
);

CREATE TABLE IF NOT EXISTS connections (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dark_mode BOOLEAN NOT NULL DEFAULT FALSE,
  live_location BOOLEAN NOT NULL DEFAULT FALSE,
  friend_activity BOOLEAN NOT NULL DEFAULT TRUE,
  digest BOOLEAN NOT NULL DEFAULT FALSE,
  discoverable BOOLEAN NOT NULL DEFAULT TRUE,
  saved_places JSONB NOT NULL DEFAULT '[]'::jsonb,
  saved_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_username_search ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS users_email_search ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS requests_receiver_status ON connection_requests (receiver_id, status);
ALTER TABLE connection_requests DROP CONSTRAINT IF EXISTS connection_requests_sender_id_receiver_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request_per_pair ON connection_requests(sender_id, receiver_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  request_id BIGINT REFERENCES connection_requests(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(160) NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS places (
  id VARCHAR(180) PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  address TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS place_ratings (
  id BIGSERIAL PRIMARY KEY,
  place_id VARCHAR(180) NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(place_id, user_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id VARCHAR(180) REFERENCES places(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS circles (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS circle_members (
  circle_id BIGINT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(circle_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  circle_id BIGINT REFERENCES circles(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS direct_messages_pair_created ON direct_messages(sender_id, receiver_id, created_at);

-- Per-conversation read markers, so an unread badge survives a reload instead of
-- living only in browser memory. kind='dm' => peer_id is the friend's user id;
-- kind='circle' => peer_id is the circle id.
CREATE TABLE IF NOT EXISTS conversation_reads (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('dm','circle')),
  peer_id BIGINT NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind, peer_id)
);

CREATE TABLE IF NOT EXISTS group_calls (
  id BIGSERIAL PRIMARY KEY,
  circle_id BIGINT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  started_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(40) NOT NULL DEFAULT 'webrtc',
  room_code VARCHAR(100) NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS call_sessions (
  id BIGSERIAL PRIMARY KEY,
  caller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_type VARCHAR(10) NOT NULL CHECK (call_type IN ('audio','video')),
  status VARCHAR(12) NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','active','declined','ended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  CHECK (caller_id <> callee_id)
);

CREATE INDEX IF NOT EXISTS call_sessions_callee_status ON call_sessions(callee_id, status);

CREATE TABLE IF NOT EXISTS invites (
  code VARCHAR(40) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS content_reactions (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('place', 'news')),
  item_id VARCHAR(180) NOT NULL,
  reaction VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, item_type, item_id)
);

-- Live location sharing. One row per user; presence of a row means the user
-- has published coordinates at least once. Whether a friend may READ them is
-- gated by user_settings.live_location at query time, not by this table.
CREATE TABLE IF NOT EXISTS user_locations (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  accuracy NUMERIC(10,2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS request_id BIGINT REFERENCES connection_requests(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_created ON posts(created_at DESC);

-- Call history as a persistent conversation entry. kind distinguishes a normal
-- text message from a system row; call_id ties a row to its call_sessions row and
-- the unique index below makes a retried event a no-op instead of a duplicate.
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'text';
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS meta JSONB;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS call_id BIGINT REFERENCES call_sessions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS direct_messages_one_row_per_call ON direct_messages(call_id) WHERE call_id IS NOT NULL;
-- When the callee answered, so a real connected duration can be computed.
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ;
-- ============================================================
-- DISTRICT-AWARE DISCOVERY, GENUINE CIRCLE REVIEWS, REAL EVENTS
-- Additive and idempotent. No table is dropped, no row is deleted,
-- no existing column changes type. Safe to re-apply on every boot.
-- ============================================================

-- A user's chosen district. Nullable: a user who has not chosen one simply
-- sees an "all districts" view rather than being forced into Delhi.
ALTER TABLE users ADD COLUMN IF NOT EXISTS district VARCHAR(80);

-- Places gain a district and a category so discovery can filter on real
-- attributes instead of a hardcoded frontend slug.
ALTER TABLE places ADD COLUMN IF NOT EXISTS district VARCHAR(80);
ALTER TABLE places ADD COLUMN IF NOT EXISTS category VARCHAR(60);

-- Genuine reviews already live in place_ratings(rating, review, user_id).
-- These indexes make the circle and per-place review queries cheap.
CREATE INDEX IF NOT EXISTS place_ratings_user_created ON place_ratings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS place_ratings_place_created ON place_ratings(place_id, created_at DESC);
CREATE INDEX IF NOT EXISTS places_district ON places(district);

-- Real events, owned by the member who posted them. There is no verified
-- public per-district events API, so every row here has a genuine author and
-- a real date; nothing is synthesised and no date is ever shifted forward.
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category VARCHAR(60) NOT NULL DEFAULT 'Community',
  district VARCHAR(80),
  venue VARCHAR(200),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  source VARCHAR(40) NOT NULL DEFAULT 'member',
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Prevents the same event being posted twice for the same district and time.
CREATE UNIQUE INDEX IF NOT EXISTS events_no_duplicates
  ON events (lower(title), COALESCE(district,''), starts_at);
CREATE INDEX IF NOT EXISTS events_district_start ON events(district, starts_at);
CREATE INDEX IF NOT EXISTS events_start ON events(starts_at);

-- Who is actually interested. This is what makes "2 people in your circle are
-- going" a real count instead of a hardcoded sentence.
CREATE TABLE IF NOT EXISTS event_interest (
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(12) NOT NULL DEFAULT 'interested' CHECK (status IN ('interested','going')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS event_interest_user ON event_interest(user_id);

-- Swipe dismissals persist in content_reactions, which previously allowed only
-- 'place' and 'news'. Widen it to cover events so a dismissed event card does
-- not come back on the next page load.
DO $$
BEGIN
  ALTER TABLE content_reactions DROP CONSTRAINT IF EXISTS content_reactions_item_type_check;
  ALTER TABLE content_reactions
    ADD CONSTRAINT content_reactions_item_type_check
    CHECK (item_type IN ('place', 'news', 'event'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS content_reactions_user_type ON content_reactions(user_id, item_type);
