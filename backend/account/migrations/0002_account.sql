create table account (
  account_id     uuid primary key,
  name           text not null,
  email          text not null,
  document       text not null,
  password_hash  text not null,
  created_at     timestamptz not null default now()
);
create unique index account_email_uq on account (lower(email));

create table account_balance_view (
  account_id  uuid not null,
  asset_id    text not null,
  available   numeric(36,8) not null,
  reserved    numeric(36,8) not null,
  version     bigint not null,
  updated_at  timestamptz not null,
  primary key (account_id, asset_id)
);
