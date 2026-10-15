#!/usr/bin/env bash
#
# Acceptance evidence for the "upload up to 10GB without stalling the API" requirement.
#
# The point is not that a large file can be uploaded — it is that the API stays
# responsive *while* it happens. The video never transits the API: the client asks
# for presigned part URLs and PUTs the bytes straight to storage, so API latency
# should stay flat no matter how large the file is. This measures that.
#
# Not part of `npm test`: it needs a multi-gigabyte file, minutes of wall clock, and
# disk on both the client and the object store.
#
# Usage:
#   scripts/acceptance/upload-10gb.sh <path-to-large-video> [api-base-url]
#
# Environment:
#   PART_SIZE_MB      multipart part size (default 64; must be 5..64)
#   UPLOAD_CONCURRENCY parallel part uploads (default 4)
#   POLL_INTERVAL     seconds between status polls (default 15)
#   MAILPIT_URL       where to read the confirmation e-mail (default http://localhost:8025)
#
# Run it from the HOST, where `localhost:9000` reaches MinIO. The presigned URLs the
# API returns are signed for that host on purpose, so running this from inside a
# container would fail with ECONNREFUSED.
set -euo pipefail

VIDEO_PATH="${1:?usage: upload-10gb.sh <path-to-large-video> [api-base-url]}"
API="${2:-http://localhost:3000}"

PART_SIZE_MB="${PART_SIZE_MB:-64}"
PART_SIZE=$((PART_SIZE_MB * 1024 * 1024))
CONCURRENCY="${UPLOAD_CONCURRENCY:-4}"
# The global throttler allows 10 requests/min on non-upload routes, and the status
# poll is one of them — 15s keeps it at 4/min.
POLL_INTERVAL="${POLL_INTERVAL:-15}"
PRESIGN_BATCH="${PRESIGN_BATCH:-100}"

SIZE_BYTES=$(stat -c '%s' "$VIDEO_PATH")
FILENAME=$(basename "$VIDEO_PATH")
EMAIL="acceptance-$(date +%s)@example.com"
PASSWORD="password123"

echo "File:        $VIDEO_PATH"
echo "Size:        $SIZE_BYTES bytes ($((SIZE_BYTES / 1024 / 1024)) MiB)"
echo "Part size:   ${PART_SIZE_MB} MiB"
echo "API:         $API"
echo

# ---------------------------------------------------------------- helpers

confirm_account() {
  # The confirmation token arrives by e-mail; Mailpit exposes the mailbox over
  # HTTP, which avoids shelling into a container to read it. The search is scoped
  # to this run's recipient — a shared mailbox still holds messages from other
  # runs, and the body only appears in the per-message endpoint, not the summary.
  local mailpit="${MAILPIT_URL:-http://localhost:8025}"
  local token=""

  for _ in $(seq 1 15); do
    token=$(curl -s "$mailpit/api/v1/search?query=to:$EMAIL" | python3 -c "
import json, re, sys, urllib.request
try:
    listing = json.load(sys.stdin)
except Exception:
    sys.exit(0)
messages = listing.get('messages') or []
if not messages:
    sys.exit(0)
detail = urllib.request.urlopen(
    '${mailpit}/api/v1/message/' + messages[0]['ID']
).read().decode('utf-8', 'replace')
found = re.search(r'[?&]token=([A-Za-z0-9._-]+)', detail)
if found:
    print(found.group(1))
" 2>/dev/null || true)

    [ -n "$token" ] && break
    sleep 1
  done

  if [ -z "$token" ]; then
    echo "FAILED: no confirmation e-mail arrived for $EMAIL" >&2
    return 1
  fi

  curl -s "$API/auth/confirm-email?token=$token" >/dev/null
}

register_and_login() {
  curl -s -X POST "$API/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null

  confirm_account

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
PART_COUNT=$(echo "$INIT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["part_count"])')

echo "    video_id=$VIDEO_ID public_id=$PUBLIC_ID parts=$PART_COUNT"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Requesting presigned URLs in batches of $PRESIGN_BATCH"
# One request per batch, not per part: a 10GB upload at 8MiB parts is ~1,280 parts,
# and one presign call each would trip the upload endpoints' own rate limit.
: > "$WORK_DIR/urls.tsv"
for (( first = 1; first <= PART_COUNT; first += PRESIGN_BATCH )); do
  last=$(( first + PRESIGN_BATCH - 1 ))
  [ "$last" -gt "$PART_COUNT" ] && last=$PART_COUNT
  numbers=$(seq -s, "$first" "$last")

  curl -s -X POST "$API/videos/$VIDEO_ID/parts" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"part_numbers\":[$numbers]}" \
    | python3 -c '
import json, sys
for part in json.load(sys.stdin)["parts"]:
    print("%s\t%s" % (part["part_number"], part["url"]))
' >> "$WORK_DIR/urls.tsv"
done

echo "    received $(wc -l < "$WORK_DIR/urls.tsv") presigned URLs"

echo "==> Uploading parts directly to storage (concurrency $CONCURRENCY)"
LATENCY_LOG="$WORK_DIR/latency.log"
(
  while true; do
    curl -s -o /dev/null -w '%{time_total}\n' "$API/" >> "$LATENCY_LOG" 2>/dev/null || true
    sleep 2
  done
) &
LATENCY_PID=$!

upload_part() {
  local number="$1" start end url
  start=$(( (number - 1) * PART_SIZE ))
  end=$(( start + PART_SIZE ))
  [ "$end" -gt "$SIZE_BYTES" ] && end=$SIZE_BYTES

  url=$(awk -v n="$number" '$1 == n { print $2 }' "$WORK_DIR/urls.tsv")

  local etag
  etag=$(dd if="$VIDEO_PATH" bs=1M skip=$(( start / 1024 / 1024 )) \
           count=$(( (end - start) / 1024 / 1024 + 1 )) 2>/dev/null \
    | head -c "$(( end - start ))" \
    | curl -s -X PUT --data-binary @- -D - -o /dev/null "$url" \
    | tr -d '\r' | awk 'tolower($1) == "etag:" { print $2 }')

  python3 -c "
import json, sys
print(json.dumps({'part_number': $number, 'etag': sys.argv[1]}))
" "$etag" > "$WORK_DIR/part-$number.json"
}

export -f upload_part
export VIDEO_PATH PART_SIZE SIZE_BYTES WORK_DIR

START_TS=$(date +%s)
seq 1 "$PART_COUNT" | xargs -P "$CONCURRENCY" -I{} bash -c 'upload_part {}'
ELAPSED=$(( $(date +%s) - START_TS ))

kill "$LATENCY_PID" 2>/dev/null || true
wait "$LATENCY_PID" 2>/dev/null || true

echo "==> Completing the upload"
PARTS_JSON=$(python3 -c "
import glob, json
paths = glob.glob('$WORK_DIR/part-*.json')
parts = [json.load(open(p)) for p in sorted(paths, key=lambda p: int(p.rsplit('-', 1)[1][:-5]))]
print(json.dumps({'parts': parts}))
")

COMPLETE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/videos/$VIDEO_ID/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$PARTS_JSON")
echo "    POST /complete -> $COMPLETE"

echo "==> Waiting for the worker to finish"
STATUS=""
for _ in $(seq 1 240); do
  STATUS=$(curl -s "$API/videos/$PUBLIC_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = "ready" ] || [ "$STATUS" = "error" ] && break
  sleep "$POLL_INTERVAL"
done
echo "    status=$STATUS"

# ---------------------------------------------------------------- evidence

echo
echo "===================== EVIDENCE ====================="
echo "File size:            $SIZE_BYTES bytes ($((SIZE_BYTES / 1024 / 1024)) MiB)"
echo "Upload wall clock:    ${ELAPSED}s"
echo "POST /complete:       $COMPLETE"
echo "Final status:         $STATUS"

python3 - "$LATENCY_LOG" <<'PY'
import statistics, sys
try:
    samples = [float(line) for line in open(sys.argv[1]) if line.strip()]
except FileNotFoundError:
    samples = []
if samples:
    print(f"API latency samples:  {len(samples)} (sampled every 2s during the transfer)")
    print(f"  median:             {statistics.median(samples) * 1000:.0f} ms")
    print(f"  max:                {max(samples) * 1000:.0f} ms")
    print("  -> flat latency here is the 'does not stall the API' evidence")
else:
    print("API latency samples:  none collected")
PY

echo
echo "Confirm by hand:"
echo "  GET   $API/videos/$PUBLIC_ID/thumbnail           -> 302 to the generated JPEG"
echo "  curl -r 0-1023 -L $API/videos/$PUBLIC_ID/stream  -> 206 Partial Content"
echo "  GET   $API/videos/$PUBLIC_ID/download (Bearer)   -> 302 attachment"
echo "  docker stats --no-stream nestjs-project-nestjs-api-1"
echo
echo "Record the output in docs/phases/phase-03-videos/progress.md."
