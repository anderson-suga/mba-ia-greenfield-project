---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bullmq"
    fetched_at: "2026-10-14T18:02:00-03:00"
  "bullmq":
    version: "^5.81.5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-14T18:02:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-14T18:02:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-14T18:02:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T17:54:03-03:00"
---

# phase-03-videos — Library References

> **Sourcing note.** The Context7 MCP server is **not configured in this environment** (`.mcp.json` registers only the `postgres` server), so the `context7_id` values above are the libraries' canonical Context7 identifiers recorded for future refresh, **not** evidence of a Context7 fetch in this run. The distillations below were taken from each library's **official documentation** at the URLs cited per entry, and every version and API claim was cross-checked against the packages actually installed in `nestjs-project/node_modules/`.

Distilled docs for libraries decided in this phase. Re-fetch when the underlying TD changes.

---

## @nestjs/bullmq

**Source:** https://docs.nestjs.com/techniques/queues — installed `11.0.5`. Maps to `phase-03-videos/TD-01` Decision A and `phase-03-videos/TD-09` Decision A.

### Version constraint (load-bearing)

**Pin `@nestjs/bullmq@^11`.** The published `latest` is `12.0.0`, which is ESM-only. This project compiles to CommonJS (`package.json` declares no `"type": "module"`, and `tsconfig.json` uses `module: "nodenext"`), so v12 breaks `ts-jest` and the NestJS runtime. Verified on the installed tree: `@nestjs/bullmq@11.0.5` has `main: dist/index.js` and no `exports` map, i.e. plain CJS.

`11.0.5` declares peer `bullmq: "^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0"`. This phase installs the `^5` line (`5.81.5`), which is the mature branch.

### Root configuration

```ts
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: 'redis', port: 6379 },
    }),
  ],
})
export class AppModule {}
```

`forRootAsync()` accepts `useFactory` / `useClass` / `useExisting`. Everything except `extraOptions` is passed directly to the BullMQ `Queue` constructor.

### Queue registration and injection

```ts
BullModule.registerQueue({ name: 'video-processing' });

import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
```

`getQueueToken(name)` is also exported from `@nestjs/bullmq` and is the token used by `@InjectQueue`; tests that need to resolve a queue by token can use the exported helper.

### Consumer

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'video.process':
        /* ... */
        break;
    }
  }
}
```

Consumers are ordinary `providers`. Bull-style `@Process('name')` handlers do **not** exist in BullMQ — dispatch on `job.name` inside `process()`.

### Worker events

```ts
import { OnWorkerEvent } from '@nestjs/bullmq';

@OnWorkerEvent('active')
onActive(job: Job) {}

@OnWorkerEvent('failed')
onFailed(job: Job, error: Error) {}
```

Queue-level listeners use `QueueEventsListener` + `QueueEventsHost` + `@OnQueueEvent` from `@nestjs/bullmq`, and must also be registered as providers.

### Application context (no HTTP)

The worker boots with `NestFactory.createApplicationContext(WorkerModule)` — not `createNestApplication()`. This is what keeps the API's global `APP_GUARD` (JWT + throttler) and HTTP layer out of the worker process.

---

## bullmq

**Source:** https://docs.bullmq.io/ — installed `5.81.5`. Maps to `phase-03-videos/TD-01` Decision A and `phase-03-videos/TD-09` Decision A.

### Adding a job with dedup, retry, and retention

```ts
import { Queue } from 'bullmq';

await queue.add(
  'video.process',
  { video_id, storage_key, event_id },
  {
    jobId: event_id,          // duplicate jobId is a no-op — the dedup primitive
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86_400 },
  },
);
```

A duplicate `jobId` is **not** added. This is the mechanism that makes outbox re-dispatch idempotent (TD-09).

### Backoff strategies

Built-in `fixed` and `exponential`. Exponential waits `2 ^ (attempts - 1) * delay` ms, so `delay: 30_000` yields roughly 30s, 2m, 10m across three attempts — the schedule this phase specifies. A `jitter` between 0 and 1 randomises the delay. Queue-level `defaultJobOptions` supply `attempts`/`backoff` for every job unless overridden per add.

### Failing without retrying — `UnrecoverableError`

```ts
import { UnrecoverableError } from 'bullmq';

throw new UnrecoverableError('Invalid media file');
```

Throwing `UnrecoverableError` moves the job to the failed set **without performing any retries**, overriding the `attempts` configured at add time. This is the mechanism for the non-recoverable branch (corrupt file, invalid codec).

> **Discrepancy against the plan — resolved.** The phase plan describes the non-recoverable path as `job.discard()`. In the installed `bullmq@5.81.5`, `Job#discard()` is explicitly marked **`@deprecated use UnrecoverableError`**:
>
> ```
> /**
>  * Marks a job to not be retried if it fails (even if attempts has been configured)
>  * @deprecated use UnrecoverableError
>  */
> discard(): void;
> ```
>
> Verified against `node_modules/bullmq/dist/esm/classes/job.d.ts`. The implementation therefore uses `UnrecoverableError`, per the installed version's own guidance and the official "Stop Retrying Jobs" pattern. The plan's *intent* (no retry on unrecoverable failure) is unchanged; only the deprecated call is.

For the idempotency early-exit (job arrives for a video that is no longer `processing`), the processor **returns normally**: there is no work to do, so completing the job is correct and needs no special error.

### Long-running jobs

`lockDuration` must exceed the expected job time or the worker must heartbeat. Video processing on a 10GB file can run for many minutes, so this phase sets `lockDuration` to 30 minutes, a high `stalledInterval`, and `maxStalledCount: 1` to avoid a re-processing stampede. Progress can be reported with `job.updateProgress(...)`.

---

## @aws-sdk/client-s3

**Source:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/ and https://github.com/aws/aws-sdk-js-v3/discussions/6808 — installed `3.1152.0`. Maps to `phase-03-videos/TD-02` Decision A, `phase-03-videos/TD-03` Decision A, and `phase-03-videos/TD-11` Decision A.

### Client configuration, including the MinIO checksum trap

```ts
import { S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  endpoint: 'http://minio:9000',   // STORAGE_ENDPOINT inside the Compose network
  region: 'us-east-1',
  forcePathStyle: true,            // required for MinIO
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

Since `@aws-sdk/client-s3` `3.729.0`, the SDK defaults to computing a CRC-based checksum on every `PutObject`/`UploadPart` and to validating checksums on responses (`WHEN_SUPPORTED`). S3-compatible stores that do not implement these — MinIO among them — reject the resulting requests, surfacing as `499`/non-retryable streaming errors or, over plain HTTP, "unseekable stream is not supported without TLS and trailing checksum". Setting both options to `WHEN_REQUIRED` restores the previous behaviour and is the documented remediation. This phase talks to MinIO over plain HTTP inside Docker, so both settings are mandatory.

### Multipart command set

```ts
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

await client.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));
await client.send(new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body }));
await client.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: parts },   // must be sorted ascending by PartNumber
}));
await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
// head.ContentLength is the authoritative size (TD-11)
```

S3 requires every part except the last to be at least **5 MiB** and caps a multipart upload at **10,000 parts**. The default part size in this phase is 8 MiB.

---

## @aws-sdk/s3-request-presigner

**Source:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/ (presigner section) — installed `3.1152.0`. Maps to `phase-03-videos/TD-02`, `phase-03-videos/TD-08`, and `phase-03-videos/TD-10`.

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

// Upload — the client PUTs directly to storage
const uploadUrl = await getSignedUrl(client, new UploadPartCommand({
  Bucket, Key, UploadId, PartNumber,
}), { expiresIn: 3600 });

// Read — streaming (inline)
const streamUrl = await getSignedUrl(client, new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: 'inline',
}), { expiresIn: 3600 });

// Read — download (attachment)
const downloadUrl = await getSignedUrl(client, new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
}), { expiresIn: 3600 });
```

`ResponseContentDisposition` is carried **inside the signature**, so the attachment filename is set at signing time and cannot be altered by the client.

### The dual-endpoint consequence (TD-10)

The signed URL embeds the host of the client that signed it. A URL signed with `endpoint: 'http://minio:9000'` is unusable from a browser on the host; a URL signed with `endpoint: 'http://localhost:9000'` fails inside a container with `ECONNREFUSED`, because `localhost` there is the container itself. The `StorageService` therefore holds **two** clients — one per endpoint — and selects between them per call via an `internal` flag.

---

## node:crypto

**Source:** https://nodejs.org/api/crypto.html — Node built-in, no install. Maps to `phase-03-videos/TD-04` Decision A.

```ts
import { randomBytes, randomUUID } from 'node:crypto';
```

`randomUUID()` produces the internal UUID primary keys and outbox `event_id`s. `randomBytes(n)` feeds the base62 `public_id` generator: read `n` random bytes, map each onto a 62-character alphabet, and take the first 11 characters, retrying on a `UNIQUE` violation. Unlike `nanoid`, this is a built-in — no dependency, and no ESM/CJS failure mode (see `phase-03-videos/TD-04` Option B).

---

## ffmpeg / ffprobe

**Source:** https://ffmpeg.org/ffmpeg.html and https://ffmpeg.org/ffmpeg-protocols.html — OS binaries, installed in `Dockerfile.worker` via the distribution package (not an npm dependency). Maps to `phase-03-videos/TD-07` Decision A.

### Probing metadata

```bash
ffprobe -v quiet -print_format json -show_format -show_streams <input>
```

Returns `format.duration`, `format.format_name`, `format.bit_rate` and a `streams[]` array with per-stream `codec_name`, `codec_type`, `width`, `height`, and `bit_rate`. Parse the JSON and aggregate the fields the video metadata column stores.

### Rendering the thumbnail

```bash
ffmpeg -ss <offset_seconds> -i <input> -frames:v 1 -q:v 2 -f image2 -vcodec mjpeg <output.jpg>
```

`-ss` **before** `-i` seeks by keyframe and is markedly faster on large inputs. The offset is ~10% of the video duration, which avoids the black or title frame at the opening.

### Invocation from Node

```ts
import { spawn } from 'node:child_process';

const child = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', url]);
```

Arguments are passed as an **array**, so nothing is interpreted by a shell — no quoting concerns and no injection surface. The input is the **presigned read URL** with `internal: true` (TD-10), which FFmpeg opens over HTTP and seeks within via range requests, so a 10GB file is never written to disk. Timeouts escalate to `SIGKILL`, and the child is killed on `SIGTERM` so a container shutdown does not leave FFmpeg running.
