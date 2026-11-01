import { invoke } from '@tauri-apps/api/core';
import { providerGroupsApi } from './managementApi';
import { cleanProviderGroup } from './providerGroups';

export type CodexBridgeConfig = {
  enabled: boolean;
  startOnLaunch: boolean;
  port: number;
  apiKey: string;
  nodePath: string;
  codexPath: string;
  codexHome: string;
  cpaMarker: string;
};
export type CodexBridgeStatus = {
  config: CodexBridgeConfig;
  running: boolean;
  pid: number | null;
  nodeAvailable: boolean;
  codexAvailable: boolean;
  lastError: string | null;
  baseUrl: string;
};
export const getCodexBridge = () => invoke<CodexBridgeStatus>('get_codex_bridge');
export const saveCodexBridge = (config: CodexBridgeConfig) => invoke<CodexBridgeStatus>('save_codex_bridge', { config });
export const controlCodexBridge = (action: 'start' | 'stop' | 'restart') => invoke<CodexBridgeStatus>('control_codex_bridge', { action });

export const CODEX_BRIDGE_PROVIDER_NAME = 'codex-desktop-bridge';
export function codexBridgeProvider(config: CodexBridgeConfig): Record<string, unknown> {
  return {
    name: CODEX_BRIDGE_PROVIDER_NAME,
    'base-url': `http://127.0.0.1:${config.port}/v1`,
    disabled: !config.enabled,
    headers: { 'X-EasyCLI-Bridge-Route': config.cpaMarker },
    keys: [{ 'api-key': config.apiKey }],
    models: [{ name: 'codex', alias: 'codex-local' }],
  };
}

export async function syncCodexBridgeProvider(config: CodexBridgeConfig, onlyIfPresent = false) {
  const groups = await providerGroupsApi.get('openai-compatibility');
  const index = groups.findIndex(group => group.name === CODEX_BRIDGE_PROVIDER_NAME);
  if (index < 0 && onlyIfPresent) return;
  const provider = codexBridgeProvider(config);
  if (index < 0) groups.push(provider);
  else groups[index] = { ...groups[index], ...provider,
    models: groups[index].models ?? provider.models,
    headers: { ...(groups[index].headers as Record<string, string> | undefined), ...(provider.headers as Record<string, string>) } };
  await providerGroupsApi.put('openai-compatibility', groups.map(cleanProviderGroup));
}
