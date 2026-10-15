---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-25T21:46:20-03:00"
  docs/diagrams/software-arch.mermaid: "2026-09-25T21:46:20-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T17:54:03-03:00"
  CLAUDE.md: "2026-09-25T21:46:20-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição e exclusão de vídeo, categorias, visibilidade pública/unlisted, fluxo de rascunho → publicação, painel de gerenciamento do canal e edição de dados do canal (Fase 04). Comentários, likes e inscrições (Fase 06). Página de visualização, página inicial e busca (Fases 05 e 07). Transcodificação adaptativa (HLS/DASH), CDN e dashboard de fila.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — the video interface is out of scope for this phase; the frontend consumes the contracts fixed here in a later phase.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto (configuration module, Joi env validation, TypeORM wiring) and Fase 02 — Cadastro, Login e Gerenciamento de Conta (global JWT guard with `@Public()` opt-out, domain exception filter, `Channel` ownership model).

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.0.5, bullmq@^5.81.5 |
| phase-03-videos/TD-02 | phase | Backend | Large File Upload Strategy (up to 10GB) | decided | A (Presigned S3 multipart upload) | @aws-sdk/client-s3@^3.1152.0, @aws-sdk/s3-request-presigner@^3.1152.0 |
| phase-03-videos/TD-03 | phase | Backend | Object Storage SDK and Key Layout | decided | A (AWS SDK v3 behind a StorageService interface) | @aws-sdk/client-s3@^3.1152.0 |
| phase-03-videos/TD-04 | phase | Backend | Public Video Identifier (Unique URL) | decided | A (11-char base62 `public_id` via `crypto`) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Status Lifecycle | decided | A (Four states: draft → processing → ready \| error) | — |
| phase-03-videos/TD-06 | phase | Backend | Video Worker Execution Model | decided | A (Same codebase, dedicated entrypoint and container) | — |
| phase-03-videos/TD-07 | phase | Backend | Metadata Extraction and Thumbnail Generation | decided | A (spawn + argv array; FFmpeg in worker image) | — |
| phase-03-videos/TD-08 | phase | Backend | Streaming and Download Delivery | decided | A (302 → presigned GET; public stream, authenticated download) | — |
| phase-03-videos/TD-09 | phase | Backend | Enqueue Reliability Between Commit and Dispatch | decided | A (Transactional outbox with a polling relay) | @nestjs/bullmq@^11.0.5, bullmq@^5.81.5 |
| phase-03-videos/TD-10 | phase | Backend | Docker Networking for Storage Access | decided | A (Dual endpoint selected per call) | — |
| phase-03-videos/TD-11 | phase | Backend | Real Object Size Validation on Completion | decided | A (`HeadObject` → `413 PAYLOAD_TOO_LARGE`) | — |

_Source files:_

- `phase-03-videos` — docs/decisions/technical-decisions-phase-03-videos.md (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-09 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-11 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-07 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — it is the only option with a first-party NestJS module *and* the long-job primitives this phase actually needs (lock duration, stalled recovery, discard). The retry policy required by TD-09 maps directly onto BullMQ's `attempts` + `backoff` + `failed` event.
**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`

### phase-03-videos/TD-02

**Recommendation:** Presigned S3 multipart upload — the only option that both meets the 10GB ceiling and keeps the API off the data path. Part size defaults to 8MiB (10GB ≈ 1,280 parts, comfortably under the 10,000 limit), with 5MiB as the S3-enforced floor.
**Libraries:** `@aws-sdk/client-s3@^3.1152.0`, `@aws-sdk/s3-request-presigner@^3.1152.0`

### phase-03-videos/TD-03

**Recommendation:** AWS SDK v3 behind a `StorageService` interface, UUID-derived keys — the AWS presigner is the mature path for multipart signatures, and path-style + `forcePathStyle` makes MinIO a genuine drop-in for S3. Keep the abstraction thin and in `videos/storage/` until a second consumer exists; extract to a shared `src/storage/` only when one appears.
**Libraries:** `@aws-sdk/client-s3@^3.1152.0`

### phase-03-videos/TD-04

**Recommendation:** 11-character base62 `public_id` generated with `crypto.randomBytes` — the standard shape for this problem, with uniqueness enforced by the database rather than trusted from the generator. Retry on the `UNIQUE` violation inside the existing transaction, following the SAVEPOINT pattern already used for channel nicknames.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Four states (`draft → processing → ready | error`) — it satisfies the required vocabulary without inventing states the API cannot observe. Enforce the transitions with a check constraint on the column, and treat `upload_id IS NOT NULL` as "upload in progress".
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Same codebase, dedicated entrypoint and container — one codebase, two entrypoints, two containers. It is the only option that isolates CPU load while keeping a single source of truth for entities and configuration. Install FFmpeg only in `Dockerfile.worker`; the API image must not carry it.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** `spawn` with an argv array and FFmpeg installed in the worker image — the option with no deprecation risk and no shell surface, and it keeps the deployed FFmpeg version explicit. Seek to roughly 10% of the duration before extracting a frame so the thumbnail is not a black opening frame.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** `302` → presigned GET with public stream/thumbnail and authenticated download — keep the API off the data path and let the storage tier do what it is built for. Public streaming and thumbnails match the product rule; requiring authentication on download satisfies "download do vídeo pelo usuário" without the API ever touching the bytes.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Transactional outbox with a polling relay — it is the only ordering where the database is the source of truth for what must happen, and Redis becomes a delivery mechanism rather than a participant in the commit. Expose a public `processPending(): Promise<number>` on the relay so integration and e2e tests dispatch synchronously instead of sleeping on the timer.
**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`

### phase-03-videos/TD-10

**Recommendation:** Dual endpoint selected per call via an `internal` flag — the two callers genuinely live in different networks, so the configuration should say so explicitly. Default `internal: false` (browser-safe) and require `internal: true` at the worker call site, where the context makes the choice obvious.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** `HeadObject` validation → `413 PAYLOAD_TOO_LARGE` — the API is deliberately off the data path, so a post-write verification is the only place the real size can be observed. Persist the measured `ContentLength` rather than the client's figure, and delete the object when rejecting it.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Namespaced/grouped with `registerAs` — the project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-04

**Recommendation:** Shared `registerAs` factory — natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `@nestjs/config@^4.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only — the guard is registered globally via `APP_GUARD`, so every endpoint is protected by default and public routes opt out with `@Public()`.
**Libraries:** `@nestjs/jwt@^11.0.2`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.4`, `class-transformer@^0.5.1`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — provides machine-readable error codes that the Next.js frontend can switch on. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** `@nestjs/throttler` — native NestJS integration is decisive: the guard system allows scoping rate limiting via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions.
**Libraries:** `@nestjs/throttler@^6.5.0`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `autoLoadEntities: true` and `synchronize: false`. _(from phase 01)_
- A global `JwtAuthGuard` is registered as `APP_GUARD`; every endpoint is protected by default and public routes opt out with `@Public()`. _(from phase 02)_
- Services throw domain exceptions (`DomainException` subclasses carrying an `errorCode` and `httpStatus`); the global `DomainExceptionFilter` maps them to `{ statusCode, error, message }`. _(from phase 02)_
- Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`; DTO fields use snake_case. _(from phase 02)_
- A global `ThrottlerGuard` enforces 10 requests/60s; endpoints that need different limits use `@SkipThrottle()` / `@Throttle()`. _(from phase 02)_
- Migrations are SQL-raw classes generated by the TypeORM CLI, named `CreateXxx{timestamp}`, never edited after being run. _(from phase 01)_
- Test data sources use explicit entity class arrays plus a hardcoded `cleanAllTables()`; integration and e2e suites run with `--runInBand`. _(from phase 02)_
- Compose hosts are always service names (`db`, `mailpit`) — never `localhost`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not the target of that backend phase; UI surfaces start in a later phase. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Edição e exclusão de vídeo, categorias, visibilidade e fluxo de publicação | deferred | Fase 04 — Gerenciamento de Vídeos e Canal. Phase 03 stops at producing a `ready` video; lifecycle management beyond that is the next phase. | — |
| Painel de gerenciamento do canal e edição dos dados do canal | deferred | Fase 04 — Gerenciamento de Vídeos e Canal. | — |
| Página de visualização do vídeo, player e interfaces de vídeo | deferred | Fase 05 — Página de Visualização do Vídeo. Phase 03 delivers the backend contracts (stream, download, thumbnail); the UI is out of scope. | — |
| Comentários, likes e inscrições | deferred | Fase 06 — Interações Sociais. | — |
| Transcodificação adaptativa (HLS/DASH) e CDN | deferred | Not required by Phase 03; streaming is served by range requests against the original object. | — |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration — constraints, defaults, `select: false`, unique violations |
| Migration | Integration — `runMigrations` / `undoLastMigration` round trip, restoring schema in `afterAll` |
| DTO (`*.dto.ts`) | Covered through controller e2e and service unit tests; no standalone DTO suite unless a transform is non-trivial |
| Service (`*.service.ts`) | Unit (collaborators mocked) + Integration (real database and real storage) |
| Controller (`*.controller.ts`) | E2E only — no unit tests |
| Module (`*.module.ts`) | Module boot test where DI wiring is non-trivial |
| Configuration (`src/config/*.config.ts`) | Unit — defaults and env coercion |
| Queue processor / worker | Unit (job discarded, success, unrecoverable failure) + Integration (real Redis, real storage, real fixture) |
| Guard / filter | Unit where a mapping table is encoded; otherwise covered by e2e |

Backend layer requirements follow the `testing-guide-nestjs-project` skill. Integration and e2e suites must run against the real Compose infrastructure (PostgreSQL, MinIO, Redis) — the project rule is not to mock what can genuinely be exercised, and both suites run with `--runInBand` because they share a single test database.

### next-frontend

_Deferred subproject — testing requirements will be defined when the phase that introduces the video UI is planned._
