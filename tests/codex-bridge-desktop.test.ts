import { describe, expect, test } from 'bun:test';
import { providerGroupsApi } from '../src/services/managementApi';
import { canOpenAppPage } from '../src/navigation';

let groups: Record<string, unknown>[] = [];
providerGroupsApi.get = async () => groups;
providerGroupsApi.put = async (_section: string, next: Record<string, unknown>[]) => { groups = next; return {}; };
const { codexBridgeProvider, syncCodexBridgeProvider } = await import('../src/services/codexBridge');
const config = { enabled: true, startOnLaunch: false, port: 8320, apiKey: 'test-bridge-key', nodePath: '', codexPath: '', codexHome: '', cpaMarker: 'route-marker' };

describe('desktop Codex bridge CPA integration', () => {
  test('bridge configuration remains accessible while the CPA core is stopped', () => {
    expect(canOpenAppPage('codex-bridge', false)).toBe(true);
  });
  test('provider uses an independent key and a private route marker', () => {
    const provider = codexBridgeProvider(config);
    expect(provider['base-url']).toBe('http://127.0.0.1:8320/v1');
    expect(provider.keys).toEqual([{ 'api-key': 'test-bridge-key' }]);
    expect(provider.headers).toEqual({ 'X-EasyCLI-Bridge-Route': 'route-marker' });
  });
  test('sync preserves other providers and custom model aliases', async () => {
    const other = { name: 'other-provider', keys: [{ 'api-key': 'other-key' }] };
    groups = [other, { ...codexBridgeProvider(config), models: [{ name: 'custom-model', alias: 'my-alias' }] }];
    await syncCodexBridgeProvider({ ...config, port: 8321, apiKey: 'rotated-key' });
    expect(groups[0]).toEqual(other);
    expect(groups[1].models).toEqual([{ name: 'custom-model', alias: 'my-alias' }]);
    expect(groups[1]['base-url']).toBe('http://127.0.0.1:8321/v1');
    expect(groups[1].keys).toEqual([{ 'api-key': 'rotated-key' }]);
  });
  test('saving without an existing managed provider does not create one implicitly', async () => {
    groups = [];
    await syncCodexBridgeProvider(config, true);
    expect(groups).toEqual([]);
  });
});
