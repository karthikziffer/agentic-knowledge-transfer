import type { DashboardMetrics as DashboardMetricsData } from "@/server/analytics";

const CHART_HEIGHT_PX = 64;

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatShortDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export default function DashboardMetrics({ metrics }: { metrics: DashboardMetricsData }) {
  return (
    <div className="mb-6 flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Total runs" value={metrics.totalRuns.toLocaleString()} />
        <MetricCard
          label="Success rate"
          value={`${metrics.successRate}%`}
          hint={`${metrics.completedRuns} completed · ${metrics.errorRuns} failed`}
        />
        <MetricCard label="Avg duration" value={formatDuration(metrics.avgDurationMs)} />
        <MetricCard label="Avg steps / run" value={metrics.avgSteps.toString()} />
      </div>

      {metrics.totalRuns > 0 ? (
        <TrendChart daily={metrics.dailyRuns} />
      ) : (
        <div className="card px-5 py-4 text-[13px] text-ink-muted">
          Runs will show up here once you start a session.
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-5">
      <p className="eyebrow mb-1.5">{label}</p>
      <p className="text-2xl font-bold tracking-tight text-ink">{value}</p>
      {hint && <p className="mt-1 truncate text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

function TrendChart({ daily }: { daily: DashboardMetricsData["dailyRuns"] }) {
  const max = Math.max(1, ...daily.map((d) => d.completed + d.error));

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-ink">Runs, last 14 days</h3>
        <div className="flex items-center gap-3 text-xs text-ink-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-done" aria-hidden />
            Completed
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-error" aria-hidden />
            Error
          </span>
        </div>
      </div>

      <div className="flex items-end gap-1.5" style={{ height: CHART_HEIGHT_PX }}>
        {daily.map((d) => {
          const total = d.completed + d.error;
          const totalPx = total === 0 ? 0 : Math.max(3, Math.round((total / max) * CHART_HEIGHT_PX));
          const completedPx = total === 0 ? 0 : Math.round((d.completed / total) * totalPx);
          const errorPx = totalPx - completedPx;
          return (
            <div
              key={d.date}
              className="flex flex-1 flex-col justify-end"
              style={{ height: CHART_HEIGHT_PX }}
              title={`${d.date}: ${d.completed} completed, ${d.error} error`}
            >
              {total === 0 ? (
                <div className="w-full rounded-sm bg-surface-2" style={{ height: 3 }} />
              ) : (
                <>
                  {errorPx > 0 && <div className="w-full rounded-t-sm bg-error" style={{ height: errorPx }} />}
                  {completedPx > 0 && (
                    <div
                      className={`w-full bg-done ${errorPx > 0 ? "" : "rounded-t-sm"}`}
                      style={{ height: completedPx }}
                    />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-ink-faint">
        <span>{formatShortDate(daily[0].date)}</span>
        <span>{formatShortDate(daily[daily.length - 1].date)}</span>
      </div>
    </div>
  );
}
