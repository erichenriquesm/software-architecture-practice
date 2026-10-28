#!/bin/sh
# Builds users.acl (one user per service, limited to its key prefix and to the rate limiter commands)
# from the passwords of backend/infra/.env, then starts Redis.
set -eu

commands='-@all +eval +evalsha +hello +auth +client|setinfo +client|setname +info +get +set +del +incrby +expire +pexpire +ttl +pttl'

mkdir -p /tmp/redis
{
  echo "user default off"
  echo "user account on >$ACCOUNT_REDIS_PASSWORD ~account:* resetchannels $commands"
  echo "user wallet on >$WALLET_REDIS_PASSWORD ~wallet:* resetchannels $commands"
  echo "user order on >$ORDER_REDIS_PASSWORD ~order:* resetchannels $commands"
  echo "user marketData on >$MARKET_DATA_REDIS_PASSWORD ~marketData:* resetchannels $commands"
} > /tmp/redis/users.acl

exec redis-server --aclfile /tmp/redis/users.acl --save "" --appendonly no
