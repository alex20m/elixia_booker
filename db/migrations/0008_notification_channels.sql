-- ---------------------------------------------------------------------------
-- profiles: choose where alerts go; telegram_link_tokens: connect a chat safely
-- ---------------------------------------------------------------------------
--
-- Two changes, both additive, because this migration runs during the Vercel
-- build while the *previous* deployment is still serving requests. Every
-- statement here has to leave that older code working:
--
--   * `notify_channel` and `notify_email` are new columns with a default and a
--     null, so the old INSERT — which names neither — still succeeds, and the
--     old SELECT, which lists its columns explicitly, does not see them.
--   * `telegram_link_tokens` is a new table nothing older reads or writes.
--
-- `notify_channel` defaults to 'email' rather than to the Telegram setup that
-- came before it: email needs nothing from the user, since the address arrives
-- with the Neon Auth session, so the default channel is the one that reaches
-- somebody. Existing users keep their chat id, and switching back to Telegram
-- is one click. Postgres applies a default to existing rows without rewriting
-- the table, so this stays cheap regardless of how many profiles exist.

alter table public.profiles
  add column if not exists notify_channel text not null default 'email'
    check (notify_channel in ('email', 'telegram', 'none')),
  add column if not exists notify_email text;

-- One row per pending "connect my Telegram" attempt.
--
-- The token is stored as a sha256 hash, never in the clear: for the few
-- minutes it lives it is a bearer credential that binds a chat to this
-- account, so a database dump must not contain anything replayable into the
-- webhook. The row is deleted the moment it is claimed, which is what makes a
-- token single-use.
--
-- `on delete cascade` both frees the tokens of a deleted account and keeps the
-- table reachable from `truncate public.profiles cascade`, which is how the
-- repo tests reset between cases.
create table if not exists public.telegram_link_tokens (
  token_hash text primary key,
  user_id text not null references public.profiles(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Supports both "replace this user's pending link" and the cascade above.
create index if not exists telegram_link_tokens_user_id_idx
  on public.telegram_link_tokens (user_id);

-- Expired rows are swept whenever a new link is created, so this index keeps
-- that sweep from scanning the table.
create index if not exists telegram_link_tokens_expires_at_idx
  on public.telegram_link_tokens (expires_at);
