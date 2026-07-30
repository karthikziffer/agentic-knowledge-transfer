import { verifySession } from "@/server/dal";
import { listGlobalVariables } from "@/server/variables";
import VariablesManager from "@/components/VariablesManager";
import OllamaStatus from "@/components/OllamaStatus";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await verifySession();
  const variables = await listGlobalVariables(session.userId);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5 px-6 py-6">
      <h1 className="page-title">Settings</h1>

      <OllamaStatus />

      <VariablesManager
        endpoint="/api/variables/global"
        title="Global variables"
        hint="Encrypted secrets stored for your own reference. Write-only — once set, a value can't be viewed again."
        initialVariables={variables.map((v) => ({
          key: v.key,
          updatedAt: v.updatedAt.toISOString(),
        }))}
      />
    </div>
  );
}
