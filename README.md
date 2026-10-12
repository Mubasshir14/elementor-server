# Backend README

For the implementation-level system architecture, database model, API
reference, environment variables, installation, and current implementation
limits, see [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md).

## 1. Project Overview

The backend provides authenticated project management, a source-aware intake
pipeline, and a Markdown-driven AI conversion pipeline to native Elementor JSON.
It supports three active source types, each isolated in its own backend module:

- **React / Next.js Project ZIP** (`src/modules/react-nextjs/`) — safe archive
  inspection (up to 500 MiB compressed, with configurable entry count,
  uncompressed byte, single-entry, and compression-ratio limits), automatic
  React vs. Next.js detection from `package.json` and project structure, bounded
  static source analysis (routes, pages, layouts, UI components, style tokens,
  headings, copy, buttons, navigation, forms, and assets) without executing
  uploaded code or installing dependencies, and end-to-end conversion via
  `REACT_NEXT.md` + `ELEMENTOR_SKILL.md`.
- **Figma Design** (`src/modules/figma/`) — direct file upload (up to 500 MiB)
  of a **native `.fig`** file (Figma → Save local copy) or a Figma REST API file
  JSON export (`.json`). The file is parsed locally with no Figma account,
  OAuth, file URL, or API token. Native `.fig` files are decoded from their
  embedded Kiwi schema and node tree (`figma.parser.ts`) and converted via
  `FIGMA.md` + `ELEMENTOR_SKILL.md`.
- **Framer Project** (`src/modules/framer/`) — published-site URL analysis only.
  The importer inspects public HTML over HTTPS with SSRF protections, explicitly
  reports its limitations, and converts via `FRAMER.md` + `ELEMENTOR_SKILL.md`.

Capabilities are reported by `GET /api/v1/capabilities`. React/Next.js ZIP,
Figma, and Framer conversions are implemented:
`POST /api/v1/projects/:projectId/conversions` creates a queued job that the
worker runs through the Markdown-driven pipeline (source analysis rules →
canonical DIR → DIR validation → `ELEMENTOR_SKILL.md`-based native Elementor
generation → structural output validation → private artifact persistence in
Backblaze B2 or local dev storage). Screenshot conversions remain unavailable
(`501 CONVERSION_PIPELINE_UNAVAILABLE`). The backend never treats generic
HTML/CSS/JavaScript output as a successful Elementor conversion.

## 2. Technology Stack

- Node.js 20.19+
- Express.js 5
- TypeScript
- PostgreSQL + Prisma 7 ORM
- PostgreSQL-backed conversion queue with a separate worker process
- **Backblaze B2** private S3-compatible object storage (`@aws-sdk/client-s3` +
  `@aws-sdk/s3-request-presigner`) for production uploads, snapshots, and
  generated Elementor artifacts (with explicit `STORAGE_PROVIDER=local` adapter
  retained for local development/testing; never silently falls back in production)
- Zod schema validation
- Configurable OpenAI/Groq-compatible AI provider
- Custom WordPress plugin/bridge verification client

PostgreSQL is the system of record for users, projects, uploads, source imports,
jobs, rule versions, reports, and artifact metadata. Actual file bytes and
generated Elementor artifacts are stored privately in Backblaze B2 (or the
local development storage root), never in public folders or database blobs.

## 3. Backend Responsibilities

1. Authentication and authorization.
2. Project and upload management (including direct and multipart uploads up to 500 MiB).
3. Safe inspection and bounded static analysis of uploaded React/Next.js ZIP archives.
4. Local Kiwi binary and JSON parsing of uploaded `.fig` and `.json` Figma design files.
5. Loading and applying runtime Markdown skill/rule files (`REACT_NEXT.md`, `FIGMA.md`, `FRAMER.md`, `ELEMENTOR_SKILL.md`).
6. Creating and validating canonical Source DIR (`dir-schema.ts`).
7. Generating and structurally validating native Elementor JSON (`elementor-generator.ts`, `elementor-output-schema.ts`).
8. Persisting private artifacts in Backblaze B2 / storage and recording SHA-256 + byte size in PostgreSQL.
9. Optionally verifying a connected WordPress site through the bridge.

## 4. Skill and Rule Files

Keep the conversion knowledge in separate, versioned Markdown files. These files define the rules the AI and conversion pipeline must follow.

```text
server/
├── rules/
│   ├── ELEMENTOR_SKILL.md
│   ├── REACT_NEXT.md
│   ├── FIGMA.md
│   └── FRAMER.md
```

### `ELEMENTOR_SKILL.md`

Contains the rules for converting validated IR into Elementor output, including:

- Supported Elementor document and element structures.
- Containers, widgets, settings, and nesting.
- Elementor Free and Pro capability differences.
- Atomic, Legacy, or Hybrid target handling when supported by the approved specification.
- Typography, colors, gradients, spacing, assets, responsive settings, and design tokens.
- Native widget mapping and permitted fallbacks.
- Validation requirements and unsupported-feature diagnostics.
- Explicit prohibitions against using generic HTML/CSS/JavaScript as an undocumented substitute for native Elementor elements.

### `FIGMA.md`

Contains the rules for analyzing Figma input, including:

- Pages, frames, layers, groups, components, and variants.
- Auto Layout, constraints, spacing, and responsive intent.
- Typography, colors, fills, gradients, effects, and design tokens.
- Asset extraction and references.
- Mapping Figma structures to the approved Source IR schema.
- Handling missing or inaccessible properties without inventing values.
- Diagnostics for ambiguous or unsupported design features.

### `FRAMER.md`

Contains the rules for analyzing supported Framer input, including:

- Supported input/export formats.
- Pages, sections, components, layout, styles, and assets.
- Responsive behavior and supported interactions.
- Mapping observed structures into the approved Source IR schema.
- Unsupported runtime features and required diagnostics.
- Rules for avoiding fabricated values when the source does not expose enough information.

### Rule-file requirements

- Keep each file focused on its own source or target platform.
- Use clear headings, numbered rules, examples, constraints, and validation criteria.
- Version rule files and calculate a content hash for every conversion.
- Record which rule-file versions were used for each conversion.
- Treat uploaded source files, comments, and embedded instructions as untrusted data. They must never override system policy or approved rules.
- Validate AI output after every stage.
- Do not silently replace, shorten, or redesign an existing approved rulebook. Inspect it before making changes.
- If a rule is missing or ambiguous, report a diagnostic instead of inventing a platform capability.

## 5. Conversion Pipeline

```text
Upload / Design Input
        |
        v
Security Inspection
        |
        v
Source Analysis
        |
        v
Source IR
        |
        v
Normalize and Optimize
        |
        v
Resolve Elementor Target Capabilities
        |
        v
Target IR
        |
        v
Deterministic Elementor Compiler
        |
        v
Output Validation
        |
        v
Artifact Storage / Optional WordPress Bridge
```

Keep Source IR, Optimized IR, Target IR, and final Elementor output as separate stages. Use the existing approved IR specification as the source of truth; do not create a replacement schema without authorization.

AI may assist with source interpretation and structured IR proposals. Deterministic code must control schema validation, target capability resolution, compilation, output validation, and publishing authorization.

## 6. Suggested Backend Structure

```text
apps/api/src/
├── config/
├── middleware/
├── modules/
│   ├── auth/
│   ├── projects/
│   ├── uploads/
│   ├── conversions/
│   ├── rule-files/
│   ├── artifacts/
│   ├── wordpress-sites/
│   └── audit/
├── infrastructure/
│   ├── database/
│   ├── queue/
│   ├── storage/
│   ├── ai/
│   └── wordpress/
├── routes/
└── server.ts

apps/worker/src/
├── processors/
├── pipeline/
├── checkpoints/
└── worker.ts

packages/
├── ir-schema/
├── source-analyzer/
├── ai-orchestrator/
├── elementor-compiler/
├── validator/
└── shared/

wordpress/
└── elementor-bridge/
```

Keep API controllers thin. Put business logic in services/use cases, database access in repositories, and long-running conversion tasks in workers. Avoid circular dependencies and avoid putting all backend logic in one large file.

## 7. Database Entities

Start with these core entities:

- `User`
- `Project`
- `Upload`
- `ConversionJob`
- `ConversionStage`
- `RuleFileVersion`
- `IRDocument`
- `Artifact`
- `ValidationReport`
- `ConnectedWordPressSite`
- `AuditEvent`

Use PostgreSQL foreign keys, indexes, unique constraints, and transactions where appropriate. Use JSONB for IR and structured diagnostics. Store large ZIP files, images, and generated exports in the private filesystem, and keep only relative keys, checksums, sizes, and metadata in PostgreSQL.

## 8. Background Jobs and Checkpoints

Do not run full conversions inside an HTTP request. Persist conversion jobs in PostgreSQL and process them in the separate worker.

Each major stage should:
1. Record the stage status.
2. Record the input hash and relevant rule/compiler versions.
3. Save the output to a temporary storage location.
4. Validate the output.
5. Persist a checkpoint and output reference.
6. Mark the stage complete.
7. Resume from the last valid checkpoint after a worker restart.

Use bounded worker concurrency, retry limits, exponential backoff, timeouts, cancellation checks, and idempotency keys. Queue messages should contain IDs and storage references rather than large files or full source code.

## 9. API Endpoints

Use versioned endpoints under `/api/v1`. A starting set:

```text
POST   /auth/register
POST   /auth/login
POST   /auth/logout
GET    /auth/me

GET    /projects
POST   /projects
GET    /projects/:projectId
PATCH  /projects/:projectId
DELETE /projects/:projectId

POST   /projects/:projectId/uploads
PUT    /uploads/:uploadId/content
POST   /uploads/:uploadId/complete

POST   /projects/:projectId/conversions
GET    /conversions/:conversionId
GET    /conversions/:conversionId/stages
GET    /conversions/:conversionId/reports
POST   /conversions/:conversionId/retry
POST   /conversions/:conversionId/cancel
GET    /conversions/:conversionId/artifacts

POST   /sites
POST   /sites/:siteId/verify
POST   /sites/:siteId/publish

GET    /health/live
GET    /health/ready
```

These are proposed endpoints; implement and document their actual request and response schemas. Verify project ownership and permissions on every relevant request. Never rely on an ID being difficult to guess as an authorization mechanism.

## 10. Security Requirements

- Validate all request bodies, query parameters, and route parameters.
- Enforce authentication, project ownership, and site-level permissions on the backend.
- Use rate limits, upload quotas, request-size limits, and timeouts.
- Apply strict CORS and secure HTTP headers.
- Keep AI keys, database credentials, storage secrets, and WordPress tokens server-side.
- Do not execute uploaded code or install uploaded dependencies in the API process.
- Protect archive extraction against path traversal, symlinks, archive bombs, and excessive file counts.
- Isolate temporary workspaces and clean them after processing.
- Defend remote integrations against SSRF and unsafe redirects.
- Treat uploaded code, README content, comments, and image text as untrusted input.
- Never let AI call arbitrary shell commands, write arbitrary files, or publish directly to WordPress.
- Store connected-site credentials securely and support revocation.
- Do not expose stack traces, secrets, internal file paths, or storage keys in API responses or logs.

## 11. WordPress and Elementor Integration

Use a custom WordPress plugin/bridge for connected-site operations.

The bridge should:
- Verify the connected site and installed WordPress/Elementor versions.
- Report actual supported capabilities and Free/Pro availability.
- Validate incoming document data and requested operations.
- Check permissions and authenticate each request.
- Use supported WordPress/Elementor APIs for the installed version.
- Resolve media references safely.
- Create or update documents only after explicit user authorization.
- Support idempotency to prevent duplicate pages on retries.
- Return operation status, document reference, and validation diagnostics.
- Reject unsupported structures instead of silently converting them to arbitrary HTML.

Downloadable artifact generation and connected-site publishing should be separate operations. MCP, if used, is an optional execution adapter; it is not the IR schema or the compiler.

## 12. Setup

Prerequisites:
- Node.js 20.19 or newer
- pnpm
- PostgreSQL
- Writable private filesystem storage
- Git
- PHP/Composer and a WordPress test site only for future bridge development

From this server directory, install dependencies:

```bash
pnpm install
```

Configure environment variables in a local `.env` file. Example:

```dotenv
NODE_ENV=development
API_PORT=4000
WEB_ORIGIN=http://localhost:3000
DATABASE_URL=postgresql://postgres:local-password@localhost:5432/design_to_elementor
JWT_SECRET=
AI_PROVIDER=disabled
AI_API_KEY=
AI_MODEL=

STORAGE_PROVIDER=local
LOCAL_STORAGE_PATH=./storage/uploads
```

These are local-development examples, not production credentials. Validate all required environment variables at startup. Never commit a real `.env` file.

Set a private `JWT_SECRET` of at least 32 characters in `.env`, and configure
the database and object-storage values before generating the Prisma client.
Then run:

```bash
pnpm prisma:generate
pnpm prisma:migrate
```

Start the API and worker in separate terminals:

```bash
pnpm dev
pnpm dev:worker
```

Conversion jobs are stored and claimed in PostgreSQL. The worker and API must
use the same database; no additional queue service or container setup is
required.

## 13. Testing Requirements

- Unit tests for services, rule loading, IR validation, compiler mappings, and job state transitions.
- API tests for validation, authentication, authorization, and error responses.
- Integration tests for PostgreSQL-backed job processing, local file storage, and the WordPress bridge.
- Regression tests for approved conversion rules and existing test fixtures.
- Golden tests proving that the same IR and target profile produce equivalent output.
- Security tests for unauthorized access, malicious archives, SSRF, token leakage, and duplicate publishing.
- Load tests for uploads, queue processing, polling, AI limits, and worker recovery.

Do not remove or weaken existing rulebook regression tests to make an implementation pass.

## 14. Implementation Order

1. Inspect the repository and existing rule/IR files.
2. Set up TypeScript, environment validation, PostgreSQL, and private local storage.
3. Implement authentication, projects, and ownership checks.
4. Implement secure upload and private filesystem storage.
5. Load and version `ELEMENTOR_SKILL.md`, `FIGMA.md`, and `FRAMER.md`.
6. Integrate the existing IR schema without redesigning it.
7. Build and test the deterministic IR-to-Elementor compiler.
8. Add the worker pipeline, checkpoints, retries, and cancellation.
9. Add AI source analysis and the supported input adapters.
10. Build the WordPress bridge and verify actual Elementor capabilities.
11. Connect the frontend to the API.
12. Run security, regression, integration, and load tests.

Implement one phase at a time. Keep the application runnable after each phase and report the changed files, tests, failures, and remaining work.

## 15. Definition of Done

A conversion is complete only when:
- The selected rule-file versions are recorded.
- IR passes schema validation.
- Target capabilities have been resolved.
- The deterministic compiler produces supported Elementor structures.
- Output validation completes.
- Artifacts are saved and authorized for download, or a connected-site operation succeeds.
- Warnings and unsupported features are visible.
- Retries do not create duplicate artifacts or WordPress pages.
- Security and regression tests pass.

## 16. Backend foundation status

### Figma direct file upload

Figma intake uses **direct file upload** — no Figma account connection, OAuth,
access token, file URL, or remote Figma API request is involved.

Two formats are accepted:

- **Native `.fig`** files (Figma → File → Save local copy). A `.fig` file is a
  ZIP archive containing `canvas.fig`, a length-prefixed binary in Figma's Kiwi
  serialization format. `server/src/modules/uploads/fig-native.ts` unzips it,
  raw-inflates the embedded (self-describing) schema, Zstandard-decompresses the
  message, and decodes it with `kiwi-schema` into the flat `nodeChanges` array.
  The tree is rebuilt from each node's `parentIndex`, recovering real pages,
  frames, groups, text, fills, strokes, corner radii, typography, Auto Layout,
  and component/instance references. Verified against a real `.fig` fixture in
  `server/tests/fixtures/` (see `tests/fig-native.test.ts`).
- **Figma REST API file JSON** (`GET /v1/files/:key` response), parsed as JSON.

Both are stored in private local storage and recorded as a `FIGMA_FILE`
`SourceImport` in PostgreSQL with the observed structure and structured
diagnostics for anything the file did not expose. No design value is fabricated;
properties the format does not expose become diagnostics, not invented data.

### Markdown-driven AI conversion

Conversion behavior is driven by the editable Markdown files in `server/rules/`:

- `REACT_NEXT.md` + `ELEMENTOR_SKILL.md` for React / Next.js Project ZIP sources,
- `FIGMA.md` + `ELEMENTOR_SKILL.md` for Figma sources,
- `FRAMER.md` + `ELEMENTOR_SKILL.md` for Framer sources.

`server/src/modules/rules/rule-loader.ts` reads the relevant files **at
conversion time** (invalidated by modification time + content hash), so editing a
rule file changes subsequent conversions with no TypeScript change. Missing,
empty, or unreadable rule files fail explicitly — the pipeline never silently
substitutes a hardcoded prompt. The loaded rules become the AI **system**
instructions; the parsed design is passed as a clearly-delimited **untrusted**
user payload so uploaded content can never override the trusted rules.

`server/src/infrastructure/ai/provider.ts` is a thin OpenAI/Groq-compatible
adapter that sends those rules and returns the model's raw text. The AI produces
the canonical DIR, which `server/src/modules/conversions/dir-schema.ts` validates
against the shape documented in `FIGMA.md` §2 and `REACT_NEXT.md` §2 (only the
allowed node kinds `container`, `heading`, `text`, `button`, `image`, `iconBox`,
`nav`, `form`). `server/src/modules/conversions/elementor-generator.ts` then
generates native Elementor JSON under `ELEMENTOR_SKILL.md`, and
`server/src/modules/conversions/elementor-output-schema.ts` structurally
validates the output before storing it as a private `Artifact`.

### Backblaze B2 object storage and 500 MiB upload support

`server/src/modules/storage/` provides the unified `StorageService` abstraction
with two adapters:

- `B2StorageService` (`STORAGE_PROVIDER=b2`): Production S3-compatible adapter
  for Backblaze B2 supporting `putObject`, `getObject`, `headObject`,
  `deleteObject`, `createPresignedUploadUrl`, `createPresignedDownloadUrl`,
  `createMultipartUpload`, `createPresignedPartUpload`, `uploadPart`,
  `completeMultipartUpload`, and `abortMultipartUpload`.
- `LocalStorageService` (`STORAGE_PROVIDER=local`): Explicit development/test
  adapter. In `NODE_ENV=production`, `STORAGE_PROVIDER=local` is rejected so the
  service never silently falls back to local disk when Backblaze B2 is misconfigured.

Required Backblaze B2 environment variables when `STORAGE_PROVIDER=b2`:

```dotenv
STORAGE_PROVIDER=b2
B2_BUCKET_NAME=design-to-elementor-storage
B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
B2_REGION=us-east-005
B2_APPLICATION_KEY_ID=your_application_key_id
B2_APPLICATION_KEY=your_application_key
B2_PRESIGNED_TTL_SECONDS=900
UPLOAD_MAX_BYTES=524288000
```

**Backblaze B2 Bucket CORS Configuration (Required for Direct Browser Presigned Uploads):**
For browser-direct presigned `PUT` uploads and `ETag` reading during multipart uploads, configure CORS on the private bucket (`design-to-elementor-storage`) in the Backblaze B2 Dashboard (or via B2 CLI / S3 `PutBucketCors`):

```json
[
  {
    "corsRuleName": "design-to-elementor-s3-upload",
    "allowedOrigins": [
      "http://localhost:3000"
    ],
    "allowedOperations": [
      "s3_put",
      "s3_get",
      "s3_head"
    ],
    "allowedHeaders": [
      "content-type",
      "content-length",
      "x-amz-*"
    ],
    "exposeHeaders": [
      "ETag",
      "x-amz-request-id"
    ],
    "maxAgeSeconds": 3600
  }
]
```

- Multipart uploads use 8–10 MiB parts by default so a 500 MiB upload uses at most ~50–63 parts.
- Expired pending reservations and incomplete multipart uploads are cleaned up via `cleanupExpiredMultipartUploads`.

### Source import and conversion contracts

- **React/Next.js ZIP**: reservation accepts `sourceType: "react-next-zip"`,
  `fileName`, `contentType` (`application/zip` or
  `application/x-zip-compressed`), and `sizeBytes` up to **500 MiB
  (`524_288_000` bytes)**. Completion validates archive safety (`ZIP_MAX_ENTRIES`,
  `ZIP_MAX_UNCOMPRESSED_BYTES`, `ZIP_MAX_ENTRY_BYTES`,
  `ZIP_MAX_COMPRESSION_RATIO`), detects `react` or `nextjs`, performs bounded
  static source analysis (`analyzeReactNextProjectZip`), persists a
  `REACT_NEXT_PROJECT` `SourceImport` snapshot in storage, and returns
  `detectedFramework`, `sha256`, status `READY`, and `sourceImport`.
  Detailed inspection data is also available at
  `GET /api/v1/projects/:projectId/react-nextjs/uploads/:uploadId/inspection`.
- **Figma**: reservation accepts `sourceType: "figma"`, `fileName` ending in
  `.fig` or `.json`, `contentType` (`application/octet-stream` or
  `application/json`), and `sizeBytes` up to **500 MiB (`524_288_000` bytes)**.
  Completion parses the file locally (`figma.parser.ts`) and creates a
  `FIGMA_FILE` `SourceImport` with observed pages, frames, nodes, components,
  variants, Auto Layout, and styles. No OAuth, file URL, access token, or Figma
  account connection is required.
- **Framer**: `POST /api/v1/projects/:projectId/imports/framer` accepts
  `{ "siteUrl" }` and performs published-site HTML analysis over HTTPS with SSRF
  protections.
- **Conversions**: `POST /api/v1/projects/:projectId/conversions` queues a job
  for `react-next-zip`, `figma`, or `framer` with the current Markdown rule
  snapshots (`REACT_NEXT.md`/`FIGMA.md`/`FRAMER.md` + `ELEMENTOR_SKILL.md`) and
  persists the validated native Elementor JSON artifact privately.

