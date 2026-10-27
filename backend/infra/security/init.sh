#!/bin/sh
set -eu
umask 077

SECRETS_DIR="${SECRETS_DIR:-/secrets}"
IDS="account wallet order matching market-data"

camel_of() {
  case "$1" in
    market-data) echo marketData ;;
    *) echo "$1" ;;
  esac
}

perm_of() {
  case "$1:$2" in
    account:c) echo '^(account\.events|account\..*)$' ;;
    account:w) echo '^(account\.events|account\..*|retry)$' ;;
    account:r) echo '^(account\..*|wallet\.events|retry)$' ;;
    wallet:c) echo '^(wallet\.events|wallet\..*)$' ;;
    wallet:w) echo '^(wallet\.events|wallet\..*|retry)$' ;;
    wallet:r) echo '^(wallet\..*|account\.events|order\.events|matching\.events|retry)$' ;;
    order:c) echo '^(order\.events|order\..*)$' ;;
    order:w) echo '^(order\.events|order\..*|retry)$' ;;
    order:r) echo '^(order\..*|wallet\.events|matching\.events|retry)$' ;;
    matching:c) echo '^(matching\.events|matching\..*)$' ;;
    matching:w) echo '^(matching\.events|matching\..*|retry)$' ;;
    matching:r) echo '^(matching\..*|order\.events|retry)$' ;;
    marketData:c) echo '^marketData\..*$' ;;
    marketData:w) echo '^(marketData\..*|retry)$' ;;
    marketData:r) echo '^(marketData\..*|matching\.events|retry)$' ;;
    admin:*) echo '.*' ;;
  esac
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g'
}

rabbit_hash() {
  salt_file="$WORK/salt"
  openssl rand 4 > "$salt_file"
  printf '%s' "$1" > "$WORK/pw"
  cat "$salt_file" "$WORK/pw" | openssl dgst -sha256 -binary > "$WORK/digest"
  cat "$salt_file" "$WORK/digest" | base64 -w0
  rm -f "$WORK/pw"
}

put() {
  # put <file> <content>
  printf '%s' "$2" > "$1"
}

if [ "$#" -gt 1 ]; then
  echo "security-init: unknown arguments" >&2
  exit 2
fi
ROTATE=0
if [ "$#" -eq 1 ]; then
  case "$1" in
    --rotate) ROTATE=1 ;;
    *) echo "security-init: unknown argument" >&2; exit 2 ;;
  esac
fi

if [ "$ROTATE" -eq 0 ] && [ -f "$SECRETS_DIR/.initialized" ]; then
  echo "security-init: already initialized"
  exit 0
fi

if [ "$ROTATE" -eq 1 ]; then
  find "$SECRETS_DIR" -mindepth 1 -delete
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$SECRETS_DIR/ca" "$SECRETS_DIR/rabbitmq" "$SECRETS_DIR/redis" "$SECRETS_DIR/verify"

ADMIN_PW=$(openssl rand -hex 24)
put "$SECRETS_DIR/ca/rabbitmq-admin-password" "$ADMIN_PW"

openssl ecparam -name prime256v1 -genkey -noout -out "$SECRETS_DIR/ca/ca.key"
openssl req -x509 -new -key "$SECRETS_DIR/ca/ca.key" -sha256 -days 365 \
  -subj "/CN=trading-local-ca" -out "$SECRETS_DIR/ca/ca.crt"

USERS_JSON="{\"name\":\"admin\",\"password_hash\":\"$(rabbit_hash "$ADMIN_PW")\",\"hashing_algorithm\":\"rabbit_password_hashing_sha256\",\"tags\":[\"administrator\"]}"
PERMS_JSON="{\"user\":\"admin\",\"vhost\":\"trading\",\"configure\":\".*\",\"write\":\".*\",\"read\":\".*\"}"
ACL="user default off
"
COUNT=0

for id in $IDS; do
  camel=$(camel_of "$id")
  COUNT=$((COUNT + 1))

  mkdir -p "$SECRETS_DIR/$id-db" "$SECRETS_DIR/$id-migrate" "$SECRETS_DIR/$id-api" "$SECRETS_DIR/$id-worker"

  su_pw=$(openssl rand -hex 24)
  mg_pw=$(openssl rand -hex 24)
  ap_pw=$(openssl rand -hex 24)
  rq_pw=$(openssl rand -hex 24)
  rd_pw=$(openssl rand -hex 24)

  put "$SECRETS_DIR/$id-db/$id-db-superuser-password" "$su_pw"
  put "$SECRETS_DIR/$id-db/$id-db-migrator-password" "$mg_pw"
  put "$SECRETS_DIR/$id-db/$id-db-app-password" "$ap_pw"
  put "$SECRETS_DIR/$id-migrate/$id-db-migrator-password" "$mg_pw"

  openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/$id.key"
  openssl req -new -key "$WORK/$id.key" -subj "/CN=$id-api" -out "$WORK/$id.csr"
  printf 'subjectAltName=DNS:%s-api\nextendedKeyUsage=serverAuth,clientAuth\nkeyUsage=digitalSignature\n' "$id" > "$WORK/$id.ext"
  openssl x509 -req -in "$WORK/$id.csr" -CA "$SECRETS_DIR/ca/ca.crt" -CAkey "$SECRETS_DIR/ca/ca.key" \
    -CAcreateserial -CAserial "$WORK/ca.srl" -days 30 -sha256 -extfile "$WORK/$id.ext" -out "$WORK/$id.crt" 2>/dev/null

  for role in api worker; do
    d="$SECRETS_DIR/$id-$role"
    put "$d/$id-db-app-password" "$ap_pw"
    put "$d/$id-rabbitmq-password" "$rq_pw"
    put "$d/$id-redis-password" "$rd_pw"
    cp "$SECRETS_DIR/ca/ca.crt" "$d/ca.crt"
    cp "$WORK/$id.crt" "$d/$id.crt"
    cp "$WORK/$id.key" "$d/$id.key"
  done

  put "$SECRETS_DIR/verify/$id-rabbitmq-password" "$rq_pw"
  put "$SECRETS_DIR/verify/$id-redis-password" "$rd_pw"

  USERS_JSON="$USERS_JSON,{\"name\":\"$camel\",\"password_hash\":\"$(rabbit_hash "$rq_pw")\",\"hashing_algorithm\":\"rabbit_password_hashing_sha256\",\"tags\":[]}"
  c=$(json_escape "$(perm_of "$camel" c)")
  w=$(json_escape "$(perm_of "$camel" w)")
  r=$(json_escape "$(perm_of "$camel" r)")
  PERMS_JSON="$PERMS_JSON,{\"user\":\"$camel\",\"vhost\":\"trading\",\"configure\":\"$c\",\"write\":\"$w\",\"read\":\"$r\"}"

  rd_hash=$(printf '%s' "$rd_pw" | openssl dgst -sha256 -r | cut -d' ' -f1)
  ACL="${ACL}user $camel on #$rd_hash ~$camel:* resetchannels -@all +eval +evalsha +hello +auth +client|setinfo +client|setname +info +get +set +del +incrby +expire +pexpire +ttl +pttl
"
done

cp "$SECRETS_DIR/ca/ca.crt" "$SECRETS_DIR/verify/ca.crt"

EXCHANGES_JSON=""
for ex in account wallet order matching; do
  EXCHANGES_JSON="$EXCHANGES_JSON{\"name\":\"$ex.events\",\"vhost\":\"trading\",\"type\":\"topic\",\"durable\":true,\"auto_delete\":false,\"internal\":false,\"arguments\":{}},"
done
EXCHANGES_JSON="$EXCHANGES_JSON{\"name\":\"retry\",\"vhost\":\"trading\",\"type\":\"direct\",\"durable\":true,\"auto_delete\":false,\"internal\":false,\"arguments\":{}}"

printf '{"vhosts":[{"name":"trading"}],"users":[%s],"permissions":[%s],"exchanges":[%s]}\n' \
  "$USERS_JSON" "$PERMS_JSON" "$EXCHANGES_JSON" > "$SECRETS_DIR/rabbitmq/definitions.json"
printf '%s' "$ACL" > "$SECRETS_DIR/redis/users.acl"

chown_dir() {
  chown -R "$2" "$SECRETS_DIR/$1"
  find "$SECRETS_DIR/$1" -type d -exec chmod 0700 {} +
  find "$SECRETS_DIR/$1" -type f -exec chmod 0600 {} +
}

chown_dir ca 0:0
chown_dir rabbitmq 100:101
chown_dir redis 999:1000
chown_dir verify 1000:1000
for id in $IDS; do
  chown_dir "$id-db" 70:70
  chown_dir "$id-migrate" 1000:1000
  chown_dir "$id-api" 1000:1000
  chown_dir "$id-worker" 1000:1000
done

touch "$SECRETS_DIR/.initialized"
echo "security-init: initialized ($COUNT services)"
