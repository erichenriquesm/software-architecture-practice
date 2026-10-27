create table outbox (
  id            bigserial primary key,
  event_id      uuid not null unique,
  type          text not null,
  routing_key   text not null,
  envelope      jsonb not null,
  created_at    timestamptz not null default now(),
  published_at  timestamptz
);
create index outbox_unpublished on outbox (id) where published_at is null;

create table inbox (
  consumer      text not null,
  message_key   text not null,
  processed_at  timestamptz not null default now(),
  primary key (consumer, message_key)
);

create table idempotency_key (
  scope          text not null,
  key            text not null,
  request_hash   text not null,
  state          text not null,
  status_code    integer,
  response_body  jsonb,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  primary key (scope, key)
);
create index idempotency_key_expired on idempotency_key (expires_at);
