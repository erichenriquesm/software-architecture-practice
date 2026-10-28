#!/bin/sh
# Runs once, on the first boot of account-db: creates the migrator (owns the schema) and app (data only) users.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v db="$DATABASE_NAME" -v schema="$DATABASE_NAME" \
  -v migrator="$DATABASE_MIGRATOR_USER" -v app="$DATABASE_USER" \
  -v migrator_password="$DATABASE_MIGRATOR_PASSWORD" -v app_password="$DATABASE_PASSWORD" <<'SQL'
create role :"migrator" login password :'migrator_password';
create role :"app" login password :'app_password';
create database :"db" owner :"migrator";
revoke all on database :"db" from public;
grant connect on database :"db" to :"app";
\connect :"db"
revoke create on schema public from public;
create schema :"schema" authorization :"migrator";
grant usage on schema :"schema" to :"app";
alter role :"migrator" in database :"db" set search_path = :"schema";
alter role :"app" in database :"db" set search_path = :"schema";
alter default privileges for role :"migrator" in schema :"schema"
  grant select, insert, update, delete on tables to :"app";
alter default privileges for role :"migrator" in schema :"schema"
  grant usage, select on sequences to :"app";
SQL
