# Skill Builder

Record a browser session once, by hand. Everything after that is generated
from it: a deterministic replay that heals itself when the page drifts, a
plain-language summary, a markdown spec an AI agent can read, a whole-site
map of every clickable thing on the target, a batch pass that actually
scores how many of those still work, and a free-text agent that carries out
new instructions by searching that map instead of rediscovering the page
from scratch.

```
Project → Skill (one target site) → Run (one recorded session)
```

A **Project** groups related work. A **Skill** is one target site — a name
and a start URL. Every **Run** under a Skill starts as a live, real
Chromium session under your direct control (forwarded over CDP into the
browser view in your browser) — there's no scripted or LLM-driven
autopilot for the initial recording. What you do in that session — every
click, scroll, and keystroke location — becomes the raw material for
everything else.

## The workflow

A Run's report page is six tabs, each building on the ones before it:

1. **Session artifacts** — the step-by-step action log, a screenshot per
   step, a full seekable video, and the Playwright `trace.zip`.
2. **Flow summary** — an Ollama vision model looks at each step's
   screenshot and captions it, then synthesizes the captions into a short
   narrative and an outcome ("succeeded because...").
3. **Skills.md** — a deterministic markdown rendering of the summary plus
   every step's exact locator, formatted for an AI coding agent to read as
   a spec — no LLM call of its own, since the summary already did the
   interpreting.
4. **Test the skill** — deterministically replays the exact recorded
   clicks using Playwright locators. When the page has drifted since
   recording (an element moved, changed text, or vanished), it pauses and
   tries to recover: first by re-scoring nearby structural signals captured
   at record time, then by asking a vision model to compare the original
   screenshot against the live page's current candidates. A high-confidence
   match auto-heals and gets written back onto the original run so future
   replays don't hit the same drift twice; anything less confident pauses
   for you to confirm or take over manually.
5. **Create alternatives** — two related but distinct things live here:
   - *Per-step alternatives*: for one recorded click, an agent explores the
     live page and suggests other real, genuinely distinct elements you
     could have clicked instead — never invented, always something
     `Accessibility.getFullAXTree()` actually found. Picking one spins up a
     variant run that replays up to that step, then clicks the alternative.
   - *The action graph*: "Build graph" crawls the whole site starting from
     the Skill's URL (nav links and tabs only, so it never touches a
     destructive action on its own), cataloging every interactive element
     it finds — clicked or not — as a node/edge graph in Memgraph, each
     action embedded for semantic retrieval. The graph renders as an
     interactive map (page thumbnails, dagre auto-layout, collapsed
     "N actions here" stubs instead of a converging tangle). "Validate
     alternatives" then actually executes a user-chosen count of those
     cataloged actions — including the ones the crawler deliberately never
     auto-clicked (`Delete`, `Submit`, `Buy`) — and scores pass/fail back
     onto the graph.
6. **Agent** — give it a URL and a free-text instruction ("click
   Quickstart, then click Install"). It breaks the instruction into
   ordered single-action steps, searches the action graph for the closest
   known real match to each one (vector similarity over the same
   embeddings the crawler wrote), has an LLM confirm the match is
   genuine rather than trusting the raw score, and clicks it live —
   grounded in what the crawl already learned about the site instead of
   exploring blind.

"Test the skill" also has a one-click gate: **Test & validate
alternatives** only proceeds to run the validation pass if the test replay
finishes with zero step-level errors, so a broken flow never gets scored
as if its actions still work.

## Everything else

- **Take over mid-recording or mid-replay**: clicks/scrolls/keystrokes on
  the live view are forwarded straight to the real page over CDP. A cursor
  + click-ripple overlay is drawn into the page itself so you can see
  exactly where an action landed, in both the live view and the recorded
  video. Typed *content* is never persisted, only *where* you typed —
  password fields are described generically, never by name.
- **Stop** a run mid-flight, **delete** a project/skill/run (cascades,
  with artifact cleanup), or **download** `trace.zip` for any run.
- **Dashboard**: total runs, success rate, average duration, average steps
  per run, and a 14-day completed/error trend across every project —
  backed by ClickHouse, never blocking a run if it's unreachable.
- **A personal, encrypted variable vault** (Settings → Global variables) —
  write-only secrets stored for your own reference; a value can't be read
  back once set.
- **Accounts**: everything under a Project is private to the account that
  created it.
- **Queued execution**: runs are queued in Redis (BullMQ), not launched
  immediately — `MAX_CONCURRENT_RUNS` caps how many Chromium instances run
  at once; alternative-suggestion jobs queue separately in their own
  out-of-process worker, capped by `MAX_CONCURRENT_ALTERNATIVES`. Any run
  still "queued"/"running" in the database at process startup (a crash or
  redeploy mid-run) is reconciled to `error` before the queue starts
  picking up new work, rather than sitting stuck forever.

## Stack

- **Next.js 16** (App Router) behind a custom Node server (`server.ts`) so
  one process serves the app, the BullMQ worker, and the live-view
  WebSocket together.
- **Playwright**, driven over the Chrome DevTools Protocol — for both the
  human-controlled recording session and every deterministic replay/crawl/
  validation/agent action afterward.
- **Ollama** — the only model provider, used for every AI-assisted feature:
  a vision-chat model captions steps and narrates flows, matches drifted
  elements, and picks alternatives/agent-step candidates; a text-embedding
  model turns action descriptions into vectors for the action graph.
  Nothing here is scripted against a fixed step list — every AI call
  reasons over the real, current page.
- **Postgres + Prisma** — projects, skills, prompts, runs, and their full
  step-by-step report.
- **Memgraph** (with the MAGE vector-search library) — the action graph:
  pages and actions as nodes/edges, each action's embedding indexed with a
  native cosine-similarity vector index for prompt-based retrieval.
- **Redis + BullMQ** — caps concurrent Playwright sessions; a queue, not a
  cache.
- **MinIO** (S3-compatible) — screenshots, `trace.zip`, and run video,
  never touching the local filesystem as durable storage.
- **ClickHouse** — a wide `run_events` table (created/started/completed/
  error, with duration and step count) for the dashboard's metrics.
- Hand-rolled session auth (bcrypt + a `jose`-signed JWT cookie) and
  AES-256-GCM (Node's built-in `crypto`) for variables at rest — no
  third-party auth or secrets service required.

## Running it

The whole stack — app, worker, Postgres, Redis, MinIO, ClickHouse,
Memgraph — runs via Docker Compose:

```bash
docker compose up --build
```

Open http://localhost:3100 and create an account. Ollama itself is **not**
part of the compose stack — it's expected to already be running on your
host machine (`ollama serve`), reachable via Docker Desktop's
`host.docker.internal`, which `docker-compose.yml` already points at by
default. Pull the models the app expects before using anything AI-assisted:

```bash
ollama pull qwen2.5vl        # flow summaries, drift healing, alternatives, agent step-picking
ollama pull nomic-embed-text # action graph embeddings
```

Recording and replaying a session works without Ollama running at all —
only Flow summary, drift healing, Create alternatives, the action graph,
and the Agent tab need it. **Settings → Ollama** shows whether it's
currently reachable and which models are pulled.

This starts with public, insecure default `SESSION_SECRET` and
`ENCRYPTION_KEY` values (visible in `docker-compose.yml`, marked
`CHANGEME`) — fine for trying it out locally, **not fine for anything
reachable by anyone else**: whoever knows `SESSION_SECRET` can forge a
login for any account, and whoever knows `ENCRYPTION_KEY` can decrypt
every stored variable. Before deploying it for real:

```bash
cp .env.example .env
openssl rand -base64 32   # put in .env as SESSION_SECRET
openssl rand -base64 32   # put in .env as ENCRYPTION_KEY
docker compose up --build
```

Docker Compose reads `.env` in this directory automatically and uses it in
place of the defaults.

Artifacts (screenshots, `trace.zip`, video) persist in MinIO's
`minio_data` volume (bucket auto-created on first run); the action graph
persists in Memgraph's `memgraph_data` volume; everything else
(projects/skills/runs/variables) persists in Postgres's `postgres_data`
volume. The MinIO console is at http://localhost:9003 (`MINIO_ROOT_USER` /
`MINIO_ROOT_PASSWORD`, both `CHANGEME` defaults) if you want to browse the
bucket directly.

### Analytics queries

Run-lifecycle events land in ClickHouse's `run_events` table, e.g. via
`docker exec -it skill_builder_clickhouse clickhouse-client --user
skillbuilder --password clickhouse-changeme`:

```sql
-- runs per day
SELECT toDate(event_time) AS day, count()
FROM skillbuilder_analytics.run_events
WHERE event_type = 'created'
GROUP BY day ORDER BY day;

-- success rate
SELECT status, count() FROM skillbuilder_analytics.run_events
WHERE event_type IN ('completed', 'error') GROUP BY status;

-- average duration and step count for completed runs
SELECT avg(duration_ms), avg(step_count)
FROM skillbuilder_analytics.run_events WHERE event_type = 'completed';
```

### Local development (without Docker)

Requires Node 22+ and a local Postgres + Redis + MinIO + ClickHouse +
Memgraph — the simplest way to get all five is `docker compose up postgres
redis minio clickhouse memgraph`, then run the app itself on the host:

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL / REDIS_URL / MINIO_* / CLICKHOUSE_* / MEMGRAPH_URL /
# SESSION_SECRET / ENCRYPTION_KEY / OLLAMA_URL
npx prisma migrate dev
npx playwright install chromium
npm run dev            # app + run worker, in one process
npm run worker         # separate: the out-of-process alternatives worker
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `REDIS_URL` | yes | Redis connection string — queues Playwright runs |
| `SESSION_SECRET` | yes | Signs session JWTs — generate with `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | yes | Encrypts stored variable values — generate with `openssl rand -base64 32` |
| `MAX_CONCURRENT_RUNS` | no (defaults to `2`) | How many Playwright runs (Chromium instances) execute at once |
| `MAX_CONCURRENT_ALTERNATIVES` | no (defaults to `2`) | How many alternative-suggestion jobs (their own Chromium + two LLM calls) run at once |
| `OLLAMA_URL` | no (defaults to `http://host.docker.internal:11434`) | Where to reach Ollama for every AI-assisted feature |
| `FLOW_SUMMARY_MODEL` | no (defaults to `qwen2.5vl:latest`) | Vision-capable model for step captions, flow narration, drift healing, alternatives, and agent planning/picking |
| `EMBEDDING_MODEL` | no (defaults to `nomic-embed-text`) | Text-embedding model for the action graph's vector index |
| `EMBEDDING_DIMENSION` | no (defaults to `768`, matching `nomic-embed-text`) | Override if you switch to an embedding model with a different output width |
| `MEMGRAPH_URL` | yes | Bolt connection string for the action graph |
| `MINIO_ENDPOINT` / `MINIO_PORT` | yes / no (defaults to `9000`) | MinIO host and API port |
| `MINIO_USE_SSL` | no (defaults to `false`) | Set `true` if MinIO is behind TLS |
| `MINIO_BUCKET` | no (defaults to `skill-builder-artifacts`) | Bucket for screenshots/video/`trace.zip`, auto-created on first run |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | yes | MinIO credentials — generate real ones before deploying anywhere reachable by others |
| `CLICKHOUSE_URL` | yes | ClickHouse HTTP interface |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | yes | ClickHouse credentials — generate real ones before deploying anywhere reachable by others |
| `CLICKHOUSE_DATABASE` | no (defaults to `default`) | Database the `run_events` table lives in |
| `PORT` | no (defaults to `3000`) | Port the custom Node server listens on |

## License

MIT — see [LICENSE](./LICENSE).

Contributions welcome: open an issue or a pull request.
