import {
  MCP_INVOKE_TIMEOUT_MS,
  MCP_JS_TIMEOUT_MS,
  MCP_WINDOW,
  SESSION_WAIT_MS,
} from './config.mjs';
import { sleep } from './process.mjs';

function parseJsonMaybe(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function unwrapExecuteJs(response, label) {
  if (!response) throw new Error(`${label}: empty execute_js response`);
  if (response.success === false) {
    throw new Error(`${label} failed: ${response.error || JSON.stringify(response)}`);
  }
  if (Object.prototype.hasOwnProperty.call(response, 'data')) {
    return parseJsonMaybe(response.data);
  }
  return parseJsonMaybe(response);
}

export async function withMcp(port, fn) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('Node WebSocket is required (Node 22+)');
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const pending = new Map();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mcp ws :${port} connect timed out`)), 8_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`mcp ws :${port} connection failed`));
    });
  });
  ws.addEventListener('message', ev => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    waiter.resolve(msg);
  });
  const bridge = {
    port,
    async sendCommand(command, timeoutMs = MCP_JS_TIMEOUT_MS) {
      const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const payload = { ...command, id };
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`mcp command ${command.command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: msg => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
        ws.send(JSON.stringify(payload));
      });
      return response;
    },
  };
  try {
    return await fn(bridge);
  } finally {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}

export async function executeJs(bridge, script, timeoutMs = MCP_JS_TIMEOUT_MS) {
  const response = await bridge.sendCommand(
    {
      command: 'execute_js',
      args: { script, windowLabel: MCP_WINDOW },
    },
    timeoutMs,
  );
  return unwrapExecuteJs(response, 'execute_js');
}

export async function waitForTauri(bridge, timeoutMs = SESSION_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await executeJs(
        bridge,
        '(() => !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke))()',
      );
      if (ready === true || ready === 'true') return;
    } catch {
      // webview not ready yet
    }
    await sleep(250);
  }
  throw new Error(`webview __TAURI__ not ready on mcp :${bridge.port}`);
}

export async function invokeTauri(bridge, command, args = {}, timeoutMs = MCP_INVOKE_TIMEOUT_MS) {
  await waitForTauri(bridge);
  const slot = `__demo_invoke_${command}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startScript = `(() => {
    const slot = ${JSON.stringify(slot)};
    window[slot] = { done: false, error: null, result: null };
    Promise.resolve(window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}))
      .then((r) => { window[slot].result = r; window[slot].done = true; })
      .catch((e) => {
        window[slot].error = (e && e.message) ? e.message : String(e);
        window[slot].done = true;
      });
    return { started: true };
  })()`;
  await executeJs(bridge, startScript);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pollScript = `(() => {
      const s = window[${JSON.stringify(slot)}];
      if (!s) return { done: false };
      if (!s.done) return { done: false };
      if (s.error) return { done: true, ok: false, error: s.error };
      return { done: true, ok: true, result: s.result };
    })()`;
    const polled = await executeJs(bridge, pollScript);
    if (polled && polled.done) {
      if (!polled.ok) {
        throw new Error(`invoke ${command} failed: ${polled.error}`);
      }
      return polled.result;
    }
    await sleep(250);
  }
  throw new Error(`invoke ${command} timed out after ${timeoutMs}ms`);
}
