# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

### SI-03.1 — Provision Storage, Queue, and Worker Infrastructure
- **Status:** completed
- **Tests:** 23 passing (storage.config.spec.ts: 5, queue.config.spec.ts: 6, env.validation.integration-spec.ts: 12)
- **Observations:**
  - **MinIO was removed from Docker Hub.** The `minio/minio` and `minio/mc` repositories no longer exist (verified: registry returns "object not found", and even pull-by-digest fails), so the `RELEASE.*` tags the plan assumes are unpullable. `quay.io/minio/minio` also refused anonymous pulls here (401). The stack now uses `cgr.dev/chainguard/minio`, pinned by multi-arch digest — upstream MinIO `RELEASE.2026-09-22T19-25-18Z`, redistributed and security-patched. Verified working: S3 API, `mc`, and the `mc ready local` healthcheck.
  - **MinIO does not implement `AbortIncompleteMultipartUpload`.** The plan's 7-day lifecycle rule cannot be created — MinIO rejects it as not matching its published schema (confirmed against upstream issue minio/minio#15681). MinIO purges incomplete multipart uploads itself at a 24h default, and `MINIO_API_STALE_UPLOADS_EXPIRY` is **not** a recognised env key in this release (verified: MinIO fails fast on unknown-but-invalid values such as `MINIO_BROWSER`, but accepted a deliberately invalid value for the stale-uploads key). The explicit, observable cleanup layer is therefore the SI-03.8 maintenance job; `minio-init` only creates the bucket.
  - **`.env.example` had a latent bug.** `MAIL_FROM="StreamTube" <noreply@streamtube.com>` is unquoted, so the angle brackets break the Compose `.env` parser — this only surfaces once a `.env` exists, which is exactly what this SI introduces. Changed to single-quoted, which both Compose and dotenv resolve to the value the app expects.
  - **The local-input exclude patterns were too broad.** `.git/info/exclude` holds unanchored patterns for the two local-only input directories, and the one covering the video fixtures also matched `nestjs-project/src/videos/` — which would have silently dropped the entire video module from the repository. Both patterns are now anchored to the repository root, so the local inputs stay ignored while the module is versioned.
  - Queue name and worker options live in `src/videos/queue/video-processing.queue.ts`, not in `queue.config.ts`: `@Processor`/`BullModule` need a static token at decoration time, before `ConfigModule` has read `.env`. `queue.config.ts` keeps the connection and the runtime job options (`attempts`, backoff, relay settings).

### SI-03.2 — Model the Video Entity and Its Migration
- **Status:** completed
- **Tests:** 16 passing (video.entity.integration-spec.ts: 12, migrations.integration-spec.ts: 4)
- **Observations:**
  - Recovered the dev database from "synchronize residue" first: the tables existed but the `migrations` table was empty, so `migration:generate` would have produced a full-schema migration instead of just `videos`. Dropped the orphan tables and the orphan enum type, re-ran the two existing migrations, then generated `CreateVideos` against a correct baseline.
  - Generated the status CHECK constraint and both indexes from the entity (`@Check` + `@Index`) rather than hand-writing SQL, so the migration stays CLI-generated and the constraint derives from `VIDEO_STATUS`.
  - The inverse `Channel#videos` relation is deliberately omitted. Nothing in this phase traverses channel → videos, and declaring it would force `Video` into every existing test data source that registers `Channel` (11 files). The owning side matches the plan's Data Model exactly.
  - `cleanAllTables()` now clears `video_processing_outbox` and `videos` before `channels`; without it every integration suite failed on the `ON DELETE RESTRICT` foreign key. The five suites that truncate shared tables got `Video` added to their entity arrays.
  - The migrations suite also had to drop the `verification_tokens_type_enum` type (a `DROP TABLE` does not remove it) and drop tables sequentially — concurrent DDL on FK-linked tables deadlocks.

### SI-03.3 — Implement the S3 Storage Abstraction with a Dual Endpoint
- **Status:** completed
- **Tests:** 35 passing (storage.service.spec.ts: 24, storage.service.integration-spec.ts: 11)
- **Observations:**
  - `job.discard()`-style assumptions aside, one real API finding: the AWS SDK wraps transport failures so `error.code` sits on the cause chain — and inside Jest the wrapper preserves the code in **neither** `code` nor `cause`, only the message. The 503 classifier handles all three shapes; the unit test covers the wrapped variant.
  - Part-upload URLs are signed against the public endpoint (the browser is their consumer), which the API container cannot reach. The integration spec uses a second service instance whose public endpoint is the internal one to exercise the real multipart PUTs, and asserts the public host separately from the outside.
  - `S3StorageService` implements `OnModuleDestroy` to release both connection pools; without it Jest hangs on the open socket.
  - `getPresignedReadUrl` sanitizes the download filename before it reaches the header (strips control characters, quotes and backslashes).

### SI-03.4 — Add the Processing Queue and the Transactional Outbox
- **Status:** completed
- **Tests:** 25 passing (video-processing-outbox.service.spec.ts: 6, video-processing-outbox.relay.spec.ts: 10, video-processing-outbox.relay.integration-spec.ts: 9)
- **Observations:**
  - **TypeORM returns `[rows, affectedCount]` for `UPDATE ... RETURNING`**, unlike `SELECT`, which returns rows directly. The claim query silently yielded a two-element array instead of the claimed rows; the integration test caught it as `NaN` in the attempts column.
  - Both queue specs are isolated per test (outbox truncated, queue drained) — otherwise a row left pending by an earlier test is claimed by the next one and the dispatch counts are wrong.
  - The relay's poll timer is skipped when `NODE_ENV=test`, so tests drive `processPending()` explicitly and never wait on a timer.

### SI-03.5 — Build the Presigned Multipart Upload API
- **Status:** completed
- **Tests:** 43 passing (videos.service.spec.ts: 20, public-id.util.spec.ts: 5, videos.service.integration-spec.ts: 4, videos-upload.e2e-spec.ts: 19 — of 71 E2E total)
- **Observations:**
  - `size_bytes` above 10GB is a **service** rule, not a `@Max` on the DTO: the error catalog specifies `413 PAYLOAD_TOO_LARGE`, and a validator would have produced `400 VALIDATION_ERROR`. The ceiling now lives with the other business rules.
  - Part-upload URLs are signed for the browser host, so the test process cannot PUT to them. Both the integration and e2e suites sign the same key/uploadId against the internal host to upload the real bytes, and the e2e additionally asserts the browser-facing URL never carries the internal Docker host.
  - The concurrent-completion test asserts the invariant that matters — **exactly one outbox row** and a video in `processing` — rather than the loser's exception type: the loser can fail at storage (`NoSuchUpload`, when the winner already assembled the object) or at the guarded `WHERE status = 'draft'` update. The unit test pins the `VideoNotDraftException` branch deterministically.
  - **`npm run test:e2e` was missing `--runInBand`**, which `nestjs-project/CLAUDE.md` claims is "already configured". With one DB-touching e2e suite that never mattered; with two, Jest runs the files in parallel workers and they truncate the same tables concurrently — 18 failures. The script now carries the flag the project rule requires, and the suite is green.
  - `ChannelsService.findByUserId` was added so channel ownership stays in the channel module rather than videos reaching into the `channels` table.

### SI-03.6 — Implement the FFmpeg Worker
- **Status:** completed
- **Tests:** 25 passing (video-processing.processor.spec.ts: 13, media-probe.service.integration-spec.ts: 4, thumbnail.service.integration-spec.ts: 4, video-processing.processor.integration-spec.ts: 4) — run in `nestjs-worker`
- **Observations:**
  - `ffmpeg`/`ffprobe` live **only** in the worker image, by design the API image must not carry them. The three suites that shell out therefore **skip in `nestjs-api` and run for real in `nestjs-worker`**; that is where the evidence above was produced. In the API container the full run reports 35 passed / 3 skipped suites, 279 passed / 12 skipped tests.
  - Test media is **generated** with FFmpeg (`testsrc` + `sine`) instead of using any local fixture file — nothing binary is checked in and no versioned file references a local-only input path.
  - `ThumbnailService` writes the JPEG to `pipe:1` rather than a temp file, so nothing is left on disk however the job ends. `runProcess` collects stdout as a **Buffer** for that reason.
  - `media-probe` treats a non-zero ffprobe exit as `InvalidMediaError` — an input the decoder cannot parse fails identically on every attempt, so it must not be retried. `classifyFailure` defaults to *recoverable* so an unrecognised error is retried rather than written off on a guess.
  - The processor re-reads the row and returns early when the video is no longer `processing`, re-reads the source through an **internal** presigned URL (`internal: true`), and only writes `ready` after `HeadObject` confirms the thumbnail exists.
  - `WorkerModule` is a separate composition root: it registers the entity closure (`User` → `Channel` → `Video`) that the relations need, but deliberately does **not** import `VideosModule`, so the controller, upload service and outbox relay stay out of the worker process.
  - Dev Compose runs the worker through `ts-node` against the bind-mounted source; `Dockerfile.worker` runs the compiled `dist/worker/main.js`.

### SI-03.7 — Serve Streaming, Download, Thumbnail, and Public Metadata
- **Status:** completed
- **Tests:** 21 passing (videos-stream.e2e-spec.ts — of 92 E2E total)
- **Observations:**
  - Stream, thumbnail, metadata and `playback-url` are `@Public()`; **download is the only read endpoint without it**, which is what makes `GET /videos/:public_id/download` return 401 anonymously while anonymous visitors still watch freely.
  - The API answers `302` and carries no media: the response body is Express's redirect notice, and range/`206`/`416` are served by storage. The e2e asserts the redirect target is a presigned URL on the **public** host, and separately that the same signing mechanism yields a URL that answers `206` to `bytes=0-1023` and `416` to an unsatisfiable range — the API container cannot resolve the public host, so the byte-level half is proven against an internal-signed URL for the same key.
  - The metadata response is asserted **not** to contain the internal id, `storage_key`, or the object name.
  - `thumbnail` returns `404` while no thumbnail exists, matching the catalog, rather than `409`.
  - `playback-url` reuses the stream presign so a player can recover after its URL expires.

### SI-03.8 — Harden Cleanup, Reconciliation, and Failure Handling
- **Status:** completed
- **Tests:** 16 passing (upload-cleanup.service.spec.ts: 5, upload-cleanup.service.integration-spec.ts: 5, processing-reconciler.service.spec.ts: 6; failure-policy is covered inside video-processing.processor.spec.ts: 13)
- **Observations:**
  - `failure-policy.ts` shipped with SI-03.6, since the processor needs it; the classification is exercised by the processor suite rather than a standalone one.
  - The reconciler consults **both** the database and the queue, because either alone lies: a row in `processing` may have no job, and a job may exist for a row a redelivery already finished. A video is only touched once no job in a live state (`active`/`waiting`/`delayed`) accounts for it. The stalled threshold sits above the worker's lock duration, so a job that is merely slow is never reconciled.
  - Cleanup treats a failed `abortMultipartUpload` as non-fatal: MinIO may already have purged the upload itself, and the database state is what the sweep exists to fix.
  - `upload-cleanup.service.integration-spec.ts` closes the gap this SI originally left: against real PostgreSQL and MinIO it proves the multipart upload is **genuinely gone from storage** afterwards (completing it is refused), not merely marked as aborted in the database, and that a draft still inside the retention window is untouched.
  - Both sweeps are driven explicitly in tests (`NODE_ENV=test` skips their timers) and their intervals/thresholds come from `queue.config`.

### SI-03.9 — Complete the Test Pyramid and Verify the Definition of Done
- **Status:** completed
- **Tests:** API `npm test -- --runInBand`: 37 suites passed + 3 skipped, 290 passed / 12 skipped. API `npm run test:e2e`: 5 suites, 92 passed. Worker `npm test -- --runInBand`: 40 suites, 302 passed. `npx tsc --noEmit` exit 0. `npm run lint` exit 0 with 0 problems.
- **Observations:**
  - **The large-upload acceptance was executed**, with `scripts/acceptance/upload-10gb.sh` against an 8.78 GiB file (9,207,456,591 bytes) split into 138 parts of 64 MiB, uploaded at concurrency 4. Evidence:
    - Upload wall clock **34s** (a second run took 17s); `POST /:id/complete` returned **202**; the video reached **`ready`**.
    - **API latency during the transfer: median 1 ms, max 4 ms** across 17 samples taken every 2s. This is the "does not stall the API" evidence — the API is not on the data path, so the numbers do not move with file size.
    - **API memory during the transfer: 1.031–1.032 GiB, a delta of 1 MiB**, CPU below 1% after the first sample. The API never buffers the file.
    - `duration_seconds` came back **137332** (≈38.1h), which is what the source material actually is.
    - Thumbnail: `302` → a real **141,032-byte 1920×1080 JPEG**.
    - Streaming: `302` → **`206 Partial Content`** with `Content-Range: bytes 0-1023/9207456591`.
    - Download: `302` with `attachment; filename="Acceptance run.mp4"` when authenticated, **`401` without a token**. The downloaded object's **sha256 matches the source byte for byte**.
  - **The ~10.1 GiB fixture is correctly rejected.** At 10,881,539,343 bytes it exceeds the 10 GiB (10,737,418,240-byte) ceiling, and `POST /videos` answers **`413 PAYLOAD_TOO_LARGE`**. The plan assumed both fixtures would upload; that assumption was arithmetically wrong — the ceiling has to reject it, and does. The successful acceptance run is therefore the 8.78 GiB file, which is the largest decodable fixture available under the limit.
  - `npm run test:e2e` now carries `--runInBand` (see SI-03.5). Without it Jest parallelises the e2e files and they truncate the same tables concurrently.
  - **Known flakiness, and its likely cause:** `video-processing-outbox.relay.integration-spec.ts` shares Redis with the *live* worker process in the same container, so a job it publishes can be consumed mid-assertion. One earlier full run reported it as a failed suite with zero failed tests. Leftover `jest` processes from interrupted runs were found still attached to the same database and queue, and were killed; that is the most plausible source of the interference. Worth giving the suite its own queue name.
  - The FFmpeg-dependent suites skip in `nestjs-api` (12 skipped tests) and run in `nestjs-worker`; both containers were run to cover the whole pyramid.

### SI-03.10 — Update the AI Documentation and Close the Phase
- **Status:** completed
- **Tests:** no tests — `npm run openapi:export` regenerated the contract
- **Observations:**
  - `openapi.json` re-exported: all nine video routes are present (`POST /videos`, `/parts`, `/complete`, `/abort`, and `GET /videos/{public_id}`, `/stream`, `/download`, `/thumbnail`, `/playback-url`).
  - Root `CLAUDE.md` gained a **Videos (Phase 03)** section (presigned upload, measured size, transactional outbox, server-assigned keys, redirect streaming, `@Public()` on reads only, dual endpoint) and the container diagram now names BullMQ/Redis instead of "Message Queue (TBD)".
  - `nestjs-project/CLAUDE.md` now lists the new services (`minio`, `minio-init`, `redis`, `nestjs-worker`) and documents the worker: how it boots, why `WorkerModule` is a separate composition root, that FFmpeg lives only in the worker image, and that the ffmpeg-backed suites must be run in the worker container.
  - Every file and behaviour named in either `CLAUDE.md` was checked against the code — nothing aspirational is documented.
