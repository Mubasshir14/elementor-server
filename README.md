# Backend README

For the implementation-level system architecture, database model, API
reference, environment variables, installation, and current implementation
limits, see [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md).

## 1. Project Overview

The backend provides authenticated project management and a source-aware intake
pipeline. It supports three source types, each with its own real import method:

- **React / Next.js Project ZIP** — safe archive inspection with automatic
  framework detection from `package.json` and project structure. Uploaded code
  is never executed and untrusted dependencies are never installed.
- **Figma Design** — direct file upload of a **native `.fig`** file (Figma →
  Save local copy) or a Figma REST API file JSON export. The file is parsed
  locally with no Figma account, OAuth, file URL, or API token. Native `.fig`
  files are decoded from their embedded Kiwi schema and node tree.
- **Framer Project** — published-site URL analysis only. The importer inspects
  public HTML over HTTPS with SSRF protections and explicitly reports its
  limitations. It is not native Framer canvas/project recovery.

Capabilities are reported by `GET /api/v1/capabilities`. The **Elementor
conversion pipeline is not implemented**: the approved DIR/IR schema and Elementor
compiler are not present in this repository, so conversion requests return HTTP
501 `CONVERSION_PIPELINE_UNAVAILABLE` and never create a job. The backend must
not treat generic HTML/CSS/JavaScript output as a successful Elementor
conversion.

Screenshot intake is explicitly unsupported.

## 2. Technology Stack

- Node.js
- Express.js
- TypeScript
- PostgreSQL
- Prisma ORM
- PostgreSQL-backed conversion queue with a separate worker process
- Local filesystem storage for private uploads and generated files
- Zod and/or JSON Schema validation
- A configurable AI provider
- A custom WordPress plugin/bridge for connected-site operations

PostgreSQL is the primary database because users, projects, uploads, jobs, rule versions, reports, and artifacts have relationships. Use JSONB for flexible IR and diagnostic payloads. Store large files in the private local storage directory, not directly in database rows.

## 3. Backend Responsibilities

1. Authentication and authorization.
2. Project and upload management.
3. Safe inspection of uploaded source archives.
4. React/Next.js ZIP framework detection.
5. Loading and applying the correct skill/rule files.
6. Creating and validating Source IR.
7. Normalizing and optimizing IR.
8. Resolving the target Elementor capability profile.
9. Compiling Target IR into Elementor-compatible output.
10. Validating the output and producing diagnostics.
11. Storing artifacts and conversion history.
12. Optionally communicating with a connected WordPress site through the bridge.

## 4. Skill and Rule Files

Keep the conversion knowledge in separate, versioned Markdown files. These files define the rules the AI and conversion pipeline must follow.

Recommended files:

```text
backend/
├── rules/
│   ├── ELEMENTOR_SKILL.md
│   ├── FIGMA.md
│   ├── FRAMER.md
│   └── README.md
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
against the shape documented in `FIGMA.md` §2 (only the allowed node kinds
`container`, `heading`, `text`, `button`, `image`, `iconBox`, `nav`, `form`).
`server/src/modules/conversions/conversion-pipeline.ts` orchestrates the stages
and the worker runs it.

**Conversion-stage dependency:** the DIR is produced and validated, but this
repository ships **no native Elementor output generator**. The pipeline therefore
reports `ELEMENTOR_GENERATOR_MISSING` and marks the conversion `BLOCKED` rather
than emitting fabricated Elementor/HTML output. Supplying the approved Elementor
generator is the remaining step to complete a conversion end to end.

### Current operational status

The current API package is run from this directory with `pnpm dev`; the
background worker is `pnpm dev:worker`. Copy `.env.example` to `.env`, provide
PostgreSQL and a writable local storage directory, then run
`pnpm prisma:generate` and `pnpm prisma:migrate`. Do not use production
credentials for local development. The schema was validated and the Prisma
client generated; the initial SQL migration was generated offline, but was not
applied because `DATABASE_URL` was not configured and no local PostgreSQL
client/service was available. The WordPress credential encryption key must be
a base64-encoded 32-byte key. Set `TRUST_PROXY_HOPS` only to the exact number
of trusted reverse proxies in the deployment path. Conversion jobs are
persisted and claimed through PostgreSQL.

The backend now uses Prisma 7: database URLs for CLI commands are configured
in `prisma.config.ts`, and the runtime Prisma Client uses the PostgreSQL driver
adapter. Use Node.js 20.19 or newer.

Implemented versioned routes currently include:

- `/api/v1/auth/register`, `/login`, `/logout`, and `/me`
- `/api/v1/projects` and `/api/v1/projects/:projectId`
- `/api/v1/projects/:projectId/uploads`, `/api/v1/uploads/:uploadId/content`,
  and `/api/v1/uploads/:uploadId/complete`
- `/api/v1/projects/:projectId/imports/framer` and
  `/api/v1/projects/:projectId/imports`
- `/api/v1/projects/:projectId/conversions` and `/api/v1/conversions/:conversionId`
- `/api/v1/conversions/:conversionId/stages`, `/reports`, `/retry`, `/cancel`,
  and `/artifacts`
- `/api/v1/rules`, `/api/v1/sites`, and `/api/v1/artifacts/:artifactId/download`
- `/api/v1/health/live` and `/api/v1/health/ready`

Registration and login accept `{ "email": "...", "password": "..." }` with a
minimum 12-character password. Protected routes require a bearer session token.

### Source import contracts

- **React/Next.js ZIP**: reservation accepts `sourceType: "react-next-zip"`,
  `fileName`, `contentType` (`application/zip` or
  `application/x-zip-compressed`), and `sizeBytes`. The browser streams the file
  to the authenticated content endpoint, then calls completion, which validates
  the archive, detects the framework, and returns `detectedFramework`,
  `sha256`, and status `READY`.
- **Figma**: reservation accepts `sourceType: "figma"`, `fileName` ending in
  `.fig` or `.json`, `contentType` (`application/octet-stream` or
  `application/json`), and `sizeBytes`. The browser streams the file to the
  authenticated content endpoint, then completion parses it locally — native
  `.fig` files are decoded from their embedded Kiwi schema and node tree, and
  `.json` exports are parsed as REST API file JSON — stores it in private
  storage, and creates a `FIGMA_FILE` source import with observed pages, nodes,
  components, and styles plus `sha256`. Native `.fig` uploads are supported; no
  OAuth, file URL, access token, or Figma account connection is required.
- **Framer**: `POST /projects/:projectId/imports/framer` accepts `{ "siteUrl" }`
  and performs published-site analysis only, returning explicit diagnostics about
  what was and was not recovered.

Conversion creation accepts `sourceType`, an optional `detectedFramework`
(React/Next.js), an optional `sourceImportId` (Figma/Framer), `uploadId`
(React/Next.js), `idempotencyKey`, and a `targetProfile` containing
`platform: "elementor"`, `architecture`, and `licenseMode`. These target-profile
values are requests only; they are not a claim that an architecture, widget,
license, or Elementor version is supported. Conversions currently return HTTP
501 `CONVERSION_PIPELINE_UNAVAILABLE`; no job is created until the approved
DIR/compiler exists.

Conversion jobs record the selected rule snapshots, exact SHA-256 hashes,
stages, and diagnostics. They currently stop at `source_ir_validation` with
`APPROVED_IR_SCHEMA_MISSING`: neither the approved DIR/IR schema nor its
regression fixtures were present in the inspected workspace. The backend does
not create an IR schema, compile an Elementor document, or emit a generic
HTML/CSS/JavaScript fallback. Supply the approved schema before implementing
IR validation, optimization, target resolution, compiler output, or conversion
regression tests.

The WordPress API stores credentials encrypted at rest and verifies sites
through the custom bridge capability endpoint
`/wp-json/design-to-elementor/v1/capabilities`. The corresponding WordPress
plugin is not present in this workspace, and native document writes remain
disabled until the bridge and exact installed Elementor capabilities have been
verified. Publishing returns an explicit `NATIVE_PUBLISH_ADAPTER_UNVERIFIED`
error rather than claiming compatibility.
