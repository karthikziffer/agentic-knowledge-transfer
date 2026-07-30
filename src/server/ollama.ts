// Docker Desktop (Mac/Windows) resolves this to the host machine — Ollama
// runs on the host, not in this compose stack, so it's reached the same
// way any other host-side service would be. Overridable via OLLAMA_URL for
// setups where Ollama lives somewhere else (a remote box, a different
// Docker network, plain `npm run dev` on the host itself, etc).
const DEFAULT_OLLAMA_URL = "http://host.docker.internal:11434";

// How long to wait before treating Ollama as unreachable — the host may
// simply not be running it, which should read as "not connected" quickly
// rather than hang the settings page.
const TIMEOUT_MS = 4000;

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
  family: string;
  capabilities: string[];
}

export interface OllamaStatus {
  connected: boolean;
  baseUrl: string;
  models: OllamaModel[];
  error?: string;
}

interface OllamaTagsResponse {
  models?: {
    name: string;
    size: number;
    details?: { parameter_size?: string; quantization_level?: string; family?: string };
    capabilities?: string[];
  }[];
}

export function getOllamaUrl(): string {
  return process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;
}

// Never throws — a caller (the Settings page / its API route) always gets a
// well-formed status back, "not connected" included, rather than having to
// handle a rejected promise on top of the connected/disconnected states.
export async function checkOllamaConnection(): Promise<OllamaStatus> {
  const baseUrl = getOllamaUrl();
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { connected: false, baseUrl, models: [], error: `Ollama responded with HTTP ${res.status}` };
    }
    const data = (await res.json()) as OllamaTagsResponse;
    const models: OllamaModel[] = (data.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      parameterSize: m.details?.parameter_size ?? "",
      quantization: m.details?.quantization_level ?? "",
      family: m.details?.family ?? "",
      capabilities: m.capabilities ?? [],
    }));
    return { connected: true, baseUrl, models };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? "Timed out reaching Ollama — is it running?"
        : err instanceof Error
          ? err.message
          : "Failed to reach Ollama";
    return { connected: false, baseUrl, models: [], error: message };
  }
}
