import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Durable, metadata-only inbox. The desktop imports each stable request ID into
// its existing usage database before deleting the file, so replay is idempotent.
export function trackUsage(req, res, config) {
  const viaCpa = Boolean(config.cpaMarker && req.headers['x-easycli-bridge-route'] === config.cpaMarker);
  if (!config.usageDir || viaCpa) return {};
  const start = performance.now();
  const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const event = { request_id: `codex-bridge-${randomUUID()}`, timestamp: new Date().toISOString(),
    provider: 'codex-bridge', source: 'Codex App Server bridge', auth_type: 'apikey',
    executor_type: 'CodexBridgeResponsesExecutor', endpoint: `POST ${new URL(req.url, 'http://localhost').pathname}`,
    api_key_hash: key ? createHash('sha256').update(key).digest('hex') : '',
    api_key_display: key ? `***${key.slice(-4)}` : '', model: 'unknown', generate: true };
  let written = false;
  const write = () => {
    if (written) return;
    written = true;
    event.latency_ms = Math.round(performance.now() - start);
    event.failed = event.failed === true || res.statusCode >= 400 || !res.writableEnded;
    event.failure_status = event.failed ? (event.failure_status ?? (!res.writableEnded ? 499 : res.statusCode)) : 0;
    event.tokens ??= { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    try {
      mkdirSync(config.usageDir, { recursive: true, mode: 0o700 });
      if (readdirSync(config.usageDir).length >= 10000) throw new Error('inbox full');
      const path = join(config.usageDir, `${event.request_id}.json`);
      writeFileSync(`${path}.tmp`, JSON.stringify(event), { mode: 0o600, flag: 'wx' });
      renameSync(`${path}.tmp`, path);
    } catch { console.error('Codex bridge could not persist usage metadata. Check the usage inbox directory.'); }
  };
  res.once('finish', write);
  res.once('close', write);
  return event;
}

export function updateUsage(event, usage) {
  if (!usage) return;
  event.tokens = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens,
    cache_read_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 };
  event.token_usage_reported = true;
}
