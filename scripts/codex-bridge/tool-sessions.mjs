import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { BridgeError } from './app-server.mjs';

const invalid = message => new BridgeError(message, 400, 'invalid_request_error');
const namePattern = /^[a-zA-Z0-9_-]{1,64}$/;

export function normalizeTools(tools, choice, responses) {
  if (tools !== undefined && !Array.isArray(tools)) throw invalid('tools must be an array.');
  if (responses && tools?.length) throw invalid('Function tools currently require the Chat Completions endpoint.');
  if (choice !== undefined && !['none', 'auto'].includes(choice)) throw invalid('Only tool_choice=auto or none is supported.');
  const names = new Set();
  const result = (tools ?? []).map((tool, index) => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || !fn || !namePattern.test(fn.name) || names.has(fn.name)
      || (fn.description !== undefined && typeof fn.description !== 'string')
      || (fn.parameters !== undefined && (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)))) {
      throw invalid('tools must contain uniquely named function definitions with object parameter schemas.');
    }
    names.add(fn.name);
    return { originalName: fn.name, type: 'function', name: `bridge_${index}_${fn.name.slice(0, 48)}`,
      description: fn.description ?? fn.name, inputSchema: fn.parameters ?? { type: 'object', properties: {} }, deferLoading: false };
  });
  return choice === 'none' ? [] : result;
}

// Only the caller can execute these tools. The bridge holds Codex's outstanding
// JSON-RPC requests until the caller posts the corresponding role=tool messages.
export function acceptToolCall(session, method, params, rpcId) {
  if (method !== 'item/tool/call' || params.threadId !== session.threadId) return false;
  const tool = session.tools.find(tool => tool.name === params.tool);
  if (!tool || (params.namespace !== null && params.namespace !== undefined)) throw new BridgeError('Codex requested an undeclared caller tool.');
  if (session.calls.size >= 64) throw new BridgeError('Too many pending tool calls.');
  const id = `call_${randomUUID().replaceAll('-', '')}`;
  session.calls.set(id, { id, rpcId, upstreamId: params.callId, name: tool.originalName,
    arguments: JSON.stringify(params.arguments ?? {}), announced: false });
  return true;
}

export class ToolSessions {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.sessions = new Set();
    this.byCall = new Map();
    this.closing = new Set();
  }

  retain(session) {
    this.sessions.add(session);
    for (const call of session.calls.values()) if (call.announced) this.byCall.set(call.id, session);
    session.expiry = setTimeout(() => { void this.release(session); }, this.timeoutMs);
    session.expiry.unref();
    session.rpc.onFailure = () => { void this.release(session); };
    if (session.rpc.failure) void this.release(session);
  }

  take(request) {
    const matches = new Set(request.toolOutputs.map(output => this.byCall.get(output.id)).filter(Boolean));
    if (!matches.size) {
      if (!request.prompt) throw invalid('No pending tool session for these results. It may have expired or the bridge restarted.');
      return null;
    }
    if (matches.size !== 1) throw invalid('Tool results cannot mix different conversations.');
    const session = [...matches][0];
    if (request.model !== session.model) throw invalid('Do not change the model while returning tool results.');
    const outputs = new Map(request.toolOutputs.map(output => [output.id, output.text]));
    const expected = [...session.calls.values()].filter(call => call.announced);
    if (expected.some(call => !outputs.has(call.id))) throw invalid('Return results for every tool call in the preceding assistant response.');
    // Validate everything before claiming the session, so a malformed callback
    // can be corrected without losing the outstanding calls.
    this.detach(session);
    session.resumeOutputs = expected.map(call => ({ ...call, output: outputs.get(call.id) }));
    return session;
  }

  detach(session) {
    clearTimeout(session.expiry);
    this.sessions.delete(session);
    for (const [id, owner] of this.byCall) if (owner === session) this.byCall.delete(id);
    session.rpc.onFailure = null;
  }

  release(session) {
    if (session.disposal) return session.disposal;
    this.detach(session);
    session.disposal = (async () => {
      await session.rpc.close();
      await rm(session.cwd, { recursive: true, force: true }).catch(() => {});
    })();
    this.closing.add(session.disposal);
    session.disposal.finally(() => this.closing.delete(session.disposal));
    return session.disposal;
  }

  async close() {
    await Promise.all([...this.sessions].map(session => this.release(session)));
    await Promise.all([...this.closing]);
  }
}
