#!/usr/bin/env bash
#
# Acceptance evidence for the "upload up to 10GB without stalling the API" requirement.
#
# The point of this script is not that a large file can be uploaded — it is that the
# API stays responsive *while* it happens. The video never transits the API: the
# client asks for presigned part URLs and PUTs the bytes straight to storage, so API
# latency should be flat regardless of file size. This measures that.
#
# It is NOT part of `npm test`: it needs a multi-gigabyte file, minutes of wall clock,
# and disk on both the client and the object store.
#
# Usage:
#   scripts/acceptance/upload-10gb.sh <path-to-large-video> [api-base-url]
#
# Run it from the host, where `localhost:9000` reaches MinIO. The presigned URLs the
# API returns are signed for that host on purpose, so a run from inside a container
# would fail with ECONNREFUSED.
set -euo pipefail

VIDEO_PATH="${1:?usage: upload-10gb.sh <path-to-large-video> [api-base-url]}"
API="${2:-http://localhost:3000}"
PART_SIZE=$((8 * 1024 * 1024))
CONCURRENCY="${UPLOAD_CONCURRENCY:-4}"
SIZE_BYTES=$(stat -c '%s' "$VIDEO_PATH")
FILENAME=$(basename "$VIDEO_PATH")
EMAIL="acceptance-$(date +%s)@example.com"
PASSWORD="password123"

echo "File:        $VIDEO_PATH"
echo "Size:        $SIZE_BYTES bytes ($((SIZE_BYTES / 1024 / 1024)) MiB)"
echo "API:         $API"
echo

# ---------------------------------------------------------------- helpers

api_latency() {
  curl -s -o /dev/null -w '%{time_total}' "$API/"
}

register_and_login() {
  # The confirmation token is delivered by e-mail; Mailpit exposes it over HTTP,
  # which is how this script confirms the account without shelling into a container.
  curl -s -X POST "$API/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null

  local mailpit="${MAILPIT_URL:-http://localhost:8025}"
  local token
  token=$(curl -s "$mailpit/api/v1/messages" \
    | python3 -c "
import json,sys,re
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for m in data.get('messages', []):
    body = json.dumps(m)
    found = re.search(r'[?&]token=([A-Za-z0-9._-]+)', body)
    if found:
        print(found.group(1)); break
" || true)

  if [ -n "$token" ]; then
    curl -s "$API/auth/confirm-email?token=$token" >/dev/null
  fi

  curl -s -X POST "$API/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

# ---------------------------------------------------------------- run

echo "==> Registering an account"
TOKEN=$(register_and_login)
[ -n "$TOKEN" ] || { echo "FAILED: could not obtain an access token"; exit 1; }

echo "==> Pre-registering the video as a draft"
INIT=$(curl -s -X POST "$API/videos" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Acceptance run\",\"filename\":\"$FILENAME\",\"size_bytes\":$SIZE_BYTES,\"mime_type\":\"video/mp4\",\"part_size\":$PART_SIZE}")

VIDEO_ID=$(echo "$INIT"  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
PUBLIC_ID=$(echo "$INIT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["public_id"])')
UPLOAD_ID=$(echo "$INIT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["upload_id"])')
PART_COUNT=$(echo "$INIT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["part_count"])')

echo "    video_id=$VIDEO_ID public_id=$PUBLIC_ID parts=$PART_COUNT"

echo "==> Uploading $PART_COUNT parts directly to storage (concurrency $CONCURRENCY)"
PARTS_DIR=$(mktemp -d)
trap 'rm -rf "$PARTS_DIR"' EXIT

# Sampled in the background for the whole transfer.
LATENCY_LOG="$PARTS_DIR/latency.log"
(
  while true; do
    api_latency >> "$LATENCY_LOG" 2>/dev/null || true
    sleep 2
  done
) &
LATENCY_PID=$!

upload_part() {
  local number="$1" start end url
  start=$(( (number - 1) * PART_SIZE ))
  url=$(curl -s -X POST "$API/videos/$VIDEO_ID/parts" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"part_numbers\":[$number]}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["parts"][0]["url"])')

  end=$(( start + PART_SIZE - 1 ))
  [ "$end" -ge "$SIZE_BYTES" ] && end=$(( SIZE_BYTES - 1 ))

  local etag
  etag=$(dd if="$VIDEO_PATH" bs=1M skip=$(( start / 1024 / 1024 )) count=$(( PART_SIZE / 1024 / 1024 )) 2>/dev/null \
    | curl -s -X PUT --data-binary @- -D - -o /dev/null "$url" \
    | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')

  python3 -c "import json,sys;print(json.dumps({'part_number':$number,'etag':sys.argv[1]}))" "$etag" \
    > "$PARTS_DIR/part-$number.json"
}

START_TS=$(date +%s)
export -f upload_part
export API VIDEO_ID TOKEN PART_SIZE SIZE_BYTES VIDEO_PATH PARTS_DIR

seq 1 "$PART_COUNT" | xargs -P "$CONCURRENCY" -I{} bash -c 'upload_part {}'

kill "$LATENCY_PID" 2>/dev/null || true
wait "$LATENCY_PID" 2>/dev/null || true
ELAPSED=$(( $(date +%s) - START_TS ))

echo "==> Completing the upload"
PARTS_JSON=$(python3 -c "
import glob, json
parts = [json.load(open(p)) for p in sorted(glob.glob('$PARTS_DIR/part-*.json'),
         key=lambda p: int(p.rsplit('-', 1)[1].split('.')[0]))]
print(json.dumps({'parts': parts}))
")

COMPLETE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/videos/$VIDEO_ID/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$PARTS_JSON")
echo "    POST /complete -> $COMPLETE"

echo "==> Waiting for the worker to reach 'ready'"
STATUS=""
for _ in $(seq 1 300); do
  STATUS=$(curl -s "$API/videos/$PUBLIC_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = "ready" ] && break
  [ "$STATUS" = "error" ] && break
  sleep 5
done
echo "    status=$STATUS"

# ---------------------------------------------------------------- evidence

echo
echo "===================== EVIDENCE ====================="
echo "File size:            $SIZE_BYTES bytes"
echo "Upload wall clock:    ${ELAPSED}s"
echo "Final status:         $STATUS"

python3 - "$LATENCY_LOG" <<'PY'
import sys, statistics
try:
    samples = [float(line) for line in open(sys.argv[1]) if line.strip()]
except FileNotFoundError:
    samples = []
if samples:
    print(f"API latency samples:  {len(samples)}")
    print(f"  median:             {statistics.median(samples):.3f}s")
    print(f"  max:                {max(samples):.3f}s")
    print("  (flat latency during the transfer is the 'does not stall' evidence)")
else:
    print("API latency samples:  none collected")
PY

echo
echo "Confirm by hand, and record in docs/phases/phase-03-videos/progress.md:"
echo "  - GET  $API/videos/$PUBLIC_ID            -> 200 with duration_seconds and thumbnail_url"
echo "  - GET  $API/videos/$PUBLIC_ID/thumbnail  -> 302 to the generated JPEG"
echo "  - curl -r 0-1023 -L $API/videos/$PUBLIC_ID/stream -> 206 Partial Content"
echo "  - GET  $API/videos/$PUBLIC_ID/download (with the token) -> attachment"
echo "  - docker stats nestjs-project-nestjs-api-1 (memory stays flat during the upload)"
