import type { UpdateSettingsRequest } from '../../shared/ipc.js';
import type { SettingsResult } from '../../shared/ipc.js';

export function toUpdateRequest(settings: SettingsResult, extra?: Partial<UpdateSettingsRequest>): UpdateSettingsRequest {
  return {
    workspace: settings.workspace,
    disabledTools: settings.tools.filter((tool) => !tool.enabled).map((tool) => tool.name),
    presentation: settings.presentation,
    model: settings.model,
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      models: provider.models,
      ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    })),
    prices: settings.prices,
    permissionDenies: settings.permissionDenies,
    ...extra,
  };
}

export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0] ?? 'KiB';
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}
