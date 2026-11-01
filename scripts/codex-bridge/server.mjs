import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppServer, BridgeError } from './app-server.mjs';
import { normalizeTools, acceptToolCall, ToolSessions } from './tool-sessions.mjs';
import { trackUsage, updateUsage } from './usage.mjs';

const invalid = message => new BridgeError(message, 400, 'invalid_request_error');
const own = (o, key) => Object.hasOwn(o, key);

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(p => p && ['text', 'input_text', 'output_text'].includes(p.type) && typeof p.text === 'string')) {
    return content.map(p => p.text).join('\n');
  }
  throw invalid('Only text message content is supported.');
}

export function normalizeRequest(body, responses = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Expected a JSON object.');
  const allowed = new Set(responses
    ? ['model', 'input', 'instructions', 'stream', 'reasoning', 'text', 'tools', 'tool_choice', 'store', 'metadata', 'user', 'max_output_tokens', 'temperature', 'top_p']
    : ['model', 'messages', 'stream', 'stream_options', 'reasoning_effort', 'response_format', 'tools', 'tool_choice', 'n', 'store', 'metadata', 'user', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw invalid(`Unsupported parameter: ${key}.`);
  // App Server has no token-cap or sampling controls in thread/start or turn/start.
  // Accept clients' standard hints, without inventing ineffective config keys or
  // claiming an enforced cap. The HTTP response identifies every unapplied hint.
  const ignoredParameters = [];
  for (const key of responses ? ['max_output_tokens'] : ['max_tokens', 'max_completion_tokens']) {
    if (body[key] == null) continue;
    if (!Number.isSafeInteger(body[key]) || body[key] < 1) throw invalid(`${key} must be a positive safe integer.`);
    ignoredParameters.push(key);
  }
  for (const [key, max] of [['temperature', 2], ['top_p', 1]]) {
    if (body[key] == null) continue;
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > max) throw invalid(`${key} must be a number between 0 and ${max}.`);
    ignoredParameters.push(key);
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw invalid('stream must be a boolean.');
  if (body.store !== undefined && body.store !== false) throw invalid('Only store=false is supported.');
  if (body.n !== undefined && body.n !== 1) throw invalid('Only n=1 is supported.');
  const tools = normalizeTools(body.tools, body.tool_choice, responses);
  if (body.stream_options !== undefined && (!body.stream_options || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options)
    || Object.keys(body.stream_options).some(k => k !== 'include_usage')
    || (own(body.stream_options, 'include_usage') && typeof body.stream_options.include_usage !== 'boolean'))) throw invalid('Unsupported stream_options.');
  const model = body.model ?? 'codex';
  if (typeof model !== 'string' || !model.trim()) throw invalid('model must be a nonempty string.');
  let messages;
  if (responses) {
    messages = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== 'string') throw invalid('instructions must be text.');
      if (!Array.isArray(messages)) throw invalid('input must be text or message items.');
      messages = [{ role: 'developer', content: body.instructions }, ...messages];
    }
  } else messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) throw invalid('A nonempty message list is required.');
  const instructions = [];
  const history = [];
  const toolOutputs = [];
  const knownCalls = new Set();
  let seenConversation = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Object.keys(message).some(k => !['role', 'content', 'type', 'tool_calls', 'tool_call_id'].includes(k))
      || (message.type !== undefined && message.type !== 'message')) throw invalid('Only plain text message objects are supported.');
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw invalid('Unsupported message role.');
    if (message.role === 'tool') {
      if (responses || typeof message.tool_call_id !== 'string' || !knownCalls.has(message.tool_call_id)) throw invalid('Tool results must reference a preceding assistant tool call.');
      if (toolOutputs.some(output => output.id === message.tool_call_id)) throw invalid('Duplicate tool result.');
      const value = text(message.content);
      toolOutputs.push({ id: message.tool_call_id, text: value });
      history.push({ type: 'function_call_output', call_id: message.tool_call_id, output: value });
      continue;
    }
    if (message.tool_call_id !== undefined || (message.tool_calls !== undefined && message.role !== 'assistant')) throw invalid('Invalid tool message fields.');
    const calls = message.tool_calls;
    if (calls !== undefined && (responses || !Array.isArray(calls) || !calls.length)) throw invalid('Invalid assistant tool_calls.');
    const value = message.content == null && calls?.length ? '' : text(message.content);
    if (message.role === 'system' || message.role === 'developer') {
      if (seenConversation) throw invalid('System/developer instructions must precede conversation messages.');
      instructions.push(value);
    } else {
      seenConversation = true;
      if (value || !calls?.length) history.push({ type: 'message', role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: value }] });
      for (const call of calls ?? []) {
        if (!call || typeof call.id !== 'string' || !call.id || knownCalls.has(call.id) || call.type !== 'function'
          || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.function?.name) || typeof call.function?.arguments !== 'string') throw invalid('Invalid assistant tool call.');
        try { JSON.parse(call.function.arguments); } catch { throw invalid('Tool arguments must be JSON.'); }
        knownCalls.add(call.id);
        history.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  let prompt;
  if (history.at(-1)?.role === 'user') {
    prompt = history.pop().content[0].text;
    if (!prompt.trim()) throw invalid('The last user message must be nonempty.');
  } else if (history.at(-1)?.type !== 'function_call_output') throw invalid('The last message must be a user message or tool result.');
  const effort = responses ? body.reasoning?.effort : body.reasoning_effort;
  if (responses && body.reasoning !== undefined && (!body.reasoning || typeof body.reasoning !== 'object'
    || Object.keys(body.reasoning).some(k => k !== 'effort'))) throw invalid('Only reasoning.effort is supported.');
  if (effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) throw invalid('Unsupported reasoning effort.');
  let format = responses ? body.text?.format : body.response_format;
  if (responses && body.text !== undefined && (!body.text || typeof body.text !== 'object'
    || Object.keys(body.text).some(k => k !== 'format'))) throw invalid('Only text.format is supported.');
  let outputSchema;
  if (format !== undefined) {
    if (!format || typeof format !== 'object') throw invalid('Invalid response format.');
    if (format.type === 'json_schema') {
      const spec = responses ? format : format.json_schema;
      if (!spec?.schema || typeof spec.schema !== 'object' || Array.isArray(spec.schema)) throw invalid('json_schema requires an object schema.');
      outputSchema = spec.schema;
    } else if (format.type !== 'text') throw invalid('Only text or json_schema output is supported.');
  }
  return { model, prompt, history, instructions: instructions.join('\n\n'), effort, outputSchema, ignoredParameters, tools, toolOutputs,
    stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function errorBody(error) {
  return { error: { message: error.message, type: error.status === 400 ? 'invalid_request_error' : 'server_error', code: error.code ?? 'bridge_error', param: null } };
}

async function readBody(req, limit, signal) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new BridgeError('Content-Type must be application/json.', 415, 'unsupported_media_type');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', fail);
      signal.removeEventListener('abort', aborted);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const aborted = () => fail(signal.reason);
    const data = chunk => {
      length += chunk.length;
      if (length > limit) { fail(new BridgeError('Request body is too large.', 413, 'request_too_large')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(invalid('Malformed JSON body.')); }
    };
    req.on('data', data); req.once('end', end); req.once('error', fail);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function usageOf(value) {
  if (!value) return undefined;
  return { prompt_tokens: value.inputTokens, completion_tokens: value.outputTokens, total_tokens: value.totalTokens,
    prompt_tokens_details: { cached_tokens: value.cachedInputTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: value.reasoningOutputTokens ?? 0 } };
}

function responsesUsage(usage) {
  return usage && { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens,
    input_tokens_details: usage.prompt_tokens_details, output_tokens_details: usage.completion_tokens_details };
}

function segmentUsage(total, previous) {
  if (!total) return undefined;
  const subtract = (key, before = previous, after = total) => Math.max(0, (after?.[key] ?? 0) - (before?.[key] ?? 0));
  return { prompt_tokens: subtract('prompt_tokens'), completion_tokens: subtract('completion_tokens'), total_tokens: subtract('total_tokens'),
    prompt_tokens_details: { cached_tokens: subtract('cached_tokens', previous?.prompt_tokens_details, total.prompt_tokens_details) },
    completion_tokens_details: { reasoning_tokens: subtract('reasoning_tokens', previous?.completion_tokens_details, total.completion_tokens_details) } };
}

class Output {
  constructor(res, request, responses) {
    Object.assign(this, { res, request, responses });
    this.id = `${responses ? 'resp' : 'chatcmpl'}_${randomUUID().replaceAll('-', '')}`;
    this.itemId = `msg_${randomUUID().replaceAll('-', '')}`;
    this.created = Math.floor(Date.now() / 1000);
    this.sequence = 0;
    this.started = false;
  }

  event(value, name) {
    if (this.res.destroyed) throw new BridgeError('Client disconnected.', 499, 'cancelled');
    if (this.res.writableLength > 1024 * 1024) throw new BridgeError('Streaming client is too slow.', 499, 'slow_client');
    this.res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(value)}\n\n`);
  }

  responseEvent(type, fields) { this.event({ type, sequence_number: this.sequence++, ...fields }, type); }
  chunk(delta, finish = null, usage) {
    this.event({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.request.model,
      choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }],
      ...(this.request.includeUsage ? { usage: usage ?? null } : {}) });
  }

  item(value, status) { return { id: this.itemId, type: 'message', role: 'assistant', status,
    content: [{ type: 'output_text', text: value, annotations: [] }] }; }

  response(value, status, usage) { return { id: this.id, object: 'response', created_at: this.created, status,
    error: null, incomplete_details: null, model: this.request.model,
    output: status === 'in_progress' ? [] : [this.item(value, 'completed')],
    output_text: value, usage: responsesUsage(usage) ?? null, tools: [], tool_choice: 'none', parallel_tool_calls: false, store: false }; }

  start() {
    if (this.started || !this.request.stream) return;
    this.started = true;
    this.res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    if (this.responses) {
      this.responseEvent('response.created', { response: this.response('', 'in_progress') });
      this.responseEvent('response.in_progress', { response: this.response('', 'in_progress') });
      this.responseEvent('response.output_item.added', { output_index: 0, item: { ...this.item('', 'in_progress'), content: [] } });
      this.responseEvent('response.content_part.added', { item_id: this.itemId, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } });
    } else this.chunk({ role: 'assistant', content: '' });
  }

  delta(value) {
    if (!this.request.stream) return;
    this.start();
    if (this.responses) this.responseEvent('response.output_text.delta', { item_id: this.itemId, output_index: 0, content_index: 0, delta: value });
    else this.chunk({ content: value });
  }

  finish(value, usage, calls = []) {
    if (!this.request.stream) {
      json(this.res, 200, this.responses ? this.response(value, 'completed', usage) : {
        id: this.id, object: 'chat.completion', created: this.created, model: this.request.model,
        choices: [{ index: 0, message: { role: 'assistant', content: value || (calls.length ? null : ''),
          ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) },
          finish_reason: calls.length ? 'tool_calls' : 'stop' }], ...(usage ? { usage } : {}),
      });
      return;
    }
    this.start();
    if (this.responses) {
      this.responseEvent('response.output_text.done', { item_id: this.itemId, output_index: 0, content_index: 0, text: value });
      this.responseEvent('response.content_part.done', { item_id: this.itemId, output_index: 0, content_index: 0, part: this.item(value, 'completed').content[0] });
      this.responseEvent('response.output_item.done', { output_index: 0, item: this.item(value, 'completed') });
      this.responseEvent('response.completed', { response: this.response(value, 'completed', usage) });
    } else {
      if (calls.length) this.chunk({ tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
      this.chunk({}, calls.length ? 'tool_calls' : 'stop');
      if (this.request.includeUsage && usage) this.chunk({}, null, usage);
      this.res.write('data: [DONE]\n\n');
    }
    this.res.end();
  }

  fail(error) {
    if (this.res.destroyed || this.res.writableEnded) return;
    if (!this.res.headersSent) json(this.res, error.status ?? 502, errorBody(error));
    else {
      try {
        if (this.responses) this.responseEvent('error', { code: error.code ?? 'bridge_error', message: error.message, param: null });
        else { this.event(errorBody(error)); this.res.write('data: [DONE]\n\n'); }
        this.res.end();
      } catch { this.res.destroy(); }
    }
  }
}

async function generate(session, request, output, signal) {
  const { rpc, cwd } = session;
  let threadId = session.threadId;
  let turnId = session.turnId;
  let settled = false;
  const items = new Map();
  let usage;
  let outputLength = 0;
  let doneResolve, doneReject;
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  // A failure may occur while an RPC is awaited; attach a handler immediately.
  done.catch(() => {});
  const fail = error => { if (!settled) { settled = true; doneReject(error); } };
  let flushScheduled = false;
  const returnTools = () => {
    if (settled || flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      if (settled) return;
      const calls = [...session.calls.values()].filter(call => !call.announced);
      if (!calls.length) return;
      for (const call of calls) call.announced = true;
      settled = true;
      doneResolve({ text: [...items.values()].filter(item => item.phase !== 'commentary').map(item => item.text).join(''), usage, calls });
    }, 10);
  };
  const abort = () => {
    rpc.fail(signal.reason);
    fail(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  rpc.onFailure = fail;
  rpc.onRequest = (method, params, id) => {
    if (!acceptToolCall(session, method, params, id)) return false;
    returnTools();
    return true;
  };
  rpc.onEvent = (method, params) => {
    if (params.threadId !== threadId || settled) return;
    if (params.turnId && turnId && params.turnId !== turnId) return;
    if (method === 'item/started' && params.item?.type === 'agentMessage') items.set(params.item.id, { phase: params.item.phase, text: '' });
    if (method === 'item/agentMessage/delta') {
      const item = items.get(params.itemId) ?? { text: '' };
      items.set(params.itemId, item);
      if (typeof params.delta !== 'string') throw new BridgeError('Invalid text delta from Codex.');
      item.text += params.delta;
      outputLength += params.delta.length;
      if (outputLength > 8 * 1024 * 1024) throw new BridgeError('Codex output exceeded the bridge limit.');
      // Commentary and internal reasoning are not an OpenAI assistant answer.
      if (item.phase !== 'commentary') output.delta(params.delta);
    }
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      const item = items.get(params.item.id) ?? { text: '', phase: params.item.phase };
      const full = params.item.text ?? item.text;
      if (typeof full !== 'string' || full.length > 8 * 1024 * 1024) throw new BridgeError('Codex output exceeded the bridge limit.');
      if (item.phase !== 'commentary' && full !== item.text) {
        if (!full.startsWith(item.text)) throw new BridgeError('Codex changed an already streamed message.');
        output.delta(full.slice(item.text.length));
      }
      items.set(params.item.id, { text: full, phase: params.item.phase ?? item.phase });
    }
    if (method === 'thread/tokenUsage/updated') {
      usage = usageOf(params.tokenUsage?.total);
      session.cumulativeUsage = usage;
    }
    if (method === 'error' && params.willRetry !== true) fail(new BridgeError('Codex generation failed. Check Codex authentication and model availability.'));
    if (method === 'turn/completed') {
      if (params.turn?.status !== 'completed') { fail(new BridgeError(`Codex turn ${params.turn?.status ?? 'failed'}.`)); return; }
      const final = [...items.values()].filter(item => item.phase !== 'commentary').map(item => item.text).join('');
      settled = true;
      doneResolve({ text: final, usage, calls: [] });
    }
  };
  try {
    signal.throwIfAborted();
    if (!threadId) {
      await rpc.initialize(request.tools.length > 0);
      const result = await rpc.request('thread/start', {
      ...(request.model !== 'codex' ? { model: request.model } : {}), modelProvider: 'openai',
      cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      developerInstructions: request.instructions || undefined,
      ...(request.tools.length ? { dynamicTools: request.tools.map(({ originalName, ...tool }) => tool) } : {}),
      config: { 'mcp_servers': {}, 'features.shell_tool': false, 'features.apply_patch_freeform': false, 'web_search': 'disabled' },
    });
      threadId = result.thread?.id;
      if (!threadId) throw new BridgeError('Codex did not return a thread ID.');
      session.threadId = threadId;
      session.resolvedModel = result.model ?? request.model;
      if (request.history.length) await rpc.request('thread/inject_items', { threadId, items: request.history });
      const started = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: request.prompt }],
      ...(request.effort ? { effort: request.effort } : {}), ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}) });
      turnId = started.turn?.id;
      if (!turnId) throw new BridgeError('Codex did not return a turn ID.');
      session.turnId = turnId;
    } else {
      // Continue the same suspended Codex turn, rather than replaying a fake
      // user prompt or losing tool-call/reasoning state in a new thread.
      for (const result of session.resumeOutputs) {
        rpc.write({ id: result.rpcId, result: { contentItems: [{ type: 'inputText', text: result.output }], success: true } });
        session.calls.delete(result.id);
      }
      session.resumeOutputs = [];
      if ([...session.calls.values()].some(call => !call.announced)) returnTools();
    }
    rpc.interrupt = () => rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    const resultText = await done;
    const total = resultText.usage;
    resultText.usage = segmentUsage(total, session.reportedUsage);
    if (total) session.reportedUsage = total;
    return resultText;
  } finally {
    signal.removeEventListener('abort', abort);
    rpc.interrupt = null;
    rpc.onFailure = null;
  }
}

export function createBridge(options = {}) {
  const config = { command: 'codex', args: [], timeoutMs: 120000, maxConcurrent: 4, bodyLimit: 1024 * 1024,
    toolTimeoutMs: 600000, apiKey: '', env: process.env, ...options };
  let active = 0;
  const controllers = new Set();
  const toolSessions = new ToolSessions(config.toolTimeoutMs);
  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { json(res, 400, errorBody(invalid('Invalid request URL.'))); return; }
    if (url.pathname === '/healthz' && req.method === 'GET') { json(res, 200, { status: 'ok', active, pending_tools: toolSessions.sessions.size, instance_id: config.instanceId ?? null }); return; }
    if (config.apiKey) {
      const provided = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${config.apiKey}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        json(res, 401, errorBody(new BridgeError('Invalid bridge API key.', 401, 'invalid_api_key'))); return;
      }
    }
    const models = req.method === 'GET' && url.pathname === '/v1/models';
    const responses = url.pathname === '/v1/responses';
    if (!models && !(req.method === 'POST' && (responses || url.pathname === '/v1/chat/completions'))) {
      json(res, 404, errorBody(new BridgeError('Endpoint not found.', 404, 'not_found'))); return;
    }
    const usageEvent = models ? {} : trackUsage(req, res, config);
    if (active >= config.maxConcurrent) {
      res.setHeader('Retry-After', '1');
      json(res, 429, errorBody(new BridgeError('Bridge concurrency limit reached.', 429, 'rate_limit_exceeded'))); return;
    }
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new BridgeError('Codex request timed out.', 504, 'timeout')), config.timeoutMs);
    const disconnected = () => {
      if (!res.writableEnded) controller.abort(new BridgeError('Client disconnected.', 499, 'cancelled'));
    };
    res.on('close', disconnected);
    req.on('aborted', disconnected);
    let rpc, cwd, output, session;
    let retained = false;
    const abort = () => {
      rpc?.interrupt?.();
      rpc?.fail(controller.signal.reason);
      if (rpc) void rpc.close();
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const request = models ? null : normalizeRequest(await readBody(req, config.bodyLimit, controller.signal), responses);
      if (request) Object.assign(usageEvent, { model: request.model, alias: request.model, reasoning_effort: request.effort ?? '' });
      if (request?.ignoredParameters.length) res.setHeader('X-Codex-Bridge-Ignored-Parameters', request.ignoredParameters.join(', '));
      controller.signal.throwIfAborted();
      if (request) session = toolSessions.take(request);
      if (session) ({ rpc, cwd } = session);
      else {
        if (active + toolSessions.sessions.size > config.maxConcurrent) throw new BridgeError('Bridge capacity is occupied by pending tool sessions.', 429, 'rate_limit_exceeded');
        cwd = await mkdtemp(join(tmpdir(), 'easy-codex-bridge-'));
        controller.signal.throwIfAborted();
        rpc = new AppServer({ command: config.command, args: config.args, cwd, env: config.env });
        if (request) session = { rpc, cwd, tools: request.tools, model: request.model, calls: new Map() };
      }
      if (models) {
        await rpc.initialize();
        const data = [{ id: 'codex', object: 'model', created: 0, owned_by: 'openai' }];
        let cursor;
        const seen = new Set();
        do {
          const result = await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
          for (const model of result.data ?? []) if (!model.hidden && !data.some(m => m.id === model.model)) data.push({ id: model.model, object: 'model', created: 0, owned_by: 'openai' });
          cursor = result.nextCursor;
          if (cursor && seen.has(cursor)) throw new BridgeError('Codex returned a repeated model cursor.');
          seen.add(cursor);
        } while (cursor);
        json(res, 200, { object: 'list', data });
      } else {
        output = new Output(res, request, responses);
        const result = await generate(session, request, output, controller.signal);
        usageEvent.model = session.resolvedModel ?? request.model;
        updateUsage(usageEvent, result.usage);
        if (result.calls.length) {
          toolSessions.retain(session);
          retained = true;
        }
        output.finish(result.text, result.usage, result.calls);
      }
    } catch (error) {
      if (retained) { retained = false; toolSessions.detach(session); }
      const safe = error instanceof BridgeError ? error : new BridgeError('Bridge request failed.', 500, 'internal_error');
      Object.assign(usageEvent, { failed: true, failure_status: safe.status, failure_body: safe.code });
      if (session) updateUsage(usageEvent, segmentUsage(session.cumulativeUsage, session.reportedUsage));
      if (output) output.fail(safe);
      else if (!res.destroyed && !res.writableEnded) json(res, safe.status, errorBody(safe));
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      req.off('aborted', disconnected);
      res.off('close', disconnected);
      if (!retained) {
        await rpc?.close();
        if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
      }
      controllers.delete(controller);
      active--;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, async close() {
    for (const controller of controllers) controller.abort(new BridgeError('Bridge shutting down.', 503, 'shutting_down'));
    server.closeIdleConnections();
    await Promise.all([toolSessions.close(), new Promise(resolve => server.close(resolve))]);
  } };
}

export function configFromEnv(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const host = env.CODEX_BRIDGE_HOST ?? '127.0.0.1';
  const apiKey = env.CODEX_BRIDGE_API_KEY ?? '';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !apiKey) throw new Error('CODEX_BRIDGE_API_KEY is required for a non-loopback listener.');
  return { host, port: integer('CODEX_BRIDGE_PORT', 8320, 1, 65535), apiKey,
    command: env.CODEX_BRIDGE_COMMAND ?? 'codex',
    timeoutMs: integer('CODEX_BRIDGE_TIMEOUT_MS', 120000, 100, 3600000),
    maxConcurrent: integer('CODEX_BRIDGE_MAX_CONCURRENT', 4, 1, 64),
    toolTimeoutMs: integer('CODEX_BRIDGE_TOOL_TIMEOUT_MS', 600000, 100, 3600000),
    usageDir: env.CODEX_BRIDGE_USAGE_DIR || undefined,
    cpaMarker: env.CODEX_BRIDGE_CPA_MARKER || '',
    instanceId: env.CODEX_BRIDGE_INSTANCE_ID || undefined,
    env: { ...env, ...(env.CODEX_BRIDGE_CODEX_HOME ? { CODEX_HOME: resolve(env.CODEX_BRIDGE_CODEX_HOME) } : {}) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = configFromEnv();
    const bridge = createBridge(config);
    bridge.server.on('error', error => { console.error(`Codex bridge listener failed (${error.code ?? 'unknown'}).`); process.exitCode = 1; });
    bridge.server.listen(config.port, config.host, () => console.log(`Codex bridge listening at http://${config.host}:${config.port}/v1`));
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await bridge.close();
      if (process.env.CODEX_BRIDGE_PARENT_GUARD === '1') process.stdin.destroy();
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
    if (process.env.CODEX_BRIDGE_PARENT_GUARD === '1') {
      // Closing the desktop (including a crash) closes this pipe and shuts down
      // Codex descendants, even when no graceful app exit callback ran.
      process.stdin.resume();
      process.stdin.on('end', shutdown);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
