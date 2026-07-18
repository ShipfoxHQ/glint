#!/usr/bin/env sh
set -eu

GARAGE_URL="${GARAGE_URL:-http://localhost:3903}"
ADMIN_TOKEN="${GARAGE_ADMIN_TOKEN:-glint-dev-admin-token}"
BUCKET="glint"
KEY_NAME="local-dev"
ACCESS_KEY_ID="GK000000000000000000000000"
SECRET_ACCESS_KEY="0000000000000000000000000000000000000000000000000000000000000000"

api() {
  method="$1"
  path="$2"
  body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$GARAGE_URL/v2$path" \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -fsS -X "$method" "$GARAGE_URL/v2$path" \
      -H "Authorization: Bearer $ADMIN_TOKEN"
  fi
}

layout="$(api GET /GetClusterLayout)"
if [ "$(printf '%s' "$layout" | jq -r '.roles | length')" = "0" ]; then
  node_id="$(api GET /GetClusterStatus | jq -r '.nodes[0].id')"
  next_version="$(printf '%s' "$layout" | jq -r '.version + 1')"
  layout_update="$(jq -cn --arg id "$node_id" \
    '{roles: [{id: $id, zone: "local", capacity: 1000000000, tags: []}]}')"
  api POST /UpdateClusterLayout "$layout_update" >/dev/null
  api POST /ApplyClusterLayout "{\"version\":$next_version}" >/dev/null
fi

api POST /ImportKey \
  "{\"name\":\"$KEY_NAME\",\"accessKeyId\":\"$ACCESS_KEY_ID\",\"secretAccessKey\":\"$SECRET_ACCESS_KEY\"}" \
  >/dev/null 2>&1 || true
api POST /CreateBucket "{\"globalAlias\":\"$BUCKET\"}" >/dev/null 2>&1 || true
bucket_id="$(api GET "/GetBucketInfo?globalAlias=$BUCKET" | jq -r '.id')"
api POST /AllowBucketKey \
  "{\"bucketId\":\"$bucket_id\",\"accessKeyId\":\"$ACCESS_KEY_ID\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" \
  >/dev/null

echo "Garage ready: bucket '$BUCKET', key '$KEY_NAME'."
