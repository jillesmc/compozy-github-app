// Provider adapter registry (ADR-004): claude (S7), codex (S8), cursor (S9).
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { cursorAdapter } from "./cursor.ts";
import type { AdapterOptions, ProviderAdapter, ProviderId } from "./types.ts";

const FACTORIES: Record<ProviderId, (opts: AdapterOptions) => ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
};

export const PROVIDER_IDS = Object.keys(FACTORIES) as ProviderId[];

// Returns the adapter, or throws an Error whose message is the wrapper's start failure.
export function resolveAdapter(id: string, opts: AdapterOptions = {}): ProviderAdapter {
  if (!Object.hasOwn(FACTORIES, id)) throw new Error(`unknown provider ${id}`);
  return FACTORIES[id as ProviderId](opts);
}
