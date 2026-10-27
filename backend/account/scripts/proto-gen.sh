#!/bin/sh
set -eu

out=src/infra/generated
rm -rf "$out"
mkdir -p "$out"

protos=$(find contracts -name '*.proto' 2>/dev/null | sort)
[ -z "$protos" ] && { echo "proto-gen: no .proto files"; exit 0; }

for proto in $protos; do
  protoc \
    --plugin=protoc-gen-ts_proto=node_modules/.bin/protoc-gen-ts_proto \
    --ts_proto_out="$out" \
    --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,importSuffix=.js,useOptionals=messages,env=node \
    -I "$(dirname "$proto")" "$proto"
done
echo "proto-gen: generated $(echo "$protos" | wc -l | tr -d ' ') file(s)"
