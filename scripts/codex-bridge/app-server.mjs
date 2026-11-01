import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class BridgeError extends Error {
  constructor(message, status = 502, code = 'upstream_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// One stdio connection per HTTP request: neither turns nor credentials cross requests.
export class AppServer {
  constructor({ command = 'codex', args = [], cwd, env = process.env }, onEvent = () => {}) {
    this.pending = new Map();
    this.nextId = 1;
    this.onEvent = onEvent;
    this.failure = null;
    this.child = spawn(command, [...args, 'app-server', '--listen', 'stdio://',
      '-c', 'model_provider="openai"',
      '-c', 'features.shell_tool=false',
      '-c', 'features.apply_patch_freeform=false',
      '-c', 'web_search="disabled"'], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      windowsHide: true,
    });
    // Do not copy upstream stderr (which can contain prompts or credentials) to HTTP/logs.
    this.child.stderr.resume();
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (Object.hasOwn(message, 'id') && message.method) {
          if (this.onRequest?.(message.method, message.params ?? {}, message.id)) return;
          // HTTP callers cannot answer interactive agent requests. Fail explicitly.
          this.write({ id: message.id, error: { code: -32601, message: 'Interactive tools are not supported by this bridge' } });
          this.fail(new BridgeError('Codex requested an interactive tool; this endpoint supports text generation only.', 422, 'unsupported_tool'));
        } else if (Object.hasOwn(message, 'id')) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new BridgeError(`Codex RPC ${pending.method} failed (code ${message.error.code ?? 'unknown'}).`));
          else pending.resolve(message.result);
        } else if (message.method) {
          this.onEvent(message.method, message.params ?? {});
        }
      } catch (error) {
        this.fail(error instanceof BridgeError ? error : new BridgeError('Invalid Codex App Server output.'));
      }
    });
    this.child.once('error', () => this.fail(new BridgeError('Cannot start Codex. Check CODEX_BRIDGE_COMMAND and the Codex installation.', 503, 'codex_unavailable')));
    this.child.stdin.on('error', () => this.fail(new BridgeError('Codex input stream closed.')));
    this.child.stdout.on('error', () => this.fail(new BridgeError('Codex output stream closed.')));
    this.exited = new Promise(resolve => this.child.once('close', () => {
      this.fail(new BridgeError('Codex exited before completing the request.'));
      resolve();
    }));
  }

  write(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async initialize(experimentalApi = false) {
    await this.request('initialize', {
      clientInfo: { name: 'easy_cli_proxy_codex_bridge', title: 'EasyCLIProxyAPI Codex Bridge', version: '0.1.0' },
      ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}),
    });
    this.write({ method: 'initialized', params: {} });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onFailure?.(error);
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = this.stop();
    return this.closing;
  }

  async stop() {
    this.onFailure = null;
    this.fail(new BridgeError('Request cancelled.', 499, 'cancelled'));
    const kill = signal => {
      if (!this.child.pid) return;
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.on('error', () => this.child.kill());
        } else process.kill(-this.child.pid, signal);
      } catch { /* The child may already have exited. */ }
    };
    kill('SIGTERM');
    let timer;
    await Promise.race([this.exited, new Promise(resolve => {
      timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, 750);
    })]);
    clearTimeout(timer);
    this.lines.close();
  }
}
