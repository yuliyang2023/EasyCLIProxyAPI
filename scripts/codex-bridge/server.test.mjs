import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createBridge, normalizeRequest, configFromEnv } from './server.mjs';

const fixture = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
async function start(t, options = {}) {
  const bridge = createBridge({ command: process.execPath, args: [fixture], ...options });
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  return { ...bridge, origin: `http://127.0.0.1:${bridge.server.address().port}` };
}
const request = (origin, body, path = '/v1/chat/completions', headers = {}) => fetch(origin + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const messages = content => [{ role: 'user', content }];
const frames = value => value.split('\n\n').filter(Boolean).map(frame => {
  const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
  return data === '[DONE]' ? data : JSON.parse(data);
});

test('normalization keeps roles and structured history instead of flattening them into a prompt', () => {
  const normalized = normalizeRequest({ model: 'model-a', messages: [
    { role: 'system', content: 'Be brief' }, { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' }, { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ] });
  assert.equal(normalized.instructions, 'Be brief');
  assert.equal(normalized.prompt, 'next');
  assert.deepEqual(normalized.history.map(x => [x.role, x.content[0].type]), [['user', 'input_text'], ['assistant', 'output_text']]);
});

test('unsupported options and content fail explicitly', () => {
  for (const body of [
    { messages: messages('x'), seed: 0 }, { messages: messages('x'), tools: [{}] },
    { messages: messages('x'), stream: 'true' }, { messages: messages('x'), store: true },
    { messages: messages('x'), n: 2 }, { messages: [{ role: 'tool', content: 'x' }] },
    { messages: messages([{ type: 'image_url', image_url: { url: 'https://example.test/x' } }]) },
    { messages: [{ role: 'user', content: 'x' }, { role: 'system', content: 'late instruction' }] },
    { messages: messages('x'), response_format: { type: 'json_object' } },
  ]) assert.throws(() => normalizeRequest(body), { status: 400 });
  assert.throws(() => normalizeRequest({ input: 'x', previous_response_id: 'old' }, true), { status: 400 });
});

test('JSON schema and reasoning are passed as structured selections', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  assert.deepEqual(normalizeRequest({ input: 'x', reasoning: { effort: 'high' }, text: { format: { type: 'json_schema', schema } } }, true).outputSchema, schema);
});

test('loopback defaults and remote authentication guard', () => {
  assert.equal(configFromEnv({}).host, '127.0.0.1');
  assert.throws(() => configFromEnv({ CODEX_BRIDGE_HOST: '0.0.0.0' }));
  assert.throws(() => configFromEnv({ CODEX_BRIDGE_MAX_CONCURRENT: '0' }));
  assert.equal(configFromEnv({ CODEX_BRIDGE_HOST: '0.0.0.0', CODEX_BRIDGE_API_KEY: 'fixture-key' }).host, '0.0.0.0');
});

test('models discovery paginates and includes the Codex default alias', async t => {
  const { origin } = await start(t);
  const res = await fetch(origin + '/v1/models');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.map(m => m.id), ['codex', 'model-a', 'model-b']);
});

test('non-streaming chat returns only assistant answer and actual usage', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { messages: messages('你好 world') });
  assert.equal(res.status, 200);
  const value = await res.json();
  assert.equal(value.choices[0].message.content, '你好 world');
  assert.equal(value.usage.total_tokens, 25);
  assert.equal(value.usage.prompt_tokens_details.cached_tokens, 3);
});

test('history is injected with user and assistant roles before starting the turn', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { messages: [{ role: 'user', content: 'prior' }, { role: 'assistant', content: 'answer' }, ...messages('history')] });
  const history = JSON.parse((await res.json()).choices[0].message.content);
  assert.deepEqual(history.map(m => m.role), ['user', 'assistant']);
});

test('chat SSE carries deltas, usage and DONE without commentary', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { messages: messages('streamed'), stream: true, stream_options: { include_usage: true } });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = frames(await res.text());
  assert.equal(events.at(-1), '[DONE]');
  assert.equal(events.filter(x => x.choices?.length).map(x => x.choices[0].delta.content ?? '').join(''), 'streamed');
  assert.equal(events.at(-2).usage.total_tokens, 25);
  assert.equal(events.at(-3).choices[0].finish_reason, 'stop');
});

test('missing deltas are recovered from completed item without duplication', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { messages: messages('completion-fallback'), stream: true });
  assert.equal(frames(await res.text()).filter(x => x.choices?.length).map(x => x.choices[0].delta.content ?? '').join(''), 'completion-fallback');
});

test('Responses JSON returns a message output item', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { input: 'response text' }, '/v1/responses');
  const value = await res.json();
  assert.equal(value.status, 'completed');
  assert.equal(value.output[0].content[0].text, 'response text');
  assert.equal(value.usage.input_tokens, 20);
});

test('Responses SSE follows output item/content part lifecycle', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { input: 'response stream', stream: true }, '/v1/responses');
  const events = frames(await res.text());
  assert.equal(events[0].type, 'response.created');
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output_text, 'response stream');
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
  assert.equal(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), 'response stream');
});

test('authentication protects API endpoints and health remains probeable', async t => {
  const { origin } = await start(t, { apiKey: 'test-key' });
  assert.equal((await fetch(origin + '/healthz')).status, 200);
  assert.equal((await fetch(origin + '/v1/models')).status, 401);
  const res = await request(origin, { messages: messages('ok') }, undefined, { Authorization: 'Bearer test-key' });
  assert.equal(res.status, 200);
  await res.text();
});

test('validation, unknown routes and body limits do not start generation', async t => {
  const { origin } = await start(t, { bodyLimit: 100 });
  assert.equal((await request(origin, { messages: messages('x'), seed: 1 })).status, 400);
  assert.equal((await request(origin, { messages: messages('x'.repeat(150)) })).status, 413);
  assert.equal((await fetch(origin + '/missing')).status, 404);
  assert.equal((await fetch(origin + '/v1/chat/completions', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(origin + '/v1/chat/completions', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
});

test('upstream RPC errors are sanitized and process crashes are bounded', async t => {
  const { origin } = await start(t);
  for (const model of ['rpc-error', 'crash']) {
    const res = await request(origin, { model, messages: messages('x') });
    assert.equal(res.status, 502);
    assert.doesNotMatch(await res.text(), /sensitive upstream data/);
  }
});

test('interactive tools and failed turns cannot hang an HTTP request', async t => {
  const { origin } = await start(t);
  for (const [prompt, status] of [['permission', 422], ['failure', 502]]) {
    const res = await request(origin, { messages: messages(prompt) });
    assert.equal(res.status, status);
  }
});

test('timeout ends stalled turns and capacity recovers', async t => {
  const { origin } = await start(t, { timeoutMs: 250 });
  const res = await request(origin, { messages: messages('hang') });
  assert.equal(res.status, 504);
  await res.text();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await (await fetch(origin + '/healthz')).json()).active, 0);
});

test('concurrency rejects excess work and client disconnect cleans up the process', async t => {
  const { origin } = await start(t, { maxConcurrent: 1 });
  const controller = new AbortController();
  const first = fetch(origin + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages('hang') }), signal: controller.signal }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await request(origin, { messages: messages('x') })).status, 429);
  controller.abort();
  await first;
  for (let i = 0; i < 50; i++) {
    const state = await (await fetch(origin + '/healthz')).json();
    if (!state.active) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Disconnected request still consumes capacity.');
});

test('missing executable returns 503 instead of an unhandled process error', async t => {
  const { origin } = await start(t, { command: '/does-not-exist/codex', args: [] });
  const res = await request(origin, { messages: messages('x') });
  assert.equal(res.status, 503);
});

test('generation failure after streaming starts emits error without a success finish', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { messages: messages('stream-failure'), stream: true });
  assert.equal(res.status, 200);
  const events = frames(await res.text());
  assert.equal(events.at(-2).error.code, 'upstream_error');
  assert.equal(events.some(e => e.choices?.[0]?.finish_reason === 'stop'), false);
});

test('total timeout also bounds incomplete request uploads', async t => {
  const { origin } = await start(t, { timeoutMs: 100 });
  const result = await new Promise((resolve, reject) => {
    const req = http.request(origin + '/v1/chat/completions', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': '100',
    } }, res => {
      res.resume();
      res.on('end', () => { resolve(res.statusCode); req.destroy(); });
    });
    req.on('error', reject);
    req.write('{');
  });
  assert.equal(result, 504);
});

test('simultaneous calls have independent Codex processes and answers', async t => {
  const { origin } = await start(t);
  const answers = await Promise.all(['alpha', 'beta', 'gamma'].map(async value => {
    const res = await request(origin, { messages: messages(value) });
    assert.equal(res.status, 200);
    return (await res.json()).choices[0].message.content;
  }));
  assert.deepEqual(answers, ['alpha', 'beta', 'gamma']);
});

test('iTerm2 Chat Completions body accepts token and sampling hints in JSON and SSE', async t => {
  const { origin } = await start(t);
  for (const stream of [false, true]) {
    const res = await request(origin, { model: 'codex', messages: messages('iTerm2 compatible'),
      max_tokens: 4096, temperature: 0, stream });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-codex-bridge-ignored-parameters'), 'max_tokens, temperature');
    if (stream) {
      const events = frames(await res.text());
      assert.equal(events.filter(x => x.choices?.length).map(x => x.choices[0].delta.content ?? '').join(''), 'iTerm2 compatible');
      assert.equal(events.at(-1), '[DONE]');
    } else assert.equal((await res.json()).choices[0].message.content, 'iTerm2 compatible');
  }
});

test('Responses accepts max_output_tokens and reports it as unapplied', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { input: 'response cap hint', max_output_tokens: 4096, top_p: 1 }, '/v1/responses');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-codex-bridge-ignored-parameters'), 'max_output_tokens, top_p');
  assert.equal((await res.json()).output_text, 'response cap hint');
});

test('token and sampling hints are validated and null hints do not create warnings', () => {
  assert.deepEqual(normalizeRequest({ messages: messages('x'), max_completion_tokens: 64 }).ignoredParameters, ['max_completion_tokens']);
  assert.deepEqual(normalizeRequest({ messages: messages('x'), max_tokens: null, temperature: null }).ignoredParameters, []);
  for (const max_tokens of [0, -1, 1.5, '128', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeRequest({ messages: messages('x'), max_tokens }), { status: 400 });
  }
  for (const temperature of [-1, 3, '0']) {
    assert.throws(() => normalizeRequest({ messages: messages('x'), temperature }), { status: 400 });
  }
  for (const top_p of [-0.1, 1.1, '1']) {
    assert.throws(() => normalizeRequest({ messages: messages('x'), top_p }), { status: 400 });
  }
});

const functionTools = [{ type: 'function', function: { name: 'run_terminal_command', description: 'Run a command in the selected iTerm2 terminal',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];
const callback = (history, message, values) => [...history, message, ...message.tool_calls.map((call, i) => ({ role: 'tool', tool_call_id: call.id, content: values[i] }))];

test('caller-defined tools return standard tool_calls and resume the SAME Codex turn', async t => {
  const { origin } = await start(t);
  const initial = messages('dynamic-call');
  const res = await request(origin, { messages: initial, tools: functionTools, tool_choice: 'auto', max_tokens: 4096, temperature: 0 });
  assert.equal(res.status, 200);
  const first = await res.json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  assert.equal(first.usage.total_tokens, 22);
  const message = first.choices[0].message;
  assert.equal(message.tool_calls[0].function.name, 'run_terminal_command');
  assert.match(message.tool_calls[0].id, /^call_[a-f0-9]{32}$/);
  assert.equal(JSON.parse(message.tool_calls[0].function.arguments).command, 'ps');
  assert.equal((await (await fetch(origin + '/healthz')).json()).pending_tools, 1);
  const second = await request(origin, { messages: callback(initial, message, ['PID 123 CPU 50%']), tools: functionTools });
  assert.equal(second.status, 200);
  const answer = await second.json();
  assert.equal(answer.choices[0].finish_reason, 'stop');
  assert.equal(answer.choices[0].message.content, 'received: PID 123 CPU 50%');
  assert.equal(answer.usage.total_tokens, 13, 'Tool callback must not double-count usage already returned.');
});

test('streaming tool calls include index, ID, name and JSON arguments and end with tool_calls', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { messages: messages('dynamic-call'), tools: functionTools, stream: true });
  const events = frames(await res.text());
  const call = events.find(e => e.choices?.[0]?.delta.tool_calls)?.choices[0].delta.tool_calls[0];
  assert.equal(call.index, 0);
  assert.equal(call.type, 'function');
  assert.equal(call.function.name, 'run_terminal_command');
  assert.equal(events.at(-2).choices[0].finish_reason, 'tool_calls');
  assert.equal(events.at(-1), '[DONE]');
});

test('parallel tool results must all be returned; invalid callback can be corrected', async t => {
  const { origin } = await start(t);
  const initial = messages('parallel-call');
  const first = await (await request(origin, { messages: initial, tools: functionTools })).json();
  const message = first.choices[0].message;
  assert.equal(message.tool_calls.length, 2);
  const full = callback(initial, message, ['one', 'two']);
  assert.equal((await request(origin, { messages: full.slice(0, -1), tools: functionTools })).status, 400);
  const corrected = await request(origin, { messages: full, tools: functionTools });
  assert.equal(corrected.status, 200);
  assert.equal((await corrected.json()).choices[0].message.content, 'received: one | two');
});

test('repeated tool rounds preserve the suspended connection until final answer', async t => {
  const { origin } = await start(t);
  let history = messages('two-rounds');
  for (let round = 1; round <= 2; round++) {
    const res = await request(origin, { messages: history, tools: functionTools });
    assert.equal(res.status, 200);
    const message = (await res.json()).choices[0].message;
    assert.equal(JSON.parse(message.tool_calls[0].function.arguments).round, round);
    history = callback(history, message, [`result-${round}`]);
  }
  const last = await request(origin, { messages: history, tools: functionTools, stream: true });
  const events = frames(await last.text());
  assert.equal(events.filter(x => x.choices?.length).map(x => x.choices[0].delta.content ?? '').join(''), 'received: result-1 | result-2');
});

test('pending tools consume capacity but their callbacks can still run at the limit', async t => {
  const { origin } = await start(t, { maxConcurrent: 1 });
  const initial = messages('dynamic-call');
  const first = await (await request(origin, { messages: initial, tools: functionTools })).json();
  assert.equal((await request(origin, { messages: messages('unrelated') })).status, 429);
  const resumed = await request(origin, { messages: callback(initial, first.choices[0].message, ['allowed']), tools: functionTools });
  assert.equal(resumed.status, 200);
  await resumed.text();
});

test('tool sessions expire and late callbacks fail without starting a new Codex turn', async t => {
  const { origin } = await start(t, { toolTimeoutMs: 100 });
  const initial = messages('dynamic-call');
  const first = await (await request(origin, { messages: initial, tools: functionTools })).json();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await (await fetch(origin + '/healthz')).json()).pending_tools, 0);
  const res = await request(origin, { messages: callback(initial, first.choices[0].message, ['too late']), tools: functionTools });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /expired/);
});

test('tool_choice=none does not advertise tools; undeclared or malformed tool history is rejected', async t => {
  const { origin } = await start(t);
  const res = await request(origin, { messages: messages('dynamic-call'), tools: functionTools, tool_choice: 'none' });
  assert.equal((await res.json()).choices[0].finish_reason, 'stop');
  assert.throws(() => normalizeRequest({ messages: [{ role: 'tool', tool_call_id: 'unknown', content: 'value' }] }), { status: 400 });
  assert.throws(() => normalizeRequest({ messages: messages('x'), tools: [...functionTools, ...functionTools] }), { status: 400 });
  assert.throws(() => normalizeRequest({ input: 'x', tools: functionTools }, true), { status: 400 });
});

test('call IDs cannot combine tool results from independent conversations', async t => {
  const { origin } = await start(t);
  const initial = messages('dynamic-call');
  const first = await (await request(origin, { messages: initial, tools: functionTools })).json();
  const second = await (await request(origin, { messages: initial, tools: functionTools })).json();
  const mixed = { role: 'assistant', content: null, tool_calls: [...first.choices[0].message.tool_calls, ...second.choices[0].message.tool_calls] };
  const res = await request(origin, { messages: callback(initial, mixed, ['a', 'b']), tools: functionTools });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /different conversations/);
});

test('late parallel tool requests are queued and handed off on the next callback', async t => {
  const { origin } = await start(t);
  let history = messages('late-parallel-call');
  const first = await (await request(origin, { messages: history, tools: functionTools })).json();
  assert.equal(first.choices[0].message.tool_calls.length, 1);
  history = callback(history, first.choices[0].message, ['early']);
  await new Promise(resolve => setTimeout(resolve, 80));
  const second = await (await request(origin, { messages: history, tools: functionTools })).json();
  assert.equal(second.choices[0].finish_reason, 'tool_calls');
  assert.equal(JSON.parse(second.choices[0].message.tool_calls[0].function.arguments).index, 1);
  history = callback(history, second.choices[0].message, ['late']);
  const final = await (await request(origin, { messages: history, tools: functionTools })).json();
  assert.equal(final.choices[0].message.content, 'received: early | late');
});
