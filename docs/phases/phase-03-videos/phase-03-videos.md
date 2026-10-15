---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-14T17:55:17-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-14T18:04:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T17:54:03-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video upload and processing pipeline: object storage, a background queue and its worker, presigned multipart upload of files up to 10GB that never transit the API, automatic metadata and thumbnail generation, a unique public URL per video, and streaming plus download.

---

## Step Implementations

### SI-03.1 — Provision Storage, Queue, and Worker Infrastructure

**Description:** Add the three new infrastructure services (MinIO, Redis, and a worker container with FFmpeg) to the Compose stack, and introduce the storage and queue configuration modules with their Joi-validated environment keys, so later SIs have a working storage backend, a reachable Redis, and a runnable worker image.

**Technical actions:**

- Add `minio`, `minio-init`, and `redis` services to `nestjs-project/compose.yaml` — pinned image tags, named volumes, healthchecks, and `depends_on: { condition: service_healthy }` where a service must wait. `minio-init` runs `mc mb --ignore-existing` for the `streamtube` bucket and applies the `AbortIncompleteMultipartUpload` lifecycle rule (7 days) — per `phase-03-videos/TD-03`
- Create `nestjs-project/Dockerfile.worker` from the same `node:25.6.0-slim` base as `Dockerfile.dev`, installing `ffmpeg` via apt; add the `nestjs-worker` service to `nestjs-project/compose.yaml` with the same bind mount and `depends_on` on `db`, `redis`, and `minio` — per `phase-03-videos/TD-06`
- Create `nestjs-project/src/config/storage.config.ts` and `nestjs-project/src/config/queue.config.ts` as `registerAs` factories exposing `endpoint`, `publicEndpoint`, `region`, `bucket`, `accessKeyId`, `secretAccessKey`, `presignExpiresIn`, and `redisHost`, `redisPort`, `videoProcessingQueue`, `attempts`, `lockDurationMs`, `stalledIntervalMs`, `maxStalledCount` respectively — per `phase-01-configuracao-base/TD-03`
- Extend `nestjs-project/src/config/env.validation.ts` with Joi keys for `STORAGE_*` and `REDIS_*`/`QUEUE_*`, register both configs in the `load` array of `nestjs-project/src/app.module.ts`, mirror every key in `nestjs-project/.env.example`, and create the uncommitted `nestjs-project/.env` — per `phase-01-configuracao-base/TD-02`
- Confirm the stack: `docker compose up -d` brings every service up healthy, the `streamtube` bucket exists, and `ffmpeg -version` succeeds inside the `nestjs-worker` container

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/storage.config.spec.ts` | Unit | Defaults for region, bucket and presign TTL; env values are read and coerced |
| `src/config/queue.config.spec.ts` | Unit | Defaults for port, attempts and lock duration; queue name constant is exposed |
| `src/config/env.validation.integration-spec.ts` | Integration | New keys validate, and a missing `STORAGE_ENDPOINT` fails the schema |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` starts `nestjs-api`, `db`, `mailpit`, `minio`, `redis`, and `nestjs-worker`, and every service with a healthcheck reports healthy
- The `streamtube` bucket exists and carries the 7-day `AbortIncompleteMultipartUpload` lifecycle rule
- `ffmpeg -version` and `ffprobe -version` succeed inside the `nestjs-worker` container, and FFmpeg is **not** installed in the API image
- No inter-service configuration uses `localhost` — hosts are the Compose service names `db`, `minio`, and `redis`
- `npx tsc --noEmit` exits 0 and `npm run lint` is clean

---

### SI-03.2 — Model the Video Entity and Its Migration

**Description:** Create the `videos` table and its TypeORM entity, bound to the owning channel and carrying the four-state status lifecycle, the storage keys, the extracted media metadata, and the unique public identifier.

**Technical actions:**

- Create `nestjs-project/src/videos/videos.constants.ts` — `VIDEO_STATUS` as a `const` object with type `VideoStatus`, plus `MAX_VIDEO_SIZE_BYTES`, `DEFAULT_PART_SIZE_BYTES`, `MIN_PART_SIZE_BYTES`, `MAX_PART_COUNT`, `ALLOWED_MIME_TYPES`, `PUBLIC_ID_LENGTH`, and the `videos/{id}/source.mp4` / `videos/{id}/thumbnail.jpg` key builders — per `phase-03-videos/TD-04` and `phase-03-videos/TD-05`
- Create `nestjs-project/src/videos/entities/video.entity.ts` with an explicit `@Entity('videos')` name, `@PrimaryGeneratedColumn('uuid')`, snake_case columns, `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`, `metadata` as `jsonb`, and `size_bytes` as `bigint` behind a transformer (the pg driver returns bigint as a string) — per `phase-03-videos/TD-03`
- Generate `nestjs-project/src/database/migrations/<timestamp>-CreateVideos.ts` via the TypeORM CLI — PK, `UNIQUE(public_id)`, `INDEX(channel_id)`, `INDEX(status)`, a CHECK constraint pinning `status` to the four allowed values, and `ON DELETE RESTRICT` on the channel foreign key
- Register `Video` in `TypeOrmModule.forFeature([...])` inside `nestjs-project/src/videos/videos.module.ts` and import `VideosModule` in `nestjs-project/src/app.module.ts`, with `ChannelsModule` imported so the channel relation resolves
- Extend `nestjs-project/src/test/create-test-data-source.ts` — add `Video` to the entity array and `DELETE FROM "videos"` to `cleanAllTables()`, ordered before `channels` so the foreign key is satisfied

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | UUID and timestamp defaults, `status` default of `draft`, the `public_id` unique constraint, the status CHECK constraint, and `size_bytes` round-tripping as a number |
| `src/database/migrations.integration-spec.ts` | Integration | `runMigrations` creates `videos` with its indexes; `undoLastMigration` removes it — extending the existing suite |
| `src/videos/videos.module.spec.ts` | Unit | `VideosModule` resolves its dependencies |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `videos` exists with every column, index, and constraint from the Data Model in Technical Specifications
- `migration:revert` drops the table cleanly, and `migration:run` re-creates it
- Inserting a `public_id` that already exists raises a unique violation; inserting an unknown `status` raises a check violation
- Deleting a channel that still owns videos is rejected by the `RESTRICT` foreign key
- `cleanAllTables()` removes `videos` rows, so integration suites do not leak state
- `npx tsc --noEmit` exits 0 and `npm run lint` is clean

---

### SI-03.3 — Implement the S3 Storage Abstraction with a Dual Endpoint

**Description:** Wrap the S3 client behind a `StorageService` interface that owns multipart upload, object reads and writes, and presigned URL generation, resolving the browser-facing and container-facing endpoints separately so each caller receives a URL its own network can reach.

**Technical actions:**

- Create `nestjs-project/src/videos/storage/storage.types.ts` and `nestjs-project/src/videos/storage/storage.service.ts` — the `StorageService` interface plus `CompletedPart = { partNumber: number; etag: string }`, abstracting multipart (`createMultipartUpload`, `createPartUploadUrl`, `completeMultipartUpload`, `abortMultipartUpload`), object access (`headObject`, `getObject`, `putObject`, `deleteObject`), and reads (`getPresignedReadUrl`) — per `phase-03-videos/TD-03`
- Create `nestjs-project/src/videos/storage/s3-storage.service.ts` implementing that interface over `@aws-sdk/client-s3`, constructing **two** `S3Client` instances — one bound to `storage.endpoint` and one to `storage.publicEndpoint` — both with `forcePathStyle: true` and with `requestChecksumCalculation` / `responseChecksumValidation` set to `WHEN_REQUIRED` so MinIO accepts the requests — per `phase-03-videos/TD-10`
- Have `getPresignedReadUrl(key, expiresIn?, downloadName?, internal = false)` sign against the endpoint the caller needs: the public client by default (browser-safe) and the internal client when `internal` is `true` (the worker's FFmpeg input) — per `phase-03-videos/TD-10`
- Sort `MultipartUpload.Parts` ascending by `PartNumber` before sending `CompleteMultipartUploadCommand`, and map S3 errors surfacing an unreachable endpoint to a `StorageUnavailableException` — per `phase-03-videos/TD-02`
- Provide the service in `nestjs-project/src/videos/videos.module.ts` through a `useFactory` provider that injects `ConfigType<typeof storageConfig>`, binding the `StorageService` token to `S3StorageService`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/storage/storage.service.spec.ts` | Unit | Command shape per method, parts sorted before completion, and `getPresignedReadUrl` selecting the public client by default and the internal client when `internal` is `true` |
| `src/videos/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO: create → upload parts → complete → `headObject` reports the exact byte size; `abortMultipartUpload` discards an incomplete upload; `putObject`/`getObject`/`deleteObject` round-trip; a presigned GET is fetchable over HTTP |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A full multipart cycle against the real MinIO service completes, and `headObject` returns the exact uploaded size
- `abortMultipartUpload` leaves no completed object behind
- A presigned read URL generated with `internal: false` resolves to the configured public host, and one generated with `internal: true` resolves to the internal host
- A ranged GET against a presigned URL returns `206` with a correct `Content-Range`
- No module outside `src/videos/storage/` imports `@aws-sdk/*`
- `npx tsc --noEmit` exits 0 and `npm run lint` is clean

---

### SI-03.4 — Add the Processing Queue and the Transactional Outbox

**Description:** Register the BullMQ queue and build the transactional outbox that guarantees every video leaving `draft` has a corresponding job, with a polling relay that dispatches pending rows idempotently.

**Technical actions:**

- Create `nestjs-project/src/videos/queue/video-processing.queue.ts` with the `VIDEO_PROCESSING_QUEUE` and `VIDEO_PROCESSING_JOB` constants and the job-option defaults (`attempts: 3`, exponential backoff at 30s, `lockDuration` 30 min, high `stalledInterval`, `maxStalledCount: 1`, `removeOnComplete`/`removeOnFail` age caps), and `nestjs-project/src/videos/queue/video-processing.types.ts` with the typed `VideoProcessingJob` payload `{ video_id, storage_key, event_id }` — per `phase-03-videos/TD-01`
- Register `BullModule.forRootAsync` (connection from `queue.config`, host `redis`) and `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` in `nestjs-project/src/videos/videos.module.ts` — per `phase-03-videos/TD-01`
- Create `nestjs-project/src/videos/queue/entities/video-processing-outbox.entity.ts` matching the Data Model, plus the migration `<timestamp>-CreateVideoProcessingOutbox.ts` with `UNIQUE(event_id)` and `INDEX(status, created_at)` — per `phase-03-videos/TD-09`
- Create `nestjs-project/src/videos/queue/video-processing-outbox.service.ts` exposing `enqueueInTransaction(manager, video)` which inserts a `pending` row (fresh `event_id`, payload pointer) using the caller's `EntityManager`, so it commits atomically with the status change — per `phase-03-videos/TD-09`
- Create `nestjs-project/src/videos/queue/video-processing-outbox.relay.ts` — a `@Interval`-driven relay that claims pending rows with a lease (`UPDATE ... WHERE status='pending' AND claimed_at IS NULL`), publishes with `jobId = event_id`, marks them `dispatched`, and after repeated failures marks them `failed` with `error_message`; expose `processPending(): Promise<number>` for deterministic test dispatch — per `phase-03-videos/TD-09`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/queue/video-processing-outbox.service.spec.ts` | Unit | `enqueueInTransaction` inserts a `pending` row with a generated `event_id` and a pointer payload |
| `src/videos/queue/video-processing-outbox.service.integration-spec.ts` | Integration | The row is committed by the caller's transaction and absent when that transaction rolls back |
| `src/videos/queue/video-processing-outbox.relay.spec.ts` | Unit | Dispatch passes `jobId = event_id`; a queue failure leaves the row `pending`; repeated failures mark it `failed` with `error_message` |
| `src/videos/queue/video-processing-outbox.relay.integration-spec.ts` | Integration | Against real Redis: `processPending()` publishes a real job, marks the row `dispatched`, is a no-op when re-run, and the claim lease prevents two concurrent relays from double-dispatching |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- The `video-processing` queue connects to the Compose `redis` service
- The outbox row is written **in the same transaction** as the video status change, and disappears when that transaction rolls back
- `processPending()` publishes pending rows and returns the number dispatched; a second call dispatches nothing
- A duplicated dispatch never creates two jobs for one `event_id`
- A Redis outage leaves rows `pending` rather than losing them, and a later `processPending()` publishes them
- `npx tsc --noEmit` exits 0 and `npm run lint` is clean

---

### SI-03.5 — Build the Presigned Multipart Upload API

**Description:** Expose the upload endpoints that pre-register a video as a `draft`, hand the client presigned part URLs, complete the upload with a verified size and an atomic status change plus outbox write, and abort an in-flight upload.

**Technical actions:**

- Create `nestjs-project/src/videos/dto/` — `create-video-upload.dto.ts`, `create-parts.dto.ts` (with nested `PartNumberDto`), `complete-upload.dto.ts` (with nested `CompletedPartDto`), and the response DTOs — all snake_case, class-validator decorated, with JSDoc supplying Swagger descriptions via the CLI plugin
- Add the Phase 03 domain exceptions to `nestjs-project/src/common/exceptions/domain.exception.ts` — `VideoNotFoundException` (404), `VideoForbiddenException` (403), `VideoNotDraftException` (409), `VideoNotReadyException` (409), `UploadIncompleteException` (422), `PayloadTooLargeException` (413), `UnsupportedMediaTypeException` (415), `StorageUnavailableException` (503) — per `phase-02-auth/TD-07`
- Create `nestjs-project/src/videos/videos.service.ts` with `initUpload`, `createPartUrls`, `completeUpload`, and `abortUpload`: resolve the caller's channel, generate `public_id` for the pre-registered `draft` row, compensate with `abortMultipartUpload` if the insert fails, enforce ownership and `draft` status, and on completion run `CompleteMultipartUpload` → `HeadObject` size check → a single transaction flipping `draft → processing` (guarded by `WHERE status = 'draft'`) and inserting the outbox row — per `phase-03-videos/TD-02`, `phase-03-videos/TD-09`, and `phase-03-videos/TD-11`
- Create `nestjs-project/src/videos/videos.controller.ts` with `POST /videos` (201), `POST /videos/:id/parts` (200), `POST /videos/:id/complete` (202), and `POST /videos/:id/abort` (204), each carrying `@ApiTags`, `@ApiOperation`, per-status `@ApiResponse` using `getSchemaPath(ApiErrorEnvelope)`, and `@ApiBearerAuth('access-token')`
- Apply `@Throttle({ default: { limit: 60, ttl: 60000 } })` to the upload endpoints so the global 10-req/min limiter does not throttle the upload flow — per `phase-02-auth/TD-08`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `public_id` generation and collision retry, storage compensation when the insert fails, ownership and status guards, the 413 path when `HeadObject` reports an oversized object, and the `409` when the guarded update matches no row |
| `src/videos/videos.service.integration-spec.ts` | Integration | init → parts → complete against real PostgreSQL, MinIO, and Redis: the row moves `draft → processing`, the outbox row is committed with it, the measured size is persisted, a duplicate complete returns `409`, and a concurrent complete yields exactly one success |
| `test/videos-upload.e2e-spec.ts` | E2E | The HTTP flow and its status codes — `201`/`200`/`202`/`204`, plus `401` unauthenticated, `403` for another channel's video, `404` unknown id, `409` on a repeat complete, and `413` when the stored object exceeds the limit |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` pre-registers the video as `draft` and returns `id`, `public_id`, `upload_id`, `part_size`, and `part_count`
- Video bytes never pass through the API — the endpoints only return metadata and presigned URLs
- `POST /videos/:id/complete` validates the real object size via `HeadObject` and returns `413 PAYLOAD_TOO_LARGE` when it exceeds 10GB
- Completion flips the status to `processing` and writes the outbox row in the **same** transaction
- A second completion returns `409 VIDEO_NOT_DRAFT`, and no second outbox row is written
- `channel_id` always comes from the authenticated user's channel, never from the request body
- A user who does not own the video receives `403 VIDEO_FORBIDDEN`
- The upload endpoints are not throttled by the global 10-req/min limit
- `npm test`, `npm run test:e2e`, `npx tsc --noEmit`, and `npm run lint` are all green

---

### SI-03.6 — Implement the FFmpeg Worker

**Description:** Run a dedicated worker process that consumes the processing queue, reads the video over a presigned internal URL, extracts duration and stream metadata, renders a thumbnail, and persists the result while driving the status to `ready` or `error`.

**Technical actions:**

- Create `nestjs-project/src/worker/main.ts` bootstrapping `NestFactory.createApplicationContext(WorkerModule)` — no HTTP listener, no global guard — with `enableShutdownHooks()` so FFmpeg children are killed on `SIGTERM`, and `nestjs-project/src/worker/worker.module.ts` importing only Config, TypeORM, the storage provider, the queue, and the processing providers — per `phase-03-videos/TD-06`
- Create `nestjs-project/src/videos/processing/media-probe.service.ts` and `thumbnail.service.ts`, both spawning `ffprobe`/`ffmpeg` through `child_process.spawn` with an **argv array** (no shell), enforcing a timeout with `SIGKILL` escalation and killing the child on shutdown; the probe parses `-print_format json -show_format -show_streams`, and the thumbnail renders one JPEG frame at ~10% of the duration — per `phase-03-videos/TD-07`
- Create `nestjs-project/src/videos/processing/video-processing.processor.ts` as a `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`: re-read the video from the database (the payload is a pointer), return early when its status is no longer `processing`, obtain the input via `getPresignedReadUrl(..., internal: true)`, probe, render the thumbnail, `putObject` it, confirm with `headObject`, then flip `processing → ready` with the extracted fields — per `phase-03-videos/TD-06` and `phase-03-videos/TD-10`
- Classify failures — transient storage or network errors retry, while an invalid or truncated input throws `UnrecoverableError` from `bullmq` and records `status = 'error'` with `error_code = 'INVALID_MEDIA'`; register an `@OnWorkerEvent('failed')` handler that records `PROCESSING_FAILED` once attempts are exhausted, and mark the outbox row `processed`/`failed` — per `phase-03-videos/TD-01`
- Point the `nestjs-worker` service at `node dist/worker/main.js` in `nestjs-project/compose.yaml`, mapping the worker's build to `Dockerfile.worker`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video-processing.processor.spec.ts` | Unit | A job for a video not in `processing` returns without side effects; the happy path persists duration, metadata and the thumbnail key; an invalid media error becomes `status = 'error'` with `INVALID_MEDIA` |
| `src/videos/processing/media-probe.service.integration-spec.ts` | Integration | Against the real 9.8MB fixture: `ffprobe` reports the expected duration, video codec, and resolution, and a truncated input is reported as a probe failure |
| `src/videos/processing/thumbnail.service.integration-spec.ts` | Integration | Against the real fixture: `ffmpeg` writes a non-empty JPEG whose magic bytes are valid |
| `src/videos/processing/video-processing.processor.integration-spec.ts` | Integration | End-to-end against PostgreSQL, MinIO, and Redis: an enqueued job drives `processing → ready`, the thumbnail object exists at the expected key, and re-running the same job is a no-op |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- The `nestjs-worker` container starts via Compose and consumes jobs from `video-processing`
- `duration_seconds`, `metadata`, `mime_type`, and `thumbnail_key` are persisted correctly and match a manual `ffprobe` reading of the same fixture
- `videos/{id}/thumbnail.jpg` exists in MinIO after processing
- The video reaches `ready` only after the thumbnail is confirmed present in storage
- An invalid media file moves the video to `error` with `error_code = 'INVALID_MEDIA'` and is not retried
- The worker never downloads the whole file to disk — FFmpeg reads the presigned internal URL
- `npm test`, `npx tsc --noEmit`, and `npm run lint` are green

---

### SI-03.7 — Serve Streaming, Download, Thumbnail, and Public Metadata

**Description:** Deliver playback and download by redirecting to presigned storage URLs, so the storage tier serves range requests natively and the API never carries video bytes.

**Technical actions:**

- Add the read methods to `nestjs-project/src/videos/videos.service.ts` — `getPublicMetadata`, `getStreamUrl`, `getDownloadUrl`, `getThumbnailUrl`, and `getPlaybackUrl` — each resolving the video by `public_id`, requiring `status = 'ready'` (otherwise `VideoNotReadyException`) and presigning the appropriate object with a sanitized `Content-Disposition` filename for downloads — per `phase-03-videos/TD-08`
- Add the read routes to `nestjs-project/src/videos/videos.controller.ts` — `GET /videos/:public_id`, `/stream`, `/thumbnail`, and `/playback-url` marked `@Public()`, and `GET /videos/:public_id/download` **without** `@Public()` so the global guard requires a JWT — per `phase-03-videos/TD-08`
- Return `302` with a `Location` header for stream, download, thumbnail, and playback-url, using `@Res({ passthrough: false })` or a redirect response; the API must not implement `Content-Range` or proxy bytes
- Create `nestjs-project/src/videos/dto/video-public-response.dto.ts` exposing only `public_id`, `title`, `status`, `duration_seconds`, `thumbnail_url`, and `created_at` — never the internal `id` or `storage_key`
- Document every new route with `@ApiOperation` and per-status `@ApiResponse` (including `302`, `404`, `409`, and `401` on download), and add `@ApiBearerAuth('access-token')` to the download route only

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Each read method presigns the correct key and disposition; a non-`ready` video raises `VideoNotReadyException`; the public metadata DTO omits `id` and `storage_key` |
| `test/videos-stream.e2e-spec.ts` | E2E | `GET /videos/:public_id` returns 200 for a ready video and 404 otherwise; `/stream` returns 302 with a presigned `Location` that answers `206` to a ranged request and `416` to an unsatisfiable one; `/thumbnail` redirects; a non-ready video returns 409; `/download` returns 401 without a JWT and 302 with an attachment disposition when authenticated |

**Dependencies:** SI-03.3, SI-03.6

**Acceptance criteria:**

- Playback starts without transferring the whole file — a ranged request through the redirect returns `206 Partial Content` from MinIO
- `GET /videos/:public_id/stream` responds `302` and carries no video bytes
- `GET /videos/:public_id/download` returns `401` without a JWT and `302` with an attachment `Content-Disposition` when authenticated
- `GET /videos/:public_id/thumbnail` is public and returns `404` while no thumbnail exists
- Each video is reachable through its own unique `public_id` URL, with no collisions
- The public metadata response never leaks the internal `id` or `storage_key`
- `npm test`, `npm run test:e2e`, `npx tsc --noEmit`, and `npm run lint` are all green

---

### SI-03.8 — Harden Cleanup, Reconciliation, and Failure Handling

**Description:** Close the production gaps around abandoned uploads, stranded processing jobs, repeated completion, and unrecoverable media failures.

**Technical actions:**

- Create `nestjs-project/src/videos/processing/failure-policy.ts` exporting `classifyFailure(err): 'recoverable' | 'unrecoverable'` and the `UNRECOVERABLE_CODES` list, so the processor's retry decision lives in one testable place — per `phase-03-videos/TD-01`
- Create `nestjs-project/src/videos/maintenance/upload-cleanup.service.ts` — a scheduled sweep that aborts multipart uploads older than 24h and marks `draft` rows inactive beyond that window as `error` with `error_code = 'UPLOAD_EXPIRED'`, logging each row it touches — per `phase-03-videos/TD-05`
- Create `nestjs-project/src/videos/maintenance/processing-reconciler.service.ts` — a scheduled sweep that finds videos stuck in `processing` beyond a threshold with no active job in the queue and either re-enqueues them through the outbox or marks them `error` with `PROCESSING_STALLED`
- Confirm the completion path is safe under concurrency and replay: the status update is guarded by `WHERE status = 'draft'`, and repeated outbox dispatch is a no-op because `jobId = event_id`
- Register the maintenance providers in `nestjs-project/src/videos/videos.module.ts` and gate their scheduling behind configuration so they do not fire during unit tests

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/failure-policy.spec.ts` | Unit | Storage and network errors classify as recoverable; invalid-media and truncated-input errors classify as unrecoverable |
| `src/videos/maintenance/upload-cleanup.service.spec.ts` | Unit | Only stale drafts are selected; expired rows become `error` with `UPLOAD_EXPIRED` |
| `src/videos/maintenance/upload-cleanup.service.integration-spec.ts` | Integration | Against real MinIO and PostgreSQL: an aged multipart upload is aborted and its draft row transitions to `error` |
| `src/videos/maintenance/processing-reconciler.service.spec.ts` | Unit | A stale `processing` video with no active job is re-enqueued; one that has exhausted its attempts becomes `error` with `PROCESSING_STALLED` |
| `src/videos/videos.service.integration-spec.ts` | Integration | The failure matrix rows for duplicate completion, concurrent completion, and completion with missing parts — extending the SI-03.5 suite |

**Dependencies:** SI-03.5, SI-03.6

**Acceptance criteria:**

- An abandoned multipart upload is aborted and its draft row expires to `error` with `UPLOAD_EXPIRED`
- A video stuck in `processing` is either re-enqueued or moved to `error` with `PROCESSING_STALLED`
- Two concurrent completions produce exactly one success and one `409`, with exactly one outbox row
- An invalid media file is not retried indefinitely
- Every row in the failure matrix in Technical Specifications is covered by a passing test
- `npx tsc --noEmit` exits 0 and `npm run lint` is clean

---

### SI-03.9 — Complete the Test Pyramid and Verify the Definition of Done

**Description:** Fill the remaining test layers, add the 10GB upload acceptance script and its evidence, and run the full Definition of Done.

**Technical actions:**

- Add `nestjs-project/scripts/acceptance/upload-10gb.sh` — create a user, channel, and token; `POST /videos`; upload parts in parallel through the presigned URLs; `POST .../complete`; poll `GET /videos/:public_id` until `ready`; and sample API latency throughout to evidence that the API stays responsive — per `phase-03-videos/TD-02`
- Measure and record the acceptance evidence: API latency during the upload (`curl` against the health endpoint), `docker stats` memory for `nestjs-api`, total upload time, the final `ready` status with duration and thumbnail, a ranged streaming request, and a downloaded file whose size matches the source
- Close any remaining coverage gaps across unit, integration, and e2e for the SIs above, and confirm integration and e2e suites both run with `--runInBand`
- Run the full Definition of Done inside the container: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, and `npm run lint`
- Record the acceptance evidence in `docs/phases/phase-03-videos/progress.md`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/test/create-test-data-source.ts` | Integration | `cleanAllTables()` covers `videos` and `video_processing_outbox` so no suite leaks state |
| `nestjs-project/scripts/acceptance/upload-10gb.sh` | Acceptance (manual) | A ~10.8GB upload completes through the presigned multipart flow with the API remaining responsive, then reaches `ready` with a thumbnail |

**Dependencies:** SI-03.1 through SI-03.8

**Acceptance criteria:**

- The full unit + integration suite passes with `--runInBand`
- The full e2e suite passes
- `npx tsc --noEmit` exits with code 0
- `npm run lint` is clean
- The ~9GB and ~10.8GB fixtures both upload successfully, and the API answers requests with stable latency **during** the transfer
- The uploaded video reaches `ready` with a correct duration and a thumbnail present
- Streaming begins without a full download, and the downloaded file's size matches the source
- No large fixture is committed to the repository

---

### SI-03.10 — Update the AI Documentation and Close the Phase

**Description:** Bring `CLAUDE.md` in line with the code that now exists, re-export the OpenAPI contract, and finish the phase artifacts.

**Technical actions:**

- Update the root `CLAUDE.md` and `nestjs-project/CLAUDE.md` with the real state of the code: the `videos/` module and its status lifecycle, the new endpoints, the new infrastructure (`minio`, `redis`, `nestjs-worker` — always referenced by Compose service name), how the worker runs and consumes through the internal presigned endpoint, and the phase rules (video never transits the API; storage keys are server-assigned; enqueue happens via the outbox after commit; `@Public()` appears only on read endpoints)
- Re-export the OpenAPI contract with `npm run openapi:export` and confirm the new endpoints and error codes appear
- Update `docs/phases/phase-03-videos/progress.md` to reflect the final per-SI status and test results
- Walk the acceptance criteria from `docs/project-plan.md` for Fase 03 item by item and confirm each is satisfied by code that exists

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/openapi-export.integration-spec.ts` | Integration | The exported document includes the video routes and their error responses — extending the existing suite |

**Dependencies:** SI-03.1 through SI-03.9

**Acceptance criteria:**

- Every file and behaviour named in `CLAUDE.md` exists in the code — no aspirational documentation
- `openapi.json` includes all video endpoints with their documented status codes
- `progress.md` reflects the true per-SI status and test results
- The Fase 03 acceptance criteria are each traceable to working code
- No tracked file references local-only input directories

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier — used in foreign keys and storage keys, never exposed publicly |
| public_id | varchar(11) | unique, not null | URL-facing identifier, base62 generated with `crypto.randomBytes` |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE RESTRICT` | Owning channel |
| title | varchar(255) | not null | Supplied when the upload starts |
| status | varchar | not null, default `draft`, CHECK in (`draft`,`processing`,`ready`,`error`) | Lifecycle state |
| storage_key | varchar(512) | not null | `videos/{id}/source.mp4` — server-assigned |
| thumbnail_key | varchar(512) | null | `videos/{id}/thumbnail.jpg`, written by the worker |
| upload_id | varchar(255) | null | S3 multipart `UploadId`; cleared on complete or abort |
| duration_seconds | integer | null | Extracted by `ffprobe` |
| size_bytes | bigint | null | Measured by `HeadObject`, not the client's claim; bigint transformer |
| mime_type | varchar(127) | null | e.g. `video/mp4` |
| metadata | jsonb | null | Aggregated `ffprobe` output — codecs, resolution, bitrate |
| error_code | varchar(64) | null | Catalog code when `status = 'error'` |
| error_message | text | null | Diagnostic detail |
| created_at | timestamptz | not null, default now() | |
| updated_at | timestamptz | not null, default now() | |

**Relations:** Video → Channel (many-to-one, `@JoinColumn({ name: 'channel_id' })`)
**Indexes:** `(public_id)` — unique; `(channel_id)`; `(status)`

#### VideoProcessingOutbox

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| event_id | uuid | unique, not null | Becomes the BullMQ `jobId`, which is what makes dispatch idempotent |
| video_id | uuid | FK → videos.id, not null | |
| status | varchar(20) | not null, default `pending` | `pending` → `dispatched` → `processed` \| `failed` |
| attempts | integer | not null, default 0 | Relay dispatch attempts |
| payload | jsonb | not null | `{ video_id, storage_key }` — a pointer; the consumer re-reads the database |
| claimed_at | timestamptz | null | Claim lease, so concurrent relays cannot both take a row |
| dispatched_at | timestamptz | null | |
| processed_at | timestamptz | null | |
| error_message | text | null | Dispatch failure detail (not processing failure) |
| created_at | timestamptz | not null, default now() | |

**Relations:** VideoProcessingOutbox → Video (many-to-one, `@JoinColumn({ name: 'video_id' })`)
**Indexes:** `(event_id)` — unique; `(status, created_at)`; `(video_id)`

**Status semantics:** the row is inserted **in the same transaction** as the `draft → processing` update. The relay publishes it to BullMQ carrying `jobId = event_id` and marks it `dispatched`. The worker marks it `processed` or `failed` at the end. Rows left `pending` are re-dispatched on a later tick, which is safe because a duplicate `jobId` is a no-op.

---

### API Contracts

#### POST /videos (SI-03.5)

Pre-registers the video as a `draft` and opens the multipart upload.

**Request headers:**
- Authorization: Bearer `<access_token>`

**Request body:**
- title: string, required — 1..255 characters
- filename: string, required — 1..255 characters; recorded for display only, never used to build a storage key
- size_bytes: integer, required — 1..10737418240
- mime_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`
- part_size: integer, optional — 5MiB..64MiB, defaults to 8MiB

**Response 201:**
- id: string (uuid)
- public_id: string (11 characters)
- title: string
- status: string — `draft`
- upload_id: string
- part_size: integer
- part_count: integer
- created_at: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: the body fails schema validation, including a `part_size` below 5MiB
- 401 UNAUTHORIZED: missing or invalid JWT
- 413 PAYLOAD_TOO_LARGE: `size_bytes` exceeds the 10GB limit
- 415 UNSUPPORTED_MEDIA_TYPE: `mime_type` is outside the allowlist
- 503 STORAGE_UNAVAILABLE: object storage is unreachable

---

#### POST /videos/:id/parts (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Request body:**
- part_numbers: integer[], required — non-empty, each 1..10000

**Response 200:**
- parts: array of `{ part_number: integer, url: string, expires_in: integer }`

**Error responses:**
- 400 VALIDATION_ERROR: `part_numbers` empty or out of range
- 401 UNAUTHORIZED
- 403 VIDEO_FORBIDDEN: the video belongs to another channel
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_DRAFT: the video is no longer in `draft`
- 503 STORAGE_UNAVAILABLE

---

#### POST /videos/:id/complete (SI-03.5)

Runs `CompleteMultipartUpload`, verifies the real object size with `HeadObject`, then commits the status change and the outbox row in one transaction.

**Request headers:**
- Authorization: Bearer `<access_token>`

**Request body:**
- parts: array of `{ part_number: integer, etag: string }`, required — must cover the uploaded parts

**Response 202:**
- id: string (uuid)
- public_id: string
- status: string — `processing`

**Error responses:**
- 400 VALIDATION_ERROR: the part list is empty, unordered, or malformed
- 401 UNAUTHORIZED
- 403 VIDEO_FORBIDDEN
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_DRAFT: a repeated or concurrent completion, or a video not in `draft`
- 413 PAYLOAD_TOO_LARGE: `HeadObject` reports a size above 10GB
- 422 UPLOAD_INCOMPLETE: `CompleteMultipartUpload` failed because parts are missing or an ETag is wrong
- 503 STORAGE_UNAVAILABLE

---

#### POST /videos/:id/abort (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 204:** No content.

**Error responses:**
- 401 UNAUTHORIZED
- 403 VIDEO_FORBIDDEN
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_DRAFT

---

#### GET /videos/:public_id (SI-03.7)

**Response 200:**
- public_id: string
- title: string
- status: string
- duration_seconds: integer | null
- thumbnail_url: string | null — `/videos/{public_id}/thumbnail`
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:public_id/stream (SI-03.7)

Public. Responds `302 Found` with `Location` set to a presigned GET URL (default TTL 1h). The client follows the redirect and issues `Range` requests directly against the storage, which answers `206`/`416` natively; the API implements neither `Content-Range` nor byte proxying.

**Response 302:** `Location: <presigned GET url>`

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: the video has not reached `ready`
- 503 STORAGE_UNAVAILABLE

---

#### GET /videos/:public_id/download (SI-03.7)

**JWT required** — any authenticated user; ownership is not required, because visibility and publishing belong to a later phase.

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 302:** `Location: <presigned GET url with ResponseContentDisposition: attachment; filename="<sanitized title>.mp4">`

**Error responses:**
- 401 UNAUTHORIZED: missing or invalid JWT
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY
- 503 STORAGE_UNAVAILABLE

---

#### GET /videos/:public_id/thumbnail (SI-03.7)

Public. Responds `302` to a presigned GET of `videos/{id}/thumbnail.jpg`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id`, or no thumbnail yet
- 503 STORAGE_UNAVAILABLE

---

#### GET /videos/:public_id/playback-url (SI-03.7)

Public. Issues a fresh presigned GET so a player can recover after its previous URL expires. Same mechanism and error set as `/stream`.

**Response 200:**
- url: string
- expires_in: integer

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY
- 503 STORAGE_UNAVAILABLE

---

#### Validation Rules — Upload

| Field | Rule | Error message |
|-------|------|---------------|
| title | `@IsString() @IsNotEmpty() @MaxLength(255)` | title should not be empty |
| filename | `@IsString() @IsNotEmpty() @MaxLength(255)` | filename should not be empty |
| size_bytes | `@IsInt() @Min(1) @Max(10737418240)` | size_bytes must not be greater than 10737418240 |
| mime_type | `@IsIn(['video/mp4','video/webm','video/quicktime'])` | mime_type must be one of the following values: video/mp4, video/webm, video/quicktime |
| part_size | `@IsInt() @Min(5242880) @Max(67108864)` | part_size must not be less than 5242880 |
| part_numbers | `@IsArray() @ArrayNotEmpty()`, items `@IsInt() @Min(1) @Max(10000)` | part_numbers should not be empty |
| parts[].part_number | `@IsInt() @Min(1) @Max(10000)` | part_number must not be greater than 10000 |
| parts[].etag | `@IsString() @IsNotEmpty()` | etag should not be empty |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|---------------|-------|
| POST /videos | | ✓ | `channel_id` comes from the JWT's user, never from the body |
| POST /videos/:id/parts | | ✓ | Ownership required |
| POST /videos/:id/complete | | ✓ | Ownership required; also verifies size via `HeadObject` |
| POST /videos/:id/abort | | ✓ | Ownership required |
| GET /videos/:public_id | ✓ | ✓ | `@Public()` |
| GET /videos/:public_id/stream | ✓ | ✓ | `@Public()` — 302 to a presigned GET |
| GET /videos/:public_id/thumbnail | ✓ | ✓ | `@Public()` |
| GET /videos/:public_id/playback-url | ✓ | ✓ | `@Public()` — presign refresh |
| GET /videos/:public_id/download | | ✓ | JWT required; any authenticated user, ownership not required |

Ownership is enforced by `VideosService` resolving the video's `channel_id` and comparing it with the authenticated user's channel, raising `VideoForbiddenException` (403) on mismatch. Everything is protected by default through the global `JwtAuthGuard`; only the read routes above carry `@Public()`.

---

### Error Catalog

The response envelope is inherited from Phase 02 and is unchanged: `{ statusCode: number, error: string, message: string }`. The `error` field carries the domain code below. Phase 03 only **adds** codes.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown `id` or `public_id` |
| VIDEO_FORBIDDEN | 403 | You do not own this video | The video's channel differs from the caller's |
| VIDEO_NOT_DRAFT | 409 | Video is not in draft status | parts/complete/abort against a video not in `draft`, including a repeated complete |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | stream/download/thumbnail-url requested while status ≠ `ready` |
| UPLOAD_INCOMPLETE | 422 | Upload cannot be completed | `CompleteMultipartUpload` rejected the part list |
| PAYLOAD_TOO_LARGE | 413 | File exceeds 10GB limit | Declared `size_bytes`, or the size measured by `HeadObject`, exceeds the limit |
| UNSUPPORTED_MEDIA_TYPE | 415 | Media type not allowed | `mime_type` outside the allowlist |
| STORAGE_UNAVAILABLE | 503 | Object storage unavailable | The storage endpoint is unreachable |
| UPLOAD_EXPIRED | 500* | Upload expired | A `draft` row abandoned beyond the retention window |
| UPLOAD_ABORTED | 500* | Upload aborted by the client | The abort endpoint was called |
| PROCESSING_FAILED | 500* | Video processing failed | Retries exhausted |
| PROCESSING_STALLED | 500* | Video processing stalled | Reconcile found no active job and no attempts left |
| INVALID_MEDIA | 500* | Invalid media file | Unrecoverable `ffprobe`/`ffmpeg` failure |

> Codes marked `500*` are **state** codes persisted in `videos.error_code`, not HTTP responses. They are listed for traceability and for the reconciler's and worker's use.

---

### Events/Messages

The delivery chain is **API (transaction) → outbox → relay → BullMQ/Redis → worker**.

#### video.process

**Payload:**

```json
{
  "video_id": "uuid",
  "storage_key": "videos/{video_id}/source.mp4",
  "event_id": "uuid"
}
```

**Producer:** `VideoProcessingOutboxRelay` (`src/videos/queue/video-processing-outbox.relay.ts`) — publishes rows in `pending`
**Consumer:** `VideoProcessingProcessor` (`src/videos/processing/video-processing.processor.ts`)
**Trigger:** `POST /videos/:id/complete` writes the outbox row in the same transaction that flips `draft → processing`; the relay publishes afterwards
**Delivery semantics:** at-least-once — the consumer re-reads the `videos` row by `video_id` and never trusts the payload for state

**Outbox pipeline:**

| Step | Who | What happens |
|------|-----|--------------|
| 1. Write | `VideosService.completeUpload` | One transaction: `UPDATE videos SET status='processing' WHERE id=:id AND status='draft'` plus `INSERT INTO video_processing_outbox (status='pending')` |
| 2. Dispatch | `VideoProcessingOutboxRelay` | Claims `pending` rows with a lease, `queue.add(..., { jobId: event_id })`, marks them `dispatched` |
| 3. Consume | `VideoProcessingProcessor` | Processes the video, then marks the outbox row `processed` or `failed` |

**Idempotency:**
- `jobId = event_id` — a duplicated dispatch of the same event is a no-op in BullMQ
- The consumer re-reads the video; if its status is no longer `processing` it returns without side effects
- Re-execution after a crash starts from scratch; overwriting the thumbnail is safe, and `ready` is only written after `headObject` confirms the thumbnail exists

**Retry and failure:**
- **Dispatch:** `attempts` is tracked on the row; persistent failure sets `status='failed'` with `error_message`
- **Processing:** `attempts: 3` with exponential backoff (30s, 2m, 10m)
- Recoverable (transient storage slowness, timeouts) → retry
- Unrecoverable (invalid codec, truncated file) → throw `UnrecoverableError` so the job fails immediately without retries, and record `status='error'` with `error_code='INVALID_MEDIA'`
- Attempts exhausted → the BullMQ `failed` event sets `status='error'` with `error_code='PROCESSING_FAILED'`

**Worker configuration for long jobs:** `lockDuration` 30 minutes, high `stalledInterval`, `maxStalledCount: 1`, and `removeOnComplete`/`removeOnFail` age caps.

**Relay configuration:** poll interval 2–5s with a 60s claim lease (safe across API instances), batch of 25 rows per tick, backoff on dispatch failure, and a public `processPending(): Promise<number>` for deterministic dispatch in integration and e2e tests.

---

### Failure Matrix

| Scenario | Expected |
|----------|----------|
| Duplicate job for one video | One processing run; the second is rejected by `jobId = event_id` |
| Worker restarts mid-job | Job stalls, is retried, and `ready` is only written at the end |
| Parts missing at completion | `422 UPLOAD_INCOMPLETE` |
| `HeadObject` reports more than 10GB | `413 PAYLOAD_TOO_LARGE` |
| `ffmpeg` meets an invalid codec | `status='error'`, `error_code='INVALID_MEDIA'`, no retry |
| Storage unreachable during probe | Retried as a recoverable failure |
| Redis down at completion | The outbox row stays `pending`; the relay publishes when Redis returns — nothing is lost |
| API dies between the outbox insert and the relay | The orphaned `pending` row is re-dispatched on the next tick |
| Two relays running | The claim lease plus `jobId = event_id` yields a single dispatch |
| Two concurrent completions | One success, one `409`; exactly one outbox row |

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
│   └── SI-03.4
└── SI-03.3

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5
    └── SI-03.6
        └── SI-03.7

SI-03.5 + SI-03.6
└── SI-03.8

SI-03.1 … SI-03.8
└── SI-03.9
    └── SI-03.10
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10

Correction note: SI-03.3 (storage) and SI-03.4 (queue/outbox) both depend only on SI-03.1 and SI-03.2 respectively, so they may proceed in either order or concurrently. SI-03.5 is the first SI that requires all three of storage, entity, and outbox, which is why it sits after both branches.

---

## Deliverables

- [ ] Object storage, queue, and worker running as Compose services alongside the backend
- [ ] Upload of videos up to 10GB without the API carrying video bytes, with the video pre-registered as a draft when the upload starts
- [ ] Multipart completion that verifies the real object size and rejects anything above the limit
- [ ] Automatic processing after upload: duration and stream metadata extracted, thumbnail generated from a frame
- [ ] Video status lifecycle persisted in the database (`draft → processing → ready | error`)
- [ ] Unique public URL per video, with no collisions
- [ ] Streaming that plays without a full download, using range requests served by the storage
- [ ] Download available to authenticated users
- [ ] Enqueue guaranteed by a transactional outbox, so no committed video is left without a job
- [ ] Video table created by a migration and bound to the owning channel
- [ ] Every failure-matrix scenario covered by a passing test
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint is clean (`docker compose exec nestjs-api npm run lint`)
- [ ] `CLAUDE.md` updated and consistent with the code
- [ ] `progress.md` reflects the final per-SI status and test results
