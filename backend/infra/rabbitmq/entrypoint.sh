#!/bin/sh
# Builds definitions.json (vhost, users, permissions, exchanges) from the template with the passwords of
# backend/infra/.env, then starts the broker. RabbitMQ only accepts hashed passwords in definitions.
set -eu

hash() { rabbitmqctl -q hash_password "$1"; }

mkdir -p /tmp/rabbitmq
sed \
  -e "s|__ADMIN_HASH__|$(hash "$RABBITMQ_ADMIN_PASSWORD")|" \
  -e "s|__ACCOUNT_HASH__|$(hash "$ACCOUNT_RABBITMQ_PASSWORD")|" \
  -e "s|__WALLET_HASH__|$(hash "$WALLET_RABBITMQ_PASSWORD")|" \
  -e "s|__ORDER_HASH__|$(hash "$ORDER_RABBITMQ_PASSWORD")|" \
  -e "s|__MATCHING_HASH__|$(hash "$MATCHING_RABBITMQ_PASSWORD")|" \
  -e "s|__MARKETDATA_HASH__|$(hash "$MARKET_DATA_RABBITMQ_PASSWORD")|" \
  /etc/rabbitmq/definitions.template.json > /tmp/rabbitmq/definitions.json
chmod 0644 /tmp/rabbitmq/definitions.json

exec docker-entrypoint.sh rabbitmq-server
