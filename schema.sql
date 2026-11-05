-- Our Little Cinema — application schema
-- Uses only the supported migration subset: CREATE TABLE app.<table>,
-- plain CREATE INDEX, allowed column types and literal/now()/gen_random_uuid()
-- defaults. No seed data, no GRANT/RLS statements (function_backend owns access).

CREATE TABLE app.cine_rooms (
  code text PRIMARY KEY,
  secret text NOT NULL,
  host_peer text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.cine_peers (
  room text NOT NULL,
  peer text NOT NULL,
  name text NOT NULL,
  color text NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT now(),
  typing bigint NOT NULL DEFAULT 0,
  last_read bigint NOT NULL DEFAULT 0,
  call_state text NOT NULL DEFAULT 'idle',
  PRIMARY KEY (room, peer)
);
CREATE INDEX cine_peers_room_idx ON app.cine_peers (room);

CREATE TABLE app.cine_messages (
  id text PRIMARY KEY,
  room text NOT NULL,
  peer text NOT NULL,
  name text NOT NULL,
  color text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL,
  media text,
  reactions jsonb,
  reply_to text,
  created bigint NOT NULL
);
CREATE INDEX cine_messages_room_created_idx ON app.cine_messages (room, created);

CREATE TABLE app.cine_player (
  room text PRIMARY KEY,
  video text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  playing integer NOT NULL DEFAULT 0,
  rate integer NOT NULL DEFAULT 1000,
  queue jsonb,
  updated_by text NOT NULL DEFAULT '',
  updated bigint NOT NULL DEFAULT 0
);

CREATE TABLE app.cine_signals (
  id text PRIMARY KEY,
  room text NOT NULL,
  from_peer text NOT NULL,
  to_peer text NOT NULL,
  kind text NOT NULL,
  payload text NOT NULL,
  created bigint NOT NULL
);
CREATE INDEX cine_signals_room_created_idx ON app.cine_signals (room, created);

CREATE TABLE app.cine_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room text NOT NULL,
  peer text NOT NULL,
  object_path text NOT NULL UNIQUE,
  mime text NOT NULL,
  bytes integer NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cine_media_room_status_idx ON app.cine_media (room, status);
