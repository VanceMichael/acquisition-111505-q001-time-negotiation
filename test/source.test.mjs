import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('协商跳转和最终正文有独立时间证据', async context => {
  const { base, control } = await withSource(context);
  const timeline = await (await fetch(base + '/timeline')).json(); assert.equal(timeline.entries[0].capture, 'new');
  await control({ redirectFuture: true });
  const gate = await fetch(base + '/gate', { redirect: 'manual', headers: { 'Accept-Datetime': 'Thu, 15 Oct 2026 00:00:00 GMT' } });
  assert.equal(gate.status, 302); assert.equal(gate.headers.get('location'), '/captures/new');
  const capture = await fetch(base + gate.headers.get('location')); assert.match(capture.headers.get('memento-datetime'), /Nov/);
});
test('同日冲突与目录不完整不会被来源合并', async context => {
  const { base, control } = await withSource(context); await control({ conflict: true, complete: false });
  const timeline = await (await fetch(base + '/timeline')).json(); assert.equal(timeline.complete, false);
  assert.equal(timeline.entries.filter(entry => entry.datetime === '2026-10-01T00:00:00Z').length, 2);
});
