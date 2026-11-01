// Deterministic App Server stand-in used only by server.test.mjs.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const event = (method, params) => send({ method, params: { threadId: 'thread-test', ...params } });
let initialized = false;
let thread = false;
let history = [];
let tools = [];
let toolRound = 0;
let toolPrompt = '';
const outstanding = new Set();
let toolResults = [];
const finishTools = () => {
  const value = 'received: ' + toolResults.join(' | ');
  event('item/started', { item: { id: 'tool-answer', type: 'agentMessage', phase: 'final_answer' } });
  event('item/agentMessage/delta', { itemId: 'tool-answer', delta: value });
  event('item/completed', { item: { id: 'tool-answer', type: 'agentMessage', phase: 'final_answer', text: value } });
  event('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 30, outputTokens: 5, totalTokens: 35 } } });
  event('turn/completed', { turn: { id: 'turn-test', status: 'completed' } });
};
const callTools = () => {
  toolRound++;
  const count = ['parallel-call', 'late-parallel-call'].includes(toolPrompt) ? 2 : 1;
  event('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } } });
  for (let i = 0; i < count; i++) {
    const id = `rpc-tool-${toolRound}-${i}`;
    outstanding.add(id);
    const dispatch = () => send({ id, method: 'item/tool/call', params: { threadId: 'thread-test', turnId: 'turn-test', callId: `upstream-${toolRound}-${i}`,
      namespace: null, tool: tools[0].name, arguments: { command: 'ps', round: toolRound, index: i } } });
    if (toolPrompt === 'late-parallel-call' && i === 1) setTimeout(dispatch, 50);
    else dispatch();
  }
};
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params, result } = JSON.parse(line);
  if (!method && outstanding.has(id)) {
    if (result?.contentItems?.[0]?.type !== 'inputText' || result?.success !== true) process.exit(4);
    toolResults.push(result.contentItems[0].text);
    outstanding.delete(id);
    if (!outstanding.size) {
      if (toolPrompt === 'two-rounds' && toolRound === 1) callTools();
      else finishTools();
    }
    return;
  }
  if (method === 'initialize') { initialized = true; reply(id, { userAgent: 'fixture' }); return; }
  if (method === 'initialized') return;
  if (!initialized) { send({ id, error: { code: -32000 } }); return; }
  if (method === 'model/list') {
    reply(id, { data: [{ model: params.cursor ? 'model-b' : 'model-a', hidden: false }], nextCursor: params.cursor ? null : 'page-2' });
  } else if (method === 'thread/start') {
    if (params.model === 'rpc-error') { send({ id, error: { code: -32001, message: 'sensitive upstream data' } }); return; }
    if (params.model === 'crash') { process.exit(1); }
    if (params.modelProvider !== 'openai' || params.sandbox !== 'read-only' || !params.ephemeral || params.approvalPolicy !== 'never') process.exit(2);
    thread = true;
    tools = params.dynamicTools ?? [];
    reply(id, { thread: { id: 'thread-test' } });
  } else if (method === 'thread/inject_items') {
    history = params.items;
    reply(id, {});
  } else if (method === 'turn/start') {
    if (!thread) process.exit(3);
    reply(id, { turn: { id: 'turn-test', status: 'inProgress' } });
    const prompt = params.input[0].text;
    if (['dynamic-call', 'parallel-call', 'late-parallel-call', 'two-rounds'].includes(prompt) && tools.length) {
      toolPrompt = prompt;
      callTools();
      return;
    }
    if (prompt === 'hang') return;
    if (prompt === 'permission') {
      send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-test' } });
      return;
    }
    if (prompt === 'failure') { event('turn/completed', { turn: { id: 'turn-test', status: 'failed' } }); return; }
    const value = prompt === 'history' ? JSON.stringify(history) : prompt;
    event('item/agentMessage/delta', { threadId: 'unrelated', itemId: 'wrong', delta: 'WRONG' });
    event('item/started', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary' } });
    event('item/agentMessage/delta', { itemId: 'comment', delta: 'private commentary' });
    event('item/completed', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'private commentary' } });
    event('item/started', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } });
    event('item/agentMessage/delta', { itemId: 'answer', delta: value.slice(0, 2) });
    setTimeout(() => {
      if (prompt === 'stream-failure') {
        event('turn/completed', { turn: { id: 'turn-test', status: 'failed' } });
        return;
      }
      if (prompt !== 'completion-fallback') event('item/agentMessage/delta', { itemId: 'answer', delta: value.slice(2) });
      event('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: value } });
      event('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedInputTokens: 3, reasoningOutputTokens: 2 } } });
      event('turn/completed', { turn: { id: 'turn-test', status: 'completed' } });
    }, 30);
  } else if (method === 'turn/interrupt') reply(id, {});
});
