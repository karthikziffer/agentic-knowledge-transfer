"use client";

import { useRouter } from "next/navigation";
import LiveRunView from "@/components/LiveRunView";
import type { RunRecord } from "@/server/types";

// Only rendered while a session is queued/running (see the Skill page) —
// once it settles, refresh so the header button and history table pick up
// the finished run without the visitor having to reload by hand.
export default function LiveSessionPanel({ runId }: { runId: string }) {
  const router = useRouter();

  function handleStatusChange(status: RunRecord["status"]) {
    if (status !== "queued" && status !== "running") {
      router.refresh();
    }
  }

  return (
    <div className="lg:h-[560px] lg:min-h-0">
      <LiveRunView runId={runId} onStatusChange={handleStatusChange} />
    </div>
  );
}
