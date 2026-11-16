import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
test('真实 HTTP 人工入口与查询使用同一归档', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'service-')); const service = await createIntake(directory);
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address().port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const response = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  assert.equal(response.status, 201); assert.equal((await response.json()).version, 1);
  assert.equal((await (await fetch(base + '/api/records')).json()).length, 1);
  const invalid = await fetch(base + '/api/manual', { method: 'POST', body: '{' }); assert.equal(invalid.status, 400);
});
test('HTTP 采集入口按历史时点取证并公开核对记录', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-http-'));
  const service = await createIntake(directory); const provider = createProvider();
  service.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(service, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    service.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => service.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const collect = body => fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const accepted = await collect({ source, datetime: '2026-10-15T00:00:00Z', original: '/original/loan' });
  assert.equal(accepted.status, 201);
  const body = await accepted.json();
  assert.equal(body.outcome, 'collected');
  assert.equal(body.evidence[0].capture, 'old');
  assert.equal(body.evidence[0].declaredDatetime, '2026-10-01T00:00:00.000Z');

  const records = await (await fetch(base + '/api/records')).json();
  assert.equal(records.length, 1);
  assert.equal(records[0].versions[0].data.kind, 'historical_capture');

  const repeated = await collect({ source, datetime: '2026-10-15T00:00:00Z', original: '/original/loan' });
  assert.equal((await repeated.json()).resolution.reused, true);

  const resolutions = await (await fetch(base + '/api/resolutions')).json();
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].checks.length, 2);

  const missing = await collect({ source, datetime: '2026-09-01' });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'no_version_at_or_before_target');

  const invalid = await collect({ source, datetime: 'not-a-time' });
  assert.equal(invalid.status, 400);
  assert.equal((await (await fetch(base + '/api/records')).json()).length, 1);
});
