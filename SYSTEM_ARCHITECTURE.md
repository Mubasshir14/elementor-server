 # System Architecture

This document describes the backend as it exists in this repository, how its
services and data fit together, how to run it locally, and which conversion
capabilities are still blocked or not implemented. The code and Prisma schema
are the source of truth; proposed product behavior is called out separately.

## 1. System purpose and current status

The service is the backend foundation for a design-to-Elementor product. It
provides authentication, project ownership, private React/Next.js ZIP intake,
conversion job tracking for existing jobs, rule-file snapshots,
WordPress-site verification, and artifact download plumbing.

The authenticated `GET /api/v1/capabilities` endpoint is the canonical source
of frontend upload and conversion availability. React/Next.js ZIP files and
Figma REST API file JSON exports (`.json`) can currently be uploaded and parsed
locally; Framer accepts a published-site URL for analysis, and screenshots are
reported as unavailable because their import adapters are not present.

The conversion pipeline is **not yet a complete design converter**. The worker
currently inspects that an upload is ready, marks `source_inspection`
complete, and blocks at `source_ir_validation` with
`APPROVED_IR_SCHEMA_MISSING`. The approved DIR/IR schema and regression
fixtures are not present in this workspace. No Elementor document is compiled
and no HTML/CSS/JavaScript fallback is generated.

WordPress publishing is also deliberately disabled. The API can store an
encrypted credential and verify a site's bridge capabilities, but native
document writes return `NATIVE_PUBLISH_ADAPTER_UNVERIFIED` until an adapter is
implemented and tested against supported WordPress and Elementor versions.
The corresponding WordPress plugin/bridge is not in this repository.

## 2. Technology and runtime components

| Component | Technology | Responsibility |
|---|---|---|
| HTTP API | Node.js, Express 5, TypeScript | Versioned REST endpoints, validation, authentication, project and resource operations |
| Relational database | PostgreSQL, Prisma 7 | Users, sessions, projects, uploads, conversion state, rule snapshots, sites, artifacts, reports, audit-event schema |
| Job queue | PostgreSQL | Persist pending jobs, claims, retry timing, and worker leases |
| Background worker | Node.js, Prisma | Claim and process jobs independently of HTTP requests |
| File storage | Node.js filesystem streams | Store private uploads/artifacts under one configured local root |
| Request validation | Zod | Validate environment configuration, request bodies, identifiers, and worker payloads |
| Password security | Argon2id | Hash and verify account passwords |
| Site credentials | AES-256-GCM | Encrypt WordPress application credentials before database storage |
| HTTP protections | Helmet, CORS allowlist, express-rate-limit | Secure headers, browser-origin policy, per-process rate limits |
| Tests | Vitest, Supertest | Unit and API security/behavior tests |

### Processes

1. **API process** (`src/server.ts`) listens on `API_PORT`, creates the Express
   application, and persists new conversion jobs.
2. **Worker process** (`src/worker.ts`) polls and claims PostgreSQL conversion
   jobs. It is a separate process and must be started separately from the API.
3. **PostgreSQL** is an external service. Local file storage is initialized
   and permission-checked by both the API and worker.
4. A browser or other client uploads and downloads bytes through authenticated
   API endpoints; it never receives filesystem paths or direct storage URLs.
5. An optional WordPress site is contacted server-to-server over HTTPS for
   capability verification. Native publishing is not implemented yet.

## 3. Repository map

```text
server/
├── prisma/
│   ├── schema.prisma                 # PostgreSQL data model
│   └── migrations/                   # Committed SQL migration history
├── rules/
│   ├── ELEMENTOR_SKILL.md            # Target platform rules
│   ├── FIGMA.md                      # Figma source rules
│   └── FRAMER.md                     # Framer source rules
├── src/
│   ├── app.ts                        # Middleware, route registration, health checks
│   ├── server.ts                     # HTTP process and graceful shutdown
│   ├── worker.ts                     # PostgreSQL job polling and current pipeline behavior
│   ├── generated/prisma/             # Generated Prisma 7 client (created by prisma:generate)
│   ├── config/env.ts                 # Startup environment validation
│   ├── middleware/errors.ts          # Consistent HTTP error responses
│   ├── modules/
│   │   ├── auth/                     # Registration, login, sessions, auth middleware
│   │   ├── projects/                 # Project CRUD and project-role checks
│   │   ├── uploads/                  # Upload reservation, streamed content, inspection
│   │   ├── conversions/              # Job creation, status, stages, reports, retry, cancel
│   │   ├── rule-files/               # Rule loading, hashing, and conversion snapshots
│   │   ├── artifacts/                # Artifact listing and authorized streaming download
│   │   └── wordpress-sites/          # Site connection, verification, disabled publishing
│   └── infrastructure/
│       ├── database/prisma.ts        # Prisma client
│       ├── queue/                    # PostgreSQL job claiming and recovery
│       ├── storage/                  # Rooted local filesystem and scan concurrency control
│       └── wordpress/                # SSRF-resistant bridge client and credential crypto
├── tests/                            # Vitest unit/API tests
├── .env.example                      # Environment variable template
├── package.json                      # Scripts and direct dependencies
├── pnpm-lock.yaml                    # Locked dependency graph
├── README.md                         # Product/backend notes and setup summary
└── SYSTEM_ARCHITECTURE.md            # This document
```

The application requires PostgreSQL and a readable/writable local storage
directory. No container runtime or separate storage service is required.

## 4. High-level architecture and data flow

```text
Web client
   │
   ├── JSON requests, Authorization: Bearer <session token>
   ▼
Express API (/api/v1)
   ├── CORS + Helmet + JSON/request limits + rate limits
   ├── JWT verification + persisted-session check
   ├── Zod validation + project-role authorization
   ├── Prisma ───────────────────────────────► PostgreSQL
   ├── local storage service ───────────────► Private filesystem root
   └── WordPress bridge client (verify only) ► HTTPS WordPress site
                                                   │
                                                   └── capability response

Browser ── authenticated upload/download ──► Express API ──► private files

PostgreSQL pending jobs ──► Worker ──► PostgreSQL job/stage/report state
                                │
                                └── currently blocks at IR validation
```

### Upload and conversion lifecycle

1. A user registers or logs in. Passwords are stored as Argon2id hashes. A
   persisted session and a signed 12-hour bearer token are created.
2. An owner or editor creates a project or selects an existing project.
3. The client reserves an upload with project ID, file name, content type, and
   size. The API checks the role, extension/content-type pairing, per-file
   maximum, and project storage quota; it stores a `PENDING` upload record and
   records `PENDING` metadata and returns an authenticated content endpoint.
4. The browser streams the reserved content type to the API. The API enforces
   the reserved byte limit while writing to an exclusive temporary file under
   the configured root, then atomically publishes it under a server-generated
   relative key.
5. The client calls the upload completion endpoint. For a React/Next.js ZIP,
   the API verifies size and archive safety, reads a bounded `package.json`,
   verifies a framework dependency and matching application source paths,
   calculates SHA-256, and stores the detected framework. It never executes
   uploaded code. Valid uploads become `READY`.
6. A conversion request is validated against the ready upload and retains
   `sourceType`, detected framework, and the requested Elementor profile. The
   endpoint returns HTTP 501 with `CONVERSION_PIPELINE_UNAVAILABLE`; it does
   not create a job because the approved DIR schema and compiler are absent.
7. For previously persisted jobs, the worker validates the queue payload, claims the job, records
   `source_inspection`, then blocks it at `source_ir_validation` because the
   approved IR schema is missing. It writes a validation report and upstream
   blocked-stage diagnostics.
8. The client polls conversion, stage, and report endpoints. Ready artifacts
   are streamed from an authorized endpoint, but the current worker does not
   generate any.
9. Site capability verification is a separate operation. Publishing is
   rejected with HTTP 501 until a verified native publishing adapter exists.

### Conversion stages recorded in the database

| Position | Stage name | Current behavior |
|---:|---|---|
| 0 | `source_inspection` | Worker marks complete after confirming the upload is ready |
| 1 | `source_ir_validation` | Worker marks blocked with `APPROVED_IR_SCHEMA_MISSING` |
| 2 | `optimization` | Created but blocked as an upstream stage |
| 3 | `target_resolution` | Created but blocked as an upstream stage |
| 4 | `compilation` | Created but blocked as an upstream stage |
| 5 | `output_validation` | Created but blocked as an upstream stage |
| 6 | `artifact_storage` | Created but blocked as an upstream stage |

The README's full proposed pipeline (source analysis, Source IR, deterministic
compiler, and output validation) describes intended future behavior, not
current worker functionality.

## 5. HTTP API

Base path: `/api/v1`. Request and response bodies are JSON unless the endpoint
returns no content. Every endpoint below requires a bearer token except
`/health/live`, `/health/ready`, `/auth/register`, and `/auth/login`.
`/auth/logout` and `/auth/me` perform their own authentication middleware.

All project resources are scoped to project membership. `OWNER`, `EDITOR`, and
`VIEWER` can read; `OWNER` and `EDITOR` can create or change most project
resources; only `OWNER` can delete projects or revoke connected sites. A
missing membership is returned as `404 PROJECT_NOT_FOUND` to avoid disclosing
another user's project.

### Authentication

| Method and path | Request | Success |
|---|---|---|
| `POST /auth/register` | `{ "email": "user@example.com", "password": "minimum-12-characters" }` | `201`, `{ user, token, expiresAt }` |
| `POST /auth/login` | Same fields as registration | `200`, `{ user, token, expiresAt }` |
| `POST /auth/logout` | No body required | `204`; revokes the current persisted session |
| `GET /auth/me` | No body | `200`, `{ user: { id, email, createdAt } }` |

Email is normalized to lowercase. Password length is 12–128 characters.
Sessions expire after 12 hours. Send the token as
`Authorization: Bearer <token>`. JWT verification is backed by the session
record, so revoking a session invalidates the token immediately.

### Health

| Method and path | Authentication | Behavior |
|---|---|---|
| `GET /health/live` | No | Liveness only: `{ "status": "live" }` |
| `GET /health/ready` | No | Checks PostgreSQL and local storage access; returns `200 ready` or `503 not_ready` |

### Projects and uploads

| Method and path | Request | Success / notes |
|---|---|---|
| `GET /capabilities` | None | `200`, validated source types, accepted formats, size limits, target status, and no defaults while conversion is unavailable |
| `GET /projects` | None | `200`, `{ projects: [...] }` for the authenticated user's memberships |
| `POST /projects` | `{ "name": "Project name" }` | `201`, `{ project }`; creator becomes `OWNER` |
| `GET /projects/:projectId` | None | `200`, `{ project }`; any project role |
| `PATCH /projects/:projectId` | `{ "name": "Updated name" }` | `200`, `{ project }`; owner/editor |
| `DELETE /projects/:projectId` | None | `204`; owner only; database metadata is deleted before file cleanup; cleanup failures return `500 STORAGE_CLEANUP_FAILED` and require reconciliation |
| `POST /projects/:projectId/uploads` | `{ "sourceType": "react-next-zip" | "figma", "fileName": "source.zip" | "design.json", "contentType": "application/zip" | "application/json", "sizeBytes": 1234 }` | `201`, `{ upload, contentUrl }`; owner/editor; React/Next.js ZIP and Figma file-JSON intake are available |
| `PUT /uploads/:uploadId/content` | Raw file bytes; `Content-Type` must match the reservation | `204`; authenticated owner/editor; streamed, size-limited, atomic write |
| `POST /uploads/:uploadId/complete` | Empty object `{}` | `200`, `{ upload: { id, status, sha256, completedAt }, sourceImport? }` when inspected successfully. Figma uploads are parsed locally into a `FIGMA_FILE` source import |

Project names are trimmed and must be 1–120 characters. Uploads are limited by
`UPLOAD_MAX_BYTES` (default 50 MiB; configuration cannot exceed 50 MiB) and a
project-wide quota `UPLOAD_QUOTA_BYTES` (default 500 MiB). The current intake
accepts React/Next.js ZIP (`.zip`) and Figma REST API file JSON (`.json`) with
matching content types. ZIP
inspection rejects traversal paths, symlinks and other special file types,
encrypted entries, excessive entry count, excessive expanded size, and
excessive compression ratio. This is metadata inspection; the API does not
extract and execute uploaded project files.

### Conversions

| Method and path | Request | Success / notes |
|---|---|---|
| `POST /projects/:projectId/conversions` | `{ "sourceType": "react-next-zip" \| "figma" \| "framer" \| "screenshot", "detectedFramework": "react" \| "nextjs" (React/Next.js ZIP only), "uploadId": "<uuid>", "idempotencyKey": "unique-key-8-to-128-chars", "targetProfile": { "platform": "elementor", "architecture": "atomic" \| "legacy" \| "hybrid", "licenseMode": "free" \| "pro" \| "hybrid" } }` | `501 CONVERSION_PIPELINE_UNAVAILABLE`; validated settings are not discarded, and no job is created until the DIR/compiler exists |
| `GET /conversions/:conversionId` | None | `200`, `{ conversion }` including status, attempt, target profile, rules and error details |
| `GET /conversions/:conversionId/stages` | None | `200`, `{ stages: [...] }` ordered by position |
| `GET /conversions/:conversionId/reports` | None | `200`, `{ report: null \| { diagnostics, createdAt } }` |
| `POST /conversions/:conversionId/retry` | Empty object `{}` | `202`; only failed jobs can be retried |
| `POST /conversions/:conversionId/cancel` | Empty object `{}` | `202`, `{ conversionId, cancellationRequested: true }`; finished jobs cannot be cancelled |
| `GET /conversions/:conversionId/artifacts` | None | `200`, `{ artifacts: [...] }`; only ready artifacts are listed |

`idempotencyKey` is scoped to a project. Reusing a key with a different request
returns `409 IDEMPOTENCY_KEY_REUSED`. The target-profile fields represent
requested options only; accepting a request does not certify that a specific
Elementor architecture, widget, version, or license is supported. Current
worker behavior blocks every conversion at IR validation until the approved
schema becomes available.

### Rules, WordPress sites, and artifacts

| Method and path | Request | Success / notes |
|---|---|---|
| `GET /rules` | None | `200`, `{ files: [{ fileName, version, sha256 }] }` for the three approved rule files |
| `POST /sites` | `{ "projectId": "<cuid>", "baseUrl": "https://site.example", "username": "...", "applicationPassword": "..." }` | `201`, `{ site }`; owner/editor; credentials are encrypted before persistence |
| `POST /sites/:siteId/verify` | Empty object `{}` | `200`, `{ site }`; requests the bridge capabilities endpoint over HTTPS |
| `POST /sites/:siteId/publish` | `{ "conversionId": "<cuid>", "artifactId": "<cuid>", "idempotencyKey": "8-to-128-chars", "confirm": true }` | Currently `501 NATIVE_PUBLISH_ADAPTER_UNVERIFIED`; writes are not performed |
| `DELETE /sites/:siteId` | Empty object `{}` | `204`; owner only; revokes and clears stored credential ciphertext |
| `GET /artifacts/:artifactId/download` | None | Streams the file with attachment headers after membership authorization |

WordPress site URLs must be HTTPS hostnames without embedded credentials,
query, or fragment. The bridge client resolves and checks all DNS addresses for
public unicast addresses, pins the request to those resolved addresses,
rejects redirects by only accepting the expected direct response, enforces a
five-second timeout and 256 KiB response limit, and validates the JSON
capability shape.

### Error response contract

Expected API errors use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "issues": [{ "path": ["field"], "code": "invalid_type" }]
  }
}
```

Validation responses include `issues`; other typed errors normally contain
`code` and `message`. Unexpected errors return a generic `500 INTERNAL_ERROR`
without exposing stack traces or internal details. Common statuses include
`400` validation/input error, `401` authentication error, `403` role
restriction, `404` missing/hidden resource, `409` state or idempotency
conflict, `413` size/quota limit, `429` rate or scan-capacity limit, `501`
unimplemented native publishing, and `503` unavailable dependency/configuration.

## 6. Database architecture

PostgreSQL is the system of record for identity, ownership, state, file
metadata, rule snapshots, and diagnostics. Prisma schema and migration files are under
`prisma/`; connection URLs for CLI migrations are in the root
`prisma.config.ts`, not in the schema. Application access uses the generated
Prisma 7 client in `src/generated/prisma/` and the `@prisma/adapter-pg`
PostgreSQL driver adapter, initialized in
`src/infrastructure/database/prisma.ts`. Keep `prisma`, `@prisma/client`, and
`@prisma/adapter-pg` on matching major versions.

| Model | Purpose and relationships |
|---|---|
| `User` | Unique normalized email and Argon2id password hash; owns sessions, memberships, uploads, conversions, and audit events |
| `Session` | Persisted bearer session with expiration and revocation timestamps; cascades with user |
| `Project` | Resource/security boundary for project-owned uploads, conversions, sites, and artifacts |
| `ProjectMember` | Composite `(projectId, userId)` membership key and `OWNER` / `EDITOR` / `VIEWER` role |
| `Upload` | Private relative storage key, original metadata, SHA-256, creator, inspection status, and project relation |
| `ConversionJob` | Source platform, upload, idempotency/request hashes, target profile JSON, status, retry/cancel state, and owner |
| `ConversionStage` | Ordered per-job stage state, input hash, output object key, diagnostics JSON, and timestamps |
| `RuleFileVersion` | Content-addressed rule-file snapshot containing filename, version, SHA-256, and content |
| `ConversionRuleVersion` | Many-to-many association linking the exact rule snapshots used by a conversion |
| `Artifact` | Generated-file metadata and private relative storage key; optionally tied to a conversion |
| `ValidationReport` | One report per conversion; diagnostics are stored as JSON |
| `ConnectedWordPressSite` | Project site URL, encrypted credential, verification timestamp, and capability JSON |
| `AuditEvent` | Schema for user action/resource metadata and timestamps; current routes do not yet write audit events |

Enums include `ProjectRole`, `UploadStatus`, `ConversionStatus`,
`StageStatus`, `ArtifactStatus`, and `SourcePlatform`. Key uniqueness and
indexes include normalized unique user email, membership composite primary
key, per-project idempotency key, per-conversion stage name, rule filename
plus SHA-256, and query indexes on memberships, project resources, job status,
and audit resources.

The main ownership and processing relationships are:

```text
User ──< Session
User ──< ProjectMember >── Project
Project ──< Upload ──< ConversionJob >── User (creator)
Project ──< ConversionJob ──< ConversionStage
ConversionJob ──< ConversionRuleVersion >── RuleFileVersion
ConversionJob ──0..1 ValidationReport
ConversionJob ──< Artifact >── Project
Project ──< ConnectedWordPressSite
User ──< AuditEvent
```

`ProjectMember` is the authorization join. All project-owned reads and writes
must be scoped through membership before returning data or issuing storage
URLs. `ConversionRuleVersion` records immutable inputs to a conversion;
`ConversionStage` and `ValidationReport` record execution progress and
diagnostics. Stored files themselves are not relational children and must be
addressed by database-held relative keys through the storage service.

The persisted state enums are used as follows:

| State family | Values | Meaning |
|---|---|---|
| Upload | `PENDING`, `SCANNING`, `READY`, `REJECTED`, `DELETED` | Reservation, inspection lifecycle, and eligibility as a conversion input |
| Conversion | `QUEUED`, `RUNNING`, `BLOCKED`, `SUCCEEDED`, `FAILED`, `CANCELLED` | Overall asynchronous job lifecycle |
| Stage | `PENDING`, `RUNNING`, `COMPLETED`, `BLOCKED`, `FAILED`, `CANCELLED` | Per-step processing status and checkpoint metadata |
| Artifact | `READY`, `DELETED` | Whether an artifact may be listed or downloaded |
| Project membership | `OWNER`, `EDITOR`, `VIEWER` | Project-level authorization |

### Database usage rules

- Keep business state and relational metadata in PostgreSQL.
- Use foreign keys and Prisma transactions for logically atomic multi-row
  changes, such as creating a conversion and associating its rule snapshots.
- Store flexible structured target profiles and diagnostics in JSON/JSONB.
- Do not store uploaded ZIPs, images, or generated files as database blobs.
  Store private relative keys, checksums, sizes, and content metadata instead.
- Treat storage keys as internal references, not authorization. Check the
  caller's project membership before accepting uploads or streaming files.
- `BigInt` sizes are serialized as decimal strings by endpoints that return
  them to JSON clients.
- Development migration state has not been confirmed against a live database.
  Apply migrations with the configured local development database before
  running the service.

## 7. Local file storage and PostgreSQL background processing

### Local storage

`src/infrastructure/storage/local.ts` is the only filesystem access layer.
`STORAGE_PROVIDER` currently accepts only `local`; unsupported providers fail
environment validation. `LOCAL_STORAGE_PATH` defaults to
`./storage/uploads` and relative paths resolve from the backend package root,
not the process working directory. The API and worker must use the same root.

Storage keys are server-generated, relative forward-slash paths. The service
rejects traversal and backslashes, resolves each key under the configured
root, rejects symbolic-link traversal, creates private directories, writes
with back-pressure to an exclusive temporary file, and atomically links the
completed upload into place. Reads are streamed, and files are never mounted
as a public static directory. PostgreSQL retains metadata and relative keys;
file bytes remain on disk.

The local provider is intended for a single machine or a deployment where
both API and worker share the same reliable private filesystem. Independent
local disks across machines will not work. Back up PostgreSQL and the storage
directory together and restore them as a matched set. Filesystem and database
operations cannot share one transaction. Project deletion commits database
deletion first, then removes files. A cleanup failure returns
`STORAGE_CLEANUP_FAILED`, leaves inaccessible orphan files, and requires
operator reconciliation rather than risking loss of file data before a
database commit. This change does not copy existing S3 objects into the local
directory. If a database already contains S3-backed keys, retain the original
bucket and perform a separately verified export/import (including checksums)
before switching those records to local storage; the application must not be
assumed to have migrated old file bytes.

### PostgreSQL job queue

The `ConversionJob` row is also the durable queue item. Creating a conversion
and its stages/rule snapshots in one database transaction makes the job
available to workers without a separate broker. `availableAt` controls retry
eligibility; `attempt`, `workerId`, and `lockedAt` record attempts and the
worker lease.

`src/infrastructure/queue/postgres-jobs.ts` claims due jobs in a transaction
using `SELECT ... FOR UPDATE SKIP LOCKED`, then changes the selected job from
`QUEUED` to `RUNNING`. Concurrent workers therefore skip rows locked by other
transactions. Worker concurrency defaults to 2 and is configurable up to 16.
Retries use bounded exponential backoff; explicit retries reset the attempt
counter. Worker heartbeats update the lease timestamp. On startup and
periodically, stale `RUNNING` leases are returned to `QUEUED`, or marked
`FAILED` when the retry limit is exhausted. Stage state is reset or failed in
the same transaction as recovery.

Cancellation of a queued job marks it cancelled in PostgreSQL. Running work
observes `cancelRequestedAt` at stage boundaries. The API and worker both
connect to the same PostgreSQL database; no separate queue service is needed.
Express rate limits use the built-in per-process memory store, so deployments
with multiple API instances should also apply shared rate limiting at the
trusted ingress if a cluster-wide limit is required.

## 8. Security and operational behavior

- **Authentication:** signed HS256 JWT includes a session identifier and user
  subject; the API checks the unrevoked, unexpired session row on protected
  requests.
- **Authorization:** project membership/role is checked at resource access
  boundaries. Do not treat opaque IDs as authorization.
- **Passwords:** Argon2id; raw passwords are not stored.
- **WordPress credentials:** AES-256-GCM encryption uses a base64-encoded
  32-byte secret. The secret must remain stable for existing ciphertext and
  must be backed up securely. Without the key, site credential operations
  return `SITE_CREDENTIALS_UNAVAILABLE`.
- **Input limits:** JSON bodies are capped at 256 KiB; uploads are streamed
  through the API and limited by configured size and project quota. HTTP server
  request/header/keep-alive timeouts are configured in `server.ts`.
- **Rate limits:** global API limit is 120 requests per 60 seconds per process;
  authentication routes additionally allow 10 requests per 15 minutes per
  process.
- **Browser security:** Helmet headers are enabled; CORS permits the configured
  `WEB_ORIGIN` (and requests with no browser Origin header), and credentials
  are disabled. Configure the exact trusted proxy hop count when deployed
  behind reverse proxies.
- **Archive safety:** ZIP inspection limits entries to 10,000, expanded bytes
  to 512 MiB, and compression ratio to 200; it rejects unsafe paths, special
  file types, and encrypted entries.
- **SSRF protection:** the bridge accepts HTTPS hostnames only, checks
  resolved addresses, and uses pinned DNS results. Do not remove these checks
  or enable arbitrary outbound URLs.
- **Error handling:** expected errors are structured; unexpected server errors
  are logged by type and returned generically.
- **Secrets:** never commit `.env`, live JWT keys, database credentials, AI
  keys, or the site credential encryption key.
- **Graceful shutdown:** API closes its HTTP listener and Prisma connection;
  worker stops polling and disconnects its Prisma client.

For production, use HTTPS at the public edge, set `NODE_ENV=production`,
configure `WEB_ORIGIN` as an HTTPS origin, and provision a private persistent
storage volume accessible to both API and worker. Use a strong random
`JWT_SECRET` of at least 32 characters and an independently managed 32-byte
site credential encryption key. Keep logs free of credentials, storage keys,
full uploaded content, and internal error details.

## 9. Installation and local setup

### Required software

1. **Node.js 20.19 or newer** (Prisma 7 minimum; the package declares `node >=20.19.0`).
2. **pnpm** package manager (the project contains `pnpm-lock.yaml`).
3. **PostgreSQL** reachable by `DATABASE_URL`.
4. **Writable local filesystem space** for uploads and artifacts.
5. **Git** to obtain the source repository.

**PHP/Composer and a
WordPress test site are not required to start the API**; they are needed only
when developing/testing the separate WordPress bridge, which is not currently
included. An AI provider key/model is optional because `AI_PROVIDER=disabled`
is supported and no AI adapter is implemented in the current worker.

### Install JavaScript dependencies

From this `server` directory:

```powershell
corepack enable
pnpm install
```

If pnpm is not available through Corepack, install/enable Corepack for the
chosen Node.js installation, then run the same commands. Keep the lockfile in
sync; do not replace the project package manager without changing its workflow.

### Configure local services and environment

Start PostgreSQL and create a database, then copy the example environment
file. The local storage directory is created and checked by the application:

```powershell
Copy-Item .env.example .env
```

Edit `.env` with the database URL and private secrets. Replace the example
`DATABASE_URL` with a valid PostgreSQL URL, for example:

```dotenv
DATABASE_URL=postgresql://postgres:local-password@localhost:5432/design_to_elementor
STORAGE_PROVIDER=local
LOCAL_STORAGE_PATH=./storage/uploads
WEB_ORIGIN=http://localhost:3000
AI_PROVIDER=disabled
```

Use a URL-encoded password if it contains URL-reserved characters. The local
storage directory contains private data; do not serve it as a static web
directory or commit its contents.

### Environment variables

| Variable | Required/default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Runtime mode: development, test, or production |
| `API_PORT` | `4000` | HTTP listen port, 1–65535 |
| `TRUST_PROXY_HOPS` | `0` | Exact number of trusted reverse proxies (0–5) |
| `WEB_ORIGIN` | Required | Allowed browser origin; must be an origin with no path |
| `DATABASE_URL` | Required | PostgreSQL connection URL |
| `JWT_SECRET` | Required | HS256 signing secret, minimum 32 characters |
| `UPLOAD_MAX_BYTES` | `52428800` | Per-file upload limit; configuration maximum is 50 MiB |
| `UPLOAD_QUOTA_BYTES` | `524288000` | Per-project aggregate upload quota |
| `STORAGE_PROVIDER` | `local` | Only supported provider; other values are rejected |
| `LOCAL_STORAGE_PATH` | `./storage/uploads` | Private root; relative paths resolve from the backend package root |
| `AI_PROVIDER` | `disabled` | Provider identifier; enabled values require key and model |
| `AI_API_KEY` | Optional | AI provider credential; unused until a provider adapter exists |
| `AI_MODEL` | Optional | AI model name; unused until a provider adapter exists |
| `SITE_CREDENTIAL_ENCRYPTION_KEY` | Optional until site credentials are used | Base64-encoded 32-byte AES-256-GCM key |
| `CONVERSION_WORKER_CONCURRENCY` | `2` | Worker concurrency, 1–16 |
| `CONVERSION_MAX_ATTEMPTS` | `3` | PostgreSQL worker attempts before permanent failure, 1–5 |

`src/config/env.ts` validates configuration during startup. In production it
requires an HTTPS `WEB_ORIGIN`. Enabled AI providers require both
`AI_API_KEY` and `AI_MODEL`. Generate
a local-only site encryption key with Node.js, if needed:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep the resulting value private and stable for the lifetime of encrypted site
credentials. Do not paste real secrets into documentation or source control.
Set `JWT_SECRET` in `.env` to a separate random value with at least 32
characters; the example uses an obvious placeholder that must be replaced.

### Generate Prisma client and apply migrations

```powershell
pnpm prisma:generate
pnpm prisma:migrate
```

`pnpm prisma:generate` generates Prisma Client into `src/generated/prisma`,
which is imported directly by the application. Prisma 7 requires a runtime
driver adapter; this project uses `@prisma/adapter-pg` and `pg`.

`pnpm prisma:migrate` runs `prisma migrate dev --name init`; it is intended for
a development database. For production, use a controlled deployment migration
workflow (for example `prisma migrate deploy`) rather than a development
migration command. Database connectivity is required for migration
application. The repository's initial SQL migration exists, but this workspace
does not record that it has been applied to a configured PostgreSQL instance.

### Run, test, and build

In separate terminals from the `server` directory:

```powershell
pnpm dev
```

```powershell
pnpm dev:worker
```

The API listens on `http://localhost:4000` by default. Check liveness and
readiness:

```powershell
Invoke-RestMethod http://localhost:4000/api/v1/health/live
Invoke-RestMethod http://localhost:4000/api/v1/health/ready
```

Readiness requires PostgreSQL and the configured object-storage bucket to be
reachable.

Run tests and build:

```powershell
pnpm test
pnpm build
```

Available package scripts:

| Script | Purpose |
|---|---|
| `pnpm dev` | Run API in watch mode using `tsx` |
| `pnpm dev:worker` | Run worker in watch mode |
| `pnpm build` | Compile strict TypeScript from `src/` into `dist/` |
| `pnpm start` | Run compiled API from `dist/server.js` |
| `pnpm start:worker` | Run compiled worker from `dist/worker.js` |
| `pnpm test` | Run the Vitest test suite |
| `pnpm prisma:generate` | Generate Prisma Client |
| `pnpm prisma:migrate` | Create/apply a development migration named `init` |

The production deployment must run the API and worker as separate processes
with the same validated environment and dependency services.

## 10. Testing and quality gates

The repository contains tests for API authentication/authorization and error
boundaries, WordPress bridge security, ZIP inspection, scan concurrency, and
rule-file loading/snapshots. Run them with `pnpm test`, and compile the
TypeScript with `pnpm build`.

Future conversion work should add tests for the approved IR schema, each
pipeline checkpoint, compiler mappings, output validation, retry/cancellation
state transitions, and deterministic/golden output. Integration tests should
cover PostgreSQL job claiming/recovery, local file storage, and the WordPress bridge.
Security regressions should include cross-project access, unsafe archives,
SSRF/DNS rebinding, unauthorized file access, token handling, and duplicate
publishing. Do not treat a green current suite as evidence that the absent
compiler or publishing adapter is implemented.

## 11. Implementation roadmap and explicit non-goals today

1. Obtain and approve the canonical DIR/IR schema and its fixtures.
2. Implement and test deterministic source IR validation and normalized IR
   checkpoints without inventing unsupported input facts.
3. Implement target capability resolution from verified WordPress/Elementor
   capabilities and the selected license profile.
4. Implement the deterministic native Elementor compiler and output
   validation, with regression/golden tests.
5. Add artifact generation and private object-storage persistence, including
   cleanup and retention behavior.
6. Implement and test the WordPress bridge plugin and native write adapter,
   including authorization, idempotency, revocation, and supported-version
   behavior.
7. Add audit-event writes, operational metrics, and production deployment
   configuration as required by product policy.

Until those steps are complete:

- A conversion request being accepted or queued does **not** mean a conversion
  succeeded.
- `atomic`, `legacy`, `hybrid`, `free`, and `pro` in `targetProfile` are input
  choices, not verified compatibility claims.
- Rule-file hashing/snapshotting preserves which rules were requested; it does
  not mean an AI provider is integrated or those rules have been executed by a
  conversion compiler.
- The WordPress capabilities endpoint is read-only verification; document
  creation and updates remain disabled.
- No API endpoint should report success for generated artifacts that do not
  exist.
