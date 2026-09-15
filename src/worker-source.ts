/** Executed ONLY in the disposable container. Node/vm/AsyncFunction are not host sandboxes. */
export const WORKER_SOURCE = String.raw`
import { createInterface } from 'node:readline';
const io = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let started = false, nextId = 1;
const pending = new Map();
const call = (name, args = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ type: 'call', id, name, args });
});
const tools = Object.freeze({
  call,
  list: () => call('$list'),
  map: async (items, fn, concurrency = 4) => {
    if (!Array.isArray(items) || items.length > 128) throw new Error('map accepts at most 128 items');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency must be 1..8');
    let index = 0;
    const results = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) { const i = index++; results[i] = await fn(items[i], i); }
    }));
    return results;
  }
});
const logger = Object.freeze({ log: (...values) => send({ type: 'log', text: values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ').slice(0, 2048) }) });
io.on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 1; io.close(); return; }
  if (message.type === 'reply') {
    const p = pending.get(message.id);
    if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.result); }
    return;
  }
  if (message.type !== 'run' || started) return;
  started = true;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction('tools', 'console', '"use strict";\n' + message.code)(tools, logger);
    if (pending.size) throw new Error('Await every tools.call before returning; an operation may already have run');
    send({ type: 'result', result: result ?? null });
  } catch (e) { send({ type: 'error', error: e instanceof Error ? e.message : String(e) }); process.exitCode = 1; }
  finally { io.close(); process.stdin.destroy(); }
});
`;
