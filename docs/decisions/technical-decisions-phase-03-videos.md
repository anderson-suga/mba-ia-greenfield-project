---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-14
scope_description: "Video upload and processing for StreamTube: background job queue, large-file upload strategy, object storage usage, public URL generation, video status lifecycle, worker execution model, FFmpeg-based metadata and thumbnail extraction, streaming and download delivery, enqueue reliability, Docker networking for storage, and real object size validation."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — video module (entity, migration, service, controller), storage abstraction over S3/MinIO, queue + transactional outbox, dedicated worker entrypoint, FFmpeg/ffprobe integration, and the new Compose infrastructure (MinIO, Redis, `nestjs-worker`).
- `next-frontend/` — No open decision in this document. The video interface is explicitly out of scope for Phase 03; the frontend consumes the contracts fixed here in a later phase.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend
**Capability:** Serviço de processamento em segundo plano (filas)
**Context:** `docs/project-plan.md` leaves the queue technology explicitly open ("Message Queue (TBD)" in `CLAUDE.md`). This is the only genuinely open stack decision of the phase. Video processing is a long-running job (FFmpeg on files up to 10GB) that must survive API restarts, retry transient failures, and avoid duplicate processing. The choice drives the Compose footprint, the retry semantics, and how the worker is supervised.
**Options:**

### Option A: BullMQ + Redis
Dedicated Redis-backed job queue with a first-party NestJS integration (`@nestjs/bullmq`).
- **Pros:** Official NestJS module with idiomatic `@Processor`/`WorkerHost` support. Native retry with exponential backoff, `attempts`, stalled-job recovery (`lockDuration`, `stalledInterval`, `maxStalledCount`), and `jobId`-based deduplication. `job.discard()` gives explicit control over unrecoverable failures. Redis container is ~20MB. Largest ecosystem and documentation surface.
- **Cons:** Adds one infrastructure container. Job payloads must stay small (pointers, not documents). Redis persistence must be understood — a flush loses queued jobs unless the outbox (TD-09) re-dispatches them.

### Option B: RabbitMQ via `@nestjs/microservices`
Message broker with the NestJS transport layer.
- **Pros:** Mature broker; strong routing and dead-letter-exchange primitives; durable by default.
- **Cons:** `@nestjs/microservices` models RPC and events, not a job queue — retry, delayed backoff, and stalled-job visibility must be hand-built. Container is ~100MB+. Ack semantics are manual. No stalled-job recovery, which is exactly the failure mode of an FFmpeg worker that dies mid-job.

### Option C: pg-boss (PostgreSQL-backed queue)
Job queue built on the existing PostgreSQL instance.
- **Pros:** Zero new containers — reuses the `db` service already in Compose. Transactional enqueue in the same database as the domain data.
- **Cons:** No NestJS integration; a wrapper and lifecycle management would be written in-house. Stall semantics are less mature than BullMQ's. Maintenance of the queue falls entirely on this project. Only wins if "no new infrastructure" were a hard constraint, which it is not.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option with a first-party NestJS module *and* the long-job primitives this phase actually needs (lock duration, stalled recovery, discard). The retry policy required by TD-09 maps directly onto BullMQ's `attempts` + `backoff` + `failed` event.
**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq, bullmq, ioredis

---

## TD-02: Large File Upload Strategy (up to 10GB)

**Scope:** Backend
**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
**Context:** The acceptance criteria require uploading up to 10GB "sem travar" the API. Buffering the body in the API process — even streamed through a proxy — holds a connection and a worker slot for the entire transfer, and a single 10GB request would exhaust memory or saturate the Node event loop. The video bytes must never transit the API. The video row must also exist as a `draft` *before* the bytes land, so the upload has an owner and a storage key from the first request.
**Options:**

### Option A: Presigned S3 multipart upload (client → storage directly)
The API issues presigned `UploadPart` URLs; the client PUTs each part straight to MinIO/S3 in parallel, then calls `complete`.
- **Pros:** Zero video bytes through the API — the API only signs URLs and records metadata, so response latency is independent of file size. Native resumability (parts can be re-sent independently). Designed by S3 for objects of this scale. Parallel part uploads saturate the client's bandwidth rather than the API's. Supports the draft-first flow naturally: `CreateMultipartUpload` yields an `upload_id` stored on the `draft` row.
- **Cons:** More endpoints (init / parts / complete / abort) and more client-side logic. Multipart has hard rules the client must respect: every part except the last must be ≥5MiB, and a maximum of 10,000 parts. Abandoned uploads leak parts until aborted, which needs a cleanup policy (TD-11 companion).

### Option B: Single presigned PUT
One presigned `PutObject` URL for the whole file.
- **Pros:** Simplest possible flow — one signature, one PUT, no part bookkeeping or completion call.
- **Cons:** S3 caps a single PUT at 5GB, so it cannot satisfy the 10GB requirement at all. No resumability: a dropped connection at 9GB restarts from zero. This option is disqualified by the acceptance criteria rather than by preference.

### Option C: Stream the upload through the API
Accept `multipart/form-data` on a NestJS endpoint and pipe the request stream to storage.
- **Pros:** The API controls the whole flow and can validate bytes as they pass; storage credentials never leave the server.
- **Cons:** Directly contradicts the "sem travar a API" criterion. Each concurrent upload pins an API connection and a Node worker for the full duration; the process becomes the bottleneck and the blast radius of one large upload includes every other request. This is the failure mode the phase explicitly calls out as automatic rejection.

**Recommendation:** **Option A (presigned multipart)** — the only option that both meets the 10GB ceiling and keeps the API off the data path. Part size defaults to 8MiB (10GB ≈ 1,280 parts, comfortably under the 10,000 limit), with 5MiB as the S3-enforced floor.
**Decision:** A (Presigned S3 multipart upload)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Object Storage SDK and Key Layout

**Scope:** Backend
**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)
**Context:** Object storage is *not* an open decision — the project already specifies S3-compatible storage, run locally as MinIO in Docker and swappable for real S3 in production. What must be decided is how the SDK is used: which client, how path-style addressing is configured, and how object keys are derived. Keys are a security boundary: a key derived from client-supplied filenames enables path traversal and cross-tenant overwrite.
**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3`) behind a `StorageService` interface, keys derived from the internal UUID
`@aws-sdk/client-s3` with `forcePathStyle: true`, wrapped in a project-owned `StorageService` interface so no other module imports the SDK. Keys are `videos/{video_uuid}/source.mp4` and `videos/{video_uuid}/thumbnail.jpg`.
- **Pros:** `@aws-sdk/s3-request-presigner` produces presigned URLs for multipart, GET, and ranged GET with a mature, well-documented API. Path-style addressing makes MinIO a drop-in endpoint, so local and production differ only by configuration. Server-assigned keys eliminate traversal and overwrite entirely — the client never influences a key. A single bucket with per-video prefixes keeps the lifecycle rules (abort incomplete multipart) simple to express. The interface boundary contains the SDK and makes the storage layer unit-testable.
- **Cons:** AWS SDK v3 enables request/response checksum calculation by default, which has known friction with MinIO and must be configured explicitly. The SDK is a large dependency.

### Option B: MinIO SDK (`minio` npm package)
The vendor's own JavaScript client.
- **Pros:** Purpose-built for MinIO; simple API surface; no checksum friction with the MinIO server.
- **Cons:** Not portable to real S3 without a rewrite, while the project explicitly targets S3 in production. Presigned multipart support exists but is less battle-tested than the AWS presigner. Choosing it would couple the codebase to the local development storage.

### Option C: Raw HTTP calls against the S3 REST API with hand-rolled SigV4
Sign requests manually against the documented S3 API.
- **Pros:** No SDK dependency; total control over what is sent.
- **Cons:** SigV4 signing, multipart orchestration, and presigned URL generation are exactly the parts most likely to be subtly wrong, and errors surface as opaque 403s. Reimplementing a solved, security-sensitive problem with no benefit.

**Recommendation:** **Option A** — the AWS presigner is the mature path for multipart signatures, and path-style + `forcePathStyle` makes MinIO a genuine drop-in for S3. Keep the abstraction thin and in `videos/storage/` until a second consumer exists; extract to a shared `src/storage/` only when one appears.
**Decision:** A (AWS SDK v3 behind a StorageService interface, UUID-derived keys)

---

## TD-04: Public Video Identifier (Unique URL)

**Scope:** Backend
**Capability:** URL única por vídeo, sem conflito com outros vídeos
**Context:** Every video needs a stable public URL that is unique and does not collide with any other video. The internal primary key is a UUID used in foreign keys and storage keys; exposing it in public URLs leaks internal identifiers and couples the public surface to the database schema. The identifier must also be safe to place unescaped in a URL path.
**Options:**

### Option A: Separate `public_id` column — 11 characters, base62, generated with `crypto.randomBytes`
An opaque short identifier in its own `varchar(11)` UNIQUE column, generated from Node's built-in `crypto` and encoded to a URL-safe base62 alphabet.
- **Pros:** Decouples the public URL from the primary key, so the internal UUID stays private and can change without rewriting storage keys. 11 base62 characters is ~65 bits — collision probability is negligible at any realistic video count, and the `UNIQUE` constraint plus in-transaction retry makes correctness independent of probability. `crypto` is a Node built-in: no dependency, no module-format risk. Short, YouTube-like URLs.
- **Cons:** Requires a collision-handling path in the insert (retry with a SAVEPOINT). Slightly more code than reusing the primary key.

### Option B: `nanoid` package
A popular short-ID generator.
- **Pros:** Expressive, configurable alphabet and length; widely used.
- **Cons:** `nanoid` v4+ ships ESM-only, which breaks the project's CommonJS/`ts-jest` toolchain unless pinned to a legacy major. Adding a dependency (and a version pin) to obtain what `crypto.randomBytes` already provides is avoidable risk for zero benefit.

### Option C: Use the primary key UUID directly in the URL
Expose the existing `id` as the public identifier.
- **Pros:** Zero new columns, zero generation logic, uniqueness guaranteed by the database.
- **Cons:** Leaks internal identifiers and ties the public contract to the storage schema. UUIDs are long and unappealing in a shareable URL, and rotating or hiding a video's identity later becomes impossible without breaking every existing link.

**Recommendation:** **Option A** — the standard shape for this problem, with uniqueness enforced by the database rather than trusted from the generator. Generate with `crypto.randomBytes` mapped onto base62 and retry on the `UNIQUE` violation inside the existing transaction, following the SAVEPOINT pattern already used for channel nicknames.
**Decision:** A (11-character base62 `public_id` generated with `crypto.randomBytes`)

---

## TD-05: Video Status Lifecycle

**Scope:** Backend
**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"
**Context:** The video row must express, at any moment, whether it is awaiting upload, being processed, playable, or failed. The phase description pins the vocabulary to "rascunho → processando → pronto/erro". The design question is how much of the upload's internal progress to model as status: an in-flight upload is a genuinely different state from a draft that was never started.
**Options:**

### Option A: Four states — `draft → processing → ready | error`
Upload progress is tracked by the presence of a non-null `upload_id` on a `draft` row rather than by an additional status value.
- **Pros:** Matches the vocabulary in the phase description exactly, with no state that the acceptance criteria do not name. `upload_id` is already required to drive `UploadPart` and `CompleteMultipartUpload`, so it carries the information at no extra cost. Fewer states means fewer legal transitions to guard and test, and every status maps to a distinct, externally observable condition.
- **Cons:** "Draft, never started" and "draft, upload in progress" are indistinguishable from the status column alone and require reading `upload_id`.

### Option B: Five states — add `uploading` and `uploaded`
Model upload progress explicitly in the status column.
- **Pros:** The status column alone tells the full story; dashboards and admin views need no join to interpret a row.
- **Cons:** Introduces states the acceptance criteria do not require, plus transitions to validate and tests to write. S3 multipart uploads are progressed client-side, so the API only observes the start and the completion — an `uploading` state would be entered at init and left at complete, making it nearly synonymous with "draft with an `upload_id`". The extra state earns its keep only if the API can actually observe the intermediate progress, which it cannot.

### Option C: Separate `upload_sessions` entity
Move upload state into its own table related to the video.
- **Pros:** Cleanly separates the upload concern from the video concern; supports resumable uploads with several concurrent sessions and richer per-session metadata.
- **Cons:** A second table, migration, entity, and relationship to maintain for a feature (resume across sessions) that is not in this phase's scope. The video already owns `upload_id` and `storage_key`; splitting them adds indirection without changing what this phase must do.

**Recommendation:** **Option A (four states)** — it satisfies the required vocabulary without inventing states the API cannot observe. Enforce the transitions with a check constraint on the column so an invalid status cannot be persisted, and treat `upload_id IS NOT NULL` as "upload in progress".
**Decision:** A (Four states: draft → processing → ready | error)

---

## TD-06: Video Worker Execution Model

**Scope:** Backend
**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)
**Context:** Video processing must not compete with API request handling for CPU: FFmpeg saturating the cores would degrade API latency, which the phase explicitly measures. The worker needs the same entities, configuration, TypeORM connection, and storage abstraction as the API. The C4 container diagram already names a distinct "Video Worker (FFmpeg)" container.
**Options:**

### Option A: Same codebase, dedicated entrypoint, dedicated container
A second NestJS entrypoint (`src/worker/main.ts`) bootstrapped with `NestFactory.createApplicationContext` — no HTTP listener — running in its own `nestjs-worker` container built from `Dockerfile.worker`.
- **Pros:** Reuses the existing entities, configuration modules, TypeORM setup, and `StorageService` with no duplication. One `package.json` and one lockfile, so dependency versions cannot drift between API and worker. `createApplicationContext` omits the HTTP server entirely, so no ports are bound and the global JWT guard and throttler never apply. CPU-intensive FFmpeg work is isolated in its own container and cannot starve the API. Matches the container named in the architecture diagram.
- **Cons:** The worker image is larger because it carries FFmpeg. Both processes deploy together, so a worker-only change redeploys the API image too.

### Option B: Separate worker subproject
An independent Node project with its own `package.json`.
- **Pros:** Fully independent deploy and dependency lifecycle; the worker can be scaled and versioned on its own cadence.
- **Cons:** Duplicates entities, configuration, and the storage contract, which then drift silently — the classic failure of this layout. Two lockfiles and two dependency surfaces to keep aligned. No benefit at this project's scale.

### Option C: Process videos inside the API process
Register the BullMQ processor in `AppModule` and run FFmpeg in the API container.
- **Pros:** No new container, no new entrypoint, no image to build; the simplest possible wiring.
- **Cons:** FFmpeg is CPU-bound and would contend directly with request handling, which is precisely the "sem travar a API" property the phase is graded on. It also requires FFmpeg in the API image, making the request-serving image carry a large binary it never uses. Restarting the API would kill in-flight processing.

**Recommendation:** **Option A** — one codebase, two entrypoints, two containers. It is the only option that isolates CPU load while keeping a single source of truth for entities and configuration. Install FFmpeg only in `Dockerfile.worker`; the API image must not carry it.
**Decision:** A (Same codebase, dedicated entrypoint and container)

---

## TD-07: Metadata Extraction and Thumbnail Generation

**Scope:** Backend
**Capability:** Geração automática de thumbnail a partir de um frame do vídeo
**Context:** The worker must extract duration and stream metadata and render a JPEG thumbnail from a frame. It must do so without downloading a 10GB file to disk. The framing of the command matters for security: a filename or title flowing into a shell string is an injection vector.
**Options:**

### Option A: `child_process.spawn` with an argv array, FFmpeg binaries installed in the worker image
`spawn('ffprobe', [...])` and `spawn('ffmpeg', [...])` with an argument array, binaries installed in `Dockerfile.worker` via the distribution package.
- **Pros:** Passing arguments as an array bypasses the shell entirely, so no client-influenced value can be interpreted as a command. Binaries come from the image, so the deployed version is pinned by the Dockerfile and identical across environments. Full control over timeouts, `SIGKILL` escalation, and process cleanup on shutdown. Zero runtime dependencies. `ffprobe -print_format json` yields structured metadata directly.
- **Cons:** Argument construction and JSON parsing are written by hand. Process lifecycle (timeout, kill, zombie reaping) is the caller's responsibility.

### Option B: `fluent-ffmpeg`
The long-standing FFmpeg wrapper for Node.
- **Pros:** Fluent API for probing and transcoding; handles progress events and argument building.
- **Cons:** The upstream repository has been archived since May 2025 and is no longer maintained, so it is a dead dependency with no security response path. It shells out through its own argument layer, which reintroduces the quoting concern `spawn` avoids. Building on an archived package for a new feature is technical debt taken on deliberately.

### Option C: `ffmpeg-static` binary bundled via npm
Ship a prebuilt FFmpeg binary as a dependency instead of installing it in the image.
- **Pros:** The binary version is pinned in `package.json` and travels with the dependency tree; no `apt-get` step in the Dockerfile.
- **Cons:** One binary per platform, which complicates multi-architecture builds and diverges from the OS-provided libraries. The image is built once and pinned by tag anyway, so the reproducibility benefit is marginal. Adds ~80MB to `node_modules` and a postinstall download step.

**Recommendation:** **Option A** — `spawn` with an argv array is the option with no deprecation risk and no shell surface, and installing FFmpeg in the worker image keeps the deployed version explicit. Seek to roughly 10% of the duration before extracting a frame so the thumbnail is not a black opening frame.
**Decision:** A (spawn with argv array; FFmpeg installed in the worker image)
**Libraries:** (none — Node built-in `child_process`)

---

## TD-08: Streaming and Download Delivery

**Scope:** Backend
**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"
**Context:** Playback must start without transferring the whole file, which requires HTTP range support (`206 Partial Content`). Download must be available to the user and delivered as a file attachment. Two questions are coupled here: whether the API proxies bytes or redirects to storage, and whether each endpoint requires authentication.
**Options:**

### Option A: `302` redirect to a presigned storage URL; stream and thumbnail public, download requires JWT
The API answers `302 Found` with a `Location` pointing at a presigned GET; the storage serves `Range`/`206`/`Content-Range` natively. `GET /videos/:public_id/stream`, `/thumbnail`, and the metadata endpoint are `@Public()`; `GET /videos/:public_id/download` requires a valid JWT and presigns with `ResponseContentDisposition: attachment`.
- **Pros:** Zero video bytes transit the API in either direction, so playback and download scale with the storage tier rather than the API tier. Range, `206`, and `416` come from MinIO/S3's native implementation instead of being reimplemented. It matches the architecture diagram ("Frontend → streams from Object Storage") and the product rule that anonymous visitors watch freely while downloading is a user action. Signing an attachment URL keeps the download a single redirect.
- **Cons:** The client must follow redirects and re-request when a presigned URL expires mid-playback, which requires the `playback-url` refresh endpoint. Presigned URLs are shareable for their TTL, so expiry must be bounded (default 1h).

### Option B: Proxy ranged requests through the API
The API forwards the client's `Range` header to storage and streams the response back, implementing `Content-Range` itself.
- **Pros:** Stable, permanent URLs that never expire, and the API keeps full control over authorization on every byte. It can mask the storage endpoint entirely.
- **Cons:** Every byte of every playback flows through the API, making the API the bandwidth bottleneck it was designed to avoid, and coupling video egress to API capacity. It means reimplementing range negotiation, `206`, and `416` — a solved problem in the storage layer — with more code and more edge cases to get wrong.

### Option C: Presigned redirect with every read endpoint requiring JWT
Same redirect mechanism, but stream, thumbnail, and metadata are authenticated too.
- **Pros:** Uniform authorization across the module; no anonymous surface at all.
- **Cons:** Contradicts the product requirement that anonymous users watch freely, which is stated in the project overview and reinforced by the phase's own framing. It would also require the video player to carry a token into an `<video>` element's URL.

**Recommendation:** **Option A** — keep the API off the data path and let the storage tier do what it is built for. Public streaming and thumbnails match the product rule; requiring authentication on download satisfies "download do vídeo pelo usuário" without the API ever touching the bytes.
**Decision:** A (302 → presigned GET; public stream/thumbnail, authenticated download)

---

## TD-09: Enqueue Reliability Between Commit and Dispatch

**Scope:** Backend
**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"
**Context:** `POST /videos/:id/complete` must both move the video to `processing` and cause a job to be published. If the enqueue happens inside the database transaction, a Redis failure rolls back a legitimate upload; if it happens after the commit, a crash in the window between commit and publish leaves a video permanently stuck in `processing` with no job — invisible, because the upload succeeded from the client's perspective. Neither ordering is safe on its own because the database and Redis cannot be committed atomically.
**Options:**

### Option A: Transactional outbox with a polling relay
Write an `video_processing_outbox` row inside the same transaction that flips the status; a relay polls pending rows and publishes them to BullMQ with `jobId = event_id`, then marks them dispatched.
- **Pros:** Closes the loss window completely — the intent to enqueue is committed atomically with the state change, so the job cannot be lost even if Redis is down at completion time. Redis outages degrade to latency (rows stay `pending` and the relay retries) instead of data loss. `jobId = event_id` makes dispatch idempotent, so duplicate dispatches are no-ops in BullMQ. Rows left `pending` by a crash are simply re-published on the next tick.
- **Cons:** One extra table, entity, migration, relay service, and their tests. Dispatch is asynchronous, so tests must trigger it deterministically rather than waiting on a timer.

### Option B: Enqueue after commit, no outbox
Publish to BullMQ in a `try/catch` immediately after the transaction commits.
- **Pros:** No new table, no relay, no polling; the simplest implementation and the easiest to reason about locally.
- **Cons:** The process can die between commit and publish — a deploy, an OOM kill, a Redis blip — and the video is stranded in `processing` with no job and no record that one was ever owed. Detecting it requires inferring intent from the videos table alone, which cannot distinguish "job lost" from "job running slowly".

### Option C: Enqueue inside the database transaction
Publish to BullMQ before the transaction commits.
- **Pros:** No extra table; the publish and the status change appear together in the code.
- **Cons:** Inverts the failure mode without removing it: a publish that succeeds followed by a rolled-back transaction enqueues a job for a video still in `draft`, and a Redis outage aborts an upload that the database could have recorded successfully. The consumer would then have to defend against jobs for videos that were never committed.

**Recommendation:** **Option A** — it is the only ordering where the database is the source of truth for what must happen, and Redis becomes a delivery mechanism rather than a participant in the commit. Expose a public `processPending(): Promise<number>` on the relay so integration and e2e tests dispatch synchronously instead of sleeping on the timer.
**Decision:** A (Transactional outbox with a polling relay)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-10: Docker Networking for Storage Access

**Scope:** Backend
**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Processamento automático do vídeo após upload (extração de duração e metadados)"
**Context:** MinIO is reached by two different classes of caller with incompatible network views. The API and worker resolve the storage as the Compose service name `minio` on the internal network. The browser runs on the host and can only resolve `localhost`. A presigned URL embeds its host, so a single endpoint value cannot serve both: URLs signed for `minio:9000` fail in the browser, and URLs signed for `localhost:9000` fail inside the worker container with `ECONNREFUSED` because `localhost` resolves to that container itself.
**Options:**

### Option A: Dual endpoint — internal and public, selected per call
Two configuration values, `STORAGE_ENDPOINT` (`http://minio:9000`) and `STORAGE_PUBLIC_ENDPOINT` (`http://localhost:9000`), with the presign method taking an `internal` flag. Browser-facing presigns use the public endpoint; worker-facing presigns pass `internal: true`.
- **Pros:** Each caller gets a URL its own network stack can actually resolve. The choice is explicit at the call site, so the intent is visible in the code that knows the context. Both endpoints come from configuration, so production overrides them without code changes. Server-side operations always use the internal endpoint, keeping traffic on the Compose network.
- **Cons:** Two values to configure and keep consistent. A presign call that omits the flag defaults to public and fails inside the worker — a mistake that surfaces as `ECONNREFUSED` rather than a clear error.

### Option B: Single public endpoint used everywhere
Configure only `localhost:9000` and use it for all presigning.
- **Pros:** One value, no flag, no per-call decision to get wrong.
- **Cons:** Breaks the worker: a container resolving `localhost` reaches itself, not the host, so FFmpeg fails with `ECONNREFUSED`. The workaround would be `network_mode: host`, which is unavailable on Docker Desktop and defeats container isolation.

### Option C: Single internal endpoint with host port-forwarding through the API
Sign everything for `minio:9000` and add an API endpoint that proxies storage traffic to the browser.
- **Pros:** One configured endpoint; the storage hostname is never exposed to clients.
- **Cons:** Makes the API a mandatory hop for every video byte during playback, reintroducing exactly the bottleneck TD-08 removes. It trades a configuration concern for a performance regression.

**Recommendation:** **Option A** — the two callers genuinely live in different networks, so the configuration should say so explicitly. Default `internal: false` (browser-safe) and require `internal: true` at the worker call site, where the context makes the choice obvious.
**Decision:** A (Dual endpoint selected per call via an `internal` flag)

---

## TD-11: Real Object Size Validation on Completion

**Scope:** Backend
**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
**Context:** `POST /videos` validates the `size_bytes` the client declares, but that value is an unverified claim: a client can declare 1GB and upload 40GB. Because the bytes never pass through the API, the API has no opportunity to measure them in flight. The 10GB ceiling is a capacity guarantee for the storage tier, so it must be verified against the object that was actually written rather than the number that was promised.
**Options:**

### Option A: `HeadObject` after `CompleteMultipartUpload`
After the multipart upload is completed, issue `HeadObject` and compare the returned `ContentLength` to the limit; reject with `413 PAYLOAD_TOO_LARGE` if it exceeds it.
- **Pros:** Measures the real object rather than a client claim, closing the gap the API's position off the data path necessarily creates. `HeadObject` returns headers only — no body is transferred, so the check is cheap regardless of object size. It also confirms the object exists and the multipart completion actually produced a readable object, which is worth knowing before marking the video `processing`. The measured size is authoritative and can be persisted instead of the declared one.
- **Cons:** One additional storage round trip per completion. A rejected oversized object has already consumed upload bandwidth and storage, so it must be deleted on rejection rather than merely refused.

### Option B: Rely on the declared `size_bytes` only
Accept the client's number and skip verification.
- **Pros:** No extra call; the completion path stays minimal.
- **Cons:** The 10GB limit becomes advisory. Nothing stops a client from exceeding it, and the resulting oversized object is discovered only when something downstream fails. It also means `size_bytes` in the database may not describe the stored object at all.

### Option C: Enforce the ceiling with an S3 bucket policy
Express the limit as a storage-side policy constraint.
- **Pros:** Enforced at the storage layer, so it holds regardless of which client or code path performs the upload.
- **Cons:** S3/MinIO bucket policies govern access, not object size — there is no size predicate to express. Multipart completion would have to be blocked by a precondition the policy language does not offer. Not implementable as described.

**Recommendation:** **Option A** — the API is deliberately off the data path, so a post-write verification is the only place the real size can be observed. Persist the measured `ContentLength` rather than the client's figure, and delete the object when rejecting it.
**Decision:** A (HeadObject validation → 413 PAYLOAD_TOO_LARGE)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Background job queue technology | **A** (BullMQ + Redis) | **A** |
| TD-02 | Backend | Large file upload strategy (up to 10GB) | **A** (Presigned S3 multipart upload) | **A** |
| TD-03 | Backend | Object storage SDK and key layout | **A** (AWS SDK v3 behind a StorageService interface) | **A** |
| TD-04 | Backend | Public video identifier (unique URL) | **A** (11-char base62 `public_id` via `crypto`) | **A** |
| TD-05 | Backend | Video status lifecycle | **A** (Four states: draft → processing → ready \| error) | **A** |
| TD-06 | Backend | Video worker execution model | **A** (Same codebase, dedicated entrypoint and container) | **A** |
| TD-07 | Backend | Metadata extraction and thumbnail generation | **A** (spawn + argv array; FFmpeg in worker image) | **A** |
| TD-08 | Backend | Streaming and download delivery | **A** (302 → presigned GET; public stream, authenticated download) | **A** |
| TD-09 | Backend | Enqueue reliability between commit and dispatch | **A** (Transactional outbox with a polling relay) | **A** |
| TD-10 | Backend | Docker networking for storage access | **A** (Dual endpoint selected per call) | **A** |
| TD-11 | Backend | Real object size validation on completion | **A** (`HeadObject` → `413 PAYLOAD_TOO_LARGE`) | **A** |

---

## Notes for downstream pipeline

**TD dependencies:**
- TD-02 (multipart upload) depends on TD-03 (storage SDK) and TD-10 (dual endpoint) for correct presign hosts.
- TD-05 (status lifecycle) is the state machine that TD-09 (outbox) and TD-06 (worker) drive.
- TD-09 (outbox) depends on TD-01 (queue) for the `jobId` dedup primitive.
- TD-11 (size validation) is enforced inside the completion flow defined by TD-02.

**Files to create (indicative — the plan fixes the final structure):**
- `nestjs-project/src/videos/` — entity, migration, service, controller, DTOs, constants, storage abstraction, queue/outbox, processing, maintenance.
- `nestjs-project/src/worker/main.ts` — worker entrypoint (no HTTP listener).
- `nestjs-project/Dockerfile.worker` — Node image plus FFmpeg.
- `nestjs-project/compose.yaml` — adds `minio`, `redis`, and `nestjs-worker` services.
- `nestjs-project/src/config/storage.config.ts`, `nestjs-project/src/config/queue.config.ts` — new `registerAs` configs, plus new keys in `env.validation.ts` and `.env.example`.

**CLAUDE.md updates required:** the video module and its status lifecycle, the new endpoints, the new infrastructure (MinIO, Redis, worker) with Compose service names as hosts, the worker's runtime and its use of the internal presigned endpoint, and the phase rules (video never transits the API; server-assigned storage keys; enqueue via outbox after commit; `@Public()` only on read endpoints).
