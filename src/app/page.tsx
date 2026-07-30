import { verifySession } from "@/server/dal";
import { listDashboardProjects } from "@/server/dashboard";
import { getDashboardMetrics } from "@/server/analytics";
import CreateProjectWizard from "@/components/CreateProjectWizard";
import DashboardMetrics from "@/components/DashboardMetrics";
import DashboardProjectsTable from "@/components/DashboardProjectsTable";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await verifySession();
  const [projects, metrics] = await Promise.all([
    listDashboardProjects(session.userId),
    getDashboardMetrics(session.userId),
  ]);

  return (
    <div className="w-full px-8 py-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="page-title">Dashboard</h1>
        <CreateProjectWizard />
      </div>

      <DashboardMetrics metrics={metrics} />

      <h2 className="eyebrow mb-3">Projects</h2>
      <DashboardProjectsTable projects={projects} />
    </div>
  );
}
