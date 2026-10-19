import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openResponse } from '../src/openresponses.mjs';

const options = { token: 'fixture-gateway-token', sessionKey: 'agent:main:task:fixture', input: 'fixture request' };
const event = value => `data: ${JSON.stringify(value)}\n\n`;
async function gateway(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('gateway execution survives a silent tool phase and preserves routing, UTF-8, SSE frames and usage', async t => {
  let received;
  const url = await gateway(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': gateway accepted\r\n\r\n' + event({ type: 'response.created' }));
    await delay(Number(process.env.DOUDOU_STREAM_IDLE_TEST_MS || 40));
    const data = Buffer.from(event({ type: 'response.output_text.delta', delta: '静默执行完成' }).replaceAll('\n', '\r\n'));
    for (const byte of data) res.write(Buffer.from([byte]));
    res.end(event({ type: 'response.completed', response: { usage: { total_tokens: 12 } } }).trimEnd());
  });
  const deltas = [], result = await openResponse(url, { ...options, onText: text => deltas.push(text) });
  assert.equal(received.headers.authorization, `Bearer ${options.token}`);
  assert.equal(received.headers['x-openclaw-session-key'], options.sessionKey);
  assert.deepEqual(received.body, { model: 'openclaw/main', input: options.input, stream: true });
  assert.equal(result.text, '静默执行完成');
  assert.equal(deltas.join(''), result.text);
  assert.deepEqual(result.usage, { total_tokens: 12 });
});

test('explicit cancellation closes an accepted run while it is silent', async t => {
  const connected = Promise.withResolvers(), disconnected = Promise.withResolvers();
  const url = await gateway(t, (_req, res) => {
    res.on('close', disconnected.resolve);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.created' })); connected.resolve();
  });
  const controller = new AbortController();
  const run = openResponse(url, { ...options, signal: controller.signal });
  await connected.promise; controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  await disconnected.promise;
});

test('a partial answer, backend failure, token limit or closed socket cannot become a successful task', async t => {
  for (const [name, handler, error] of [
    ['missing completion', (_req, res) => res.end(event({ type: 'response.output_text.delta', delta: 'partial' })), /未收到完成结果/],
    ['backend error', (_req, res) => res.end(event({ type: 'response.failed', response: { error: { message: 'fixture model unavailable' } } })), /fixture model unavailable/],
    ['output limit', (_req, res) => res.end(event({ type: 'response.incomplete' })), /输出上限/],
    ['connection lost', (_req, res) => { res.write(event({ type: 'response.created' })); setImmediate(() => res.destroy()); }, /执行连接中断/],
    ['HTTP failure', (_req, res) => { res.writeHead(503); res.end(); }, /HTTP 503/],
  ]) await t.test(name, async t => {
    const url = await gateway(t, handler);
    await assert.rejects(openResponse(url, options), error);
  });
});

test('a rejected gateway request preserves its useful cause instead of only HTTP 400',async t=>{
  const url=await gateway(t,(_req,res)=>{res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'input[0].content[1].source is required'}}));});
  await assert.rejects(openResponse(url,options),/HTTP 400：input\[0\].content\[1\].source is required/);
});
