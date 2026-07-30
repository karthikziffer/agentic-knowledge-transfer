import { createClient, type ClickHouseClient } from "@clickhouse/client";

const TABLE = "run_events";

function createAnalyticsClient(): ClickHouseClient {
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is not set");
  return createClient({
    url,
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
    database: process.env.CLICKHOUSE_DATABASE || "default",
  });
}

// Constructing the client touches CLICKHOUSE_URL, which isn't available at
// `next build` time (only at container runtime) — same reasoning as the
// lazy Prisma/MinIO/BullMQ clients elsewhere in src/server. Unlike those,
// nothing here is accessed via property chains at import time (trackRunEvent
// is a plain function), so a lazy getter is enough — no Proxy needed.
const globalKey = Symbol.for("skill-builder.clickhouse");
type GlobalWithClickHouse = typeof globalThis & { [globalKey]?: ClickHouseClient };
const g = globalThis as GlobalWithClickHouse;

function getClient(): ClickHouseClient {
  return g[globalKey] ?? (g[globalKey] = createAnalyticsClient());
}

let schemaReady: Promise<void> | undefined;

// One wide, flat events table — the idiomatic ClickHouse shape for this
// kind of analytics. Memoized so it's only actually created once per
// process, same pattern as ensureBucket() in artifacts.ts.
function ensureSchema(): Promise<void> {
  return (schemaReady ??= getClient()
    .command({
      query: `
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          event_time DateTime64(3) DEFAULT now64(3),
          event_type LowCardinality(String),
          run_id String,
          user_id String,
          project_id String,
          skill_id String,
          prompt_id String,
          status LowCardinality(String),
          error String,
          step_count UInt32,
          duration_ms UInt64
        )
        ENGINE = MergeTree()
        ORDER BY (event_time, run_id)
      `,
    })
    .then(() => undefined));
}

export interface RunEvent {
  eventType: "created" | "started" | "completed" | "error";
  runId: string;
  userId: string;
  projectId?: string;
  skillId?: string;
  promptId: string;
  status?: string;
  error?: string;
  stepCount?: number;
  durationMs?: number;
}

export interface DashboardMetrics {
  totalRuns: number;
  completedRuns: number;
  errorRuns: number;
  successRate: number; // 0-100, rounded
  avgDurationMs: number;
  avgSteps: number;
  // Zero-filled for every day in the window, oldest first — a caller can
  // render it as a bar chart without doing its own gap-filling.
  dailyRuns: { date: string; completed: number; error: number }[];
}

const EMPTY_METRICS: DashboardMetrics = {
  totalRuns: 0,
  completedRuns: 0,
  errorRuns: 0,
  successRate: 0,
  avgDurationMs: 0,
  avgSteps: 0,
  dailyRuns: [],
};

const TREND_DAYS = 14;

interface SummaryRow {
  total_runs: string;
  completed_runs: string;
  error_runs: string;
  avg_duration_ms: string | null;
  avg_steps: string | null;
}

interface DailyRow {
  day: string;
  completed: string;
  error: string;
}

// Dashboard-facing aggregate — scoped to one user's own runs. Only
// "completed"/"error" events carry final stats (duration/step count), so
// those are the two event types every aggregate here counts against;
// "created"/"started" exist in the table but would double-count a run.
// Never throws — a metrics query failing must never take the dashboard
// down with it, same reasoning as trackRunEvent swallowing its errors.
export async function getDashboardMetrics(userId: string): Promise<DashboardMetrics> {
  try {
    await ensureSchema();
    const client = getClient();

    const [summaryRows, dailyRows] = await Promise.all([
      client
        .query({
          query: `
            SELECT
              countIf(event_type IN ('completed','error')) AS total_runs,
              countIf(event_type = 'completed') AS completed_runs,
              countIf(event_type = 'error') AS error_runs,
              avgIf(duration_ms, event_type = 'completed' AND duration_ms > 0) AS avg_duration_ms,
              avgIf(step_count, event_type IN ('completed','error') AND step_count > 0) AS avg_steps
            FROM ${TABLE}
            WHERE user_id = {userId:String}
          `,
          query_params: { userId },
          format: "JSONEachRow",
        })
        .then((r) => r.json<SummaryRow>()),
      client
        .query({
          query: `
            SELECT
              toDate(event_time) AS day,
              countIf(event_type = 'completed') AS completed,
              countIf(event_type = 'error') AS error
            FROM ${TABLE}
            WHERE user_id = {userId:String}
              AND event_type IN ('completed','error')
              AND event_time >= now() - INTERVAL ${TREND_DAYS - 1} DAY
            GROUP BY day
            ORDER BY day
          `,
          query_params: { userId },
          format: "JSONEachRow",
        })
        .then((r) => r.json<DailyRow>()),
    ]);

    const s = summaryRows[0];
    const totalRuns = Number(s?.total_runs ?? 0);
    const completedRuns = Number(s?.completed_runs ?? 0);
    const errorRuns = Number(s?.error_runs ?? 0);

    const byDay = new Map(
      dailyRows.map((r) => [r.day, { completed: Number(r.completed), error: Number(r.error) }]),
    );
    const dailyRuns: DashboardMetrics["dailyRuns"] = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      dailyRuns.push({ date: key, ...(byDay.get(key) ?? { completed: 0, error: 0 }) });
    }

    return {
      totalRuns,
      completedRuns,
      errorRuns,
      successRate: totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0,
      avgDurationMs: Math.round(Number(s?.avg_duration_ms ?? 0)),
      avgSteps: Math.round(Number(s?.avg_steps ?? 0)),
      dailyRuns,
    };
  } catch (err) {
    console.error("analytics: failed to load dashboard metrics", err);
    return EMPTY_METRICS;
  }
}

// Fire-and-forget: analytics must never block or fail the actual run, so
// this never returns a rejecting promise to the caller — failures are
// logged and swallowed instead of thrown.
export function trackRunEvent(event: RunEvent): void {
  void (async () => {
    try {
      await ensureSchema();
      await getClient().insert({
        table: TABLE,
        values: [
          {
            event_type: event.eventType,
            run_id: event.runId,
            user_id: event.userId,
            project_id: event.projectId ?? "",
            skill_id: event.skillId ?? "",
            prompt_id: event.promptId,
            status: event.status ?? "",
            error: event.error ?? "",
            step_count: event.stepCount ?? 0,
            duration_ms: event.durationMs ?? 0,
          },
        ],
        format: "JSONEachRow",
      });
    } catch (err) {
      console.error("analytics: failed to track run event", event.eventType, err);
    }
  })();
}
