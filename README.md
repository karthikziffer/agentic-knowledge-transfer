# agentic-knowledge-transfer

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Next.js 16](https://img.shields.io/badge/Next.js-16-black)
![Playwright](https://img.shields.io/badge/Playwright-automation-2EAD33)
![Ollama](https://img.shields.io/badge/AI-Ollama-lightgrey)

Record a browser session once, by hand. Get a self-healing replay, a
plain-language summary, an AI-readable spec, a whole-site action graph, and a
prompt-driven agent — all generated from that one recording.

## Features

- **Record** real browser sessions under your direct control — no scripted
  or LLM-driven autopilot for the initial recording
- **Replay** deterministically, with self-healing when the page drifts
- **Summarize** a run into a plain-language narrative and an AI-readable
  `skills.md` spec
- **Map** a whole site into an action graph (Memgraph + vector search),
  then validate how many cataloged actions still work
- **Agent** — hand it a URL and a free-text instruction; it searches the
  action graph for the closest known action instead of exploring blind
- **Dashboard** with run analytics, backed by ClickHouse

## Quick start

```bash
git clone https://github.com/karthikziffer/agentic-knowledge-transfer.git
cd agentic-knowledge-transfer
docker compose up --build
```

Open http://localhost:3100 and create an account.

Recording and replaying a session works out of the box. A few features
(flow summaries, drift healing, the action graph, the Agent tab) also need
[Ollama](https://ollama.com) running on your host:

```bash
ollama pull qwen2.5vl
ollama pull nomic-embed-text
```

## How it works

```
Project → Skill (one target site) → Run (one recorded session)
```

Each Run's report is a set of tabs, each building on the last:

| Tab | What it does |
| --- | --- |
| Session artifacts | Step-by-step log, screenshots, video, Playwright trace |
| Flow summary | Plain-language narrative of the session |
| Skills.md | Markdown spec of the run, for an AI agent to read |
| Test the skill | Deterministic replay, self-healing on drift |
| Create alternatives | Per-step alternative suggestions, plus a whole-site action graph + validation |
| Agent | Free-text, prompt-driven execution grounded in the action graph |

## Tech stack

Next.js (custom server) · Playwright · Ollama · Postgres/Prisma · Redis/BullMQ
· Memgraph · MinIO · ClickHouse

## Configuration

Copy `.env.example` to `.env` and fill in real secrets before deploying
anywhere reachable by others — the defaults in `docker-compose.yml` are
public and only safe for local use:

```bash
cp .env.example .env
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
```

Every variable is documented inline in `.env.example`.

## Local development

```bash
npm install
cp .env.example .env
docker compose up postgres redis minio clickhouse memgraph
npx prisma migrate dev
npx playwright install chromium
npm run dev
```

## Contributing

Issues and pull requests welcome.

## License

MIT — see [LICENSE](./LICENSE).
