import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Archive } from '../src/archive.mjs';
import { collectHistorical } from '../src/collect.mjs';
import { createProvider } from '../provider/server.mjs';

async function harness(context, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const archive = await new Archive(directory).initialize();
  const providers = [];
  const sources = [];
  for (const value of settings.providers || [{}]) {
    const provider = createProvider();
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    providers.push(provider);
    sources.push(`http://127.0.0.1:${provider.address().port}`);
    if (Object.keys(value).length) {
      await fetch(sources.at(-1) + '/__control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    }
  }
  context.after(async () => {
    for (const provider of providers) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  return { archive, sources, providers, directory };
}

const request = (source, datetime, extra = {}) => ({
  source,
  datetime,
  original: '/original/loan',
  ...extra,
});

test('按来源时间目录选不晚于目标的最近版本，并分别留下原网页、归档表示与观察时间', async context => {
  const { archive, sources, providers } = await harness(context);
  const [source] = sources;
  const result = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));

  assert.equal(result.statusCode, 201);
  assert.equal(result.body.outcome, 'collected');
  assert.equal(result.body.selectedInstant, '2026-10-01T00:00:00.000Z');
  assert.equal(result.body.evidence.length, 1);
  const [evidence] = result.body.evidence;
  assert.equal(evidence.capture, 'old');
  assert.equal(evidence.directoryDatetime, '2026-10-01T00:00:00.000Z');
  assert.equal(evidence.declaredDatetime, '2026-10-01T00:00:00.000Z');

  // Original page, archived representation and observation time are distinct.
  assert.equal(result.body.originalPages.length, 1);
  assert.equal(result.body.originalPages[0].role, 'current-original');
  assert.equal(result.body.originalPages[0].historical, false);
  assert.match(result.body.originalPages[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.representationUri, source + '/captures/old');
  assert.ok(evidence.observedAt);
  assert.notEqual(result.body.originalPages[0].sha256, evidence.contentSha256);

  const stored = await archive.bytes(evidence.contentSha256);
  assert.equal(stored.toString(), '借展说明第一版');
  const current = await archive.bytes(result.body.originalPages[0].sha256);
  assert.match(current.toString(), /当前页面/);

  const [record] = await archive.list();
  assert.equal(record.source, source);
  assert.deepEqual(record.identity, { original: source + '/original/loan', capture: 'old' });
  assert.equal(record.versions[0].data.kind, 'historical_capture');
  assert.equal(record.versions[0].data.archive.declaredDatetime.iso, '2026-10-01T00:00:00.000Z');
  assert.equal(record.versions[0].data.rawSha256, evidence.contentSha256);
});

test('时间入口给出晚于目标的最近版本时不予采用', async context => {
  const { archive, sources, providers } = await harness(context);
  const [source] = sources;
  // The gate jumps to the 2026-11-02 capture even for an October target.
  await fetch(source + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirectFuture: true }),
  });
  const result = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));
  assert.equal(result.body.timeEntries[0].status, 'answered');
  assert.equal(result.body.timeEntries[0].declaredDatetime, '2026-11-02T00:00:00.000Z');
  assert.equal(result.body.timeEntries[0].afterTarget, true);
  assert.equal(result.body.timeEntries[0].usedAsHistoricalEvidence, false);
  assert.equal(result.body.evidence[0].capture, 'old');
  assert.ok(result.body.warnings.some(warning => warning.code === 'time_entry_answered_with_later_version'));
  assert.equal(providers.length, 1);
});

test('取回经过重新协商时间的跳转时，以最终正文自己声明的时点为准', async context => {
  const { archive, sources } = await harness(context, { providers: [{ renegotiate: true }] });
  const [source] = sources;
  const result = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));
  assert.equal(result.statusCode, 201);
  const [evidence] = result.body.evidence;
  assert.equal(evidence.declaredDatetime, '2026-10-01T00:00:00.000Z');
  assert.ok(result.body.warnings.some(warning => warning.code === 'time_renegotiated_during_redirect'));
  const [record] = await archive.list();
  const hops = record.versions[0].data.archive.hops;
  assert.ok(hops.length >= 2);
  assert.equal(hops[0].role, 'time-negotiation');
  assert.equal(hops.at(-1).role, 'representation');
  // The redirect's own hint must not be mistaken for the body's declaration.
  assert.notEqual(hops[0].mementoDatetime, hops.at(-1).mementoDatetime);
});

test('跳转最终落到晚于目标的正文时不存为历史事实', async context => {
  const { archive, sources } = await harness(context, { providers: [{ swapEntryVersion: true }] });
  const [source] = sources;
  const result = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, 'representation_after_target');
  assert.equal(result.body.evidence.length, 0);
  assert.equal(result.body.rejected[0].reasons[0].code, 'representation_after_target');
  assert.equal(result.body.rejected[0].reasons[0].declared, '2026-11-02T00:00:00.000Z');
  assert.equal((await archive.list()).length, 0);
});

test('不同归档站对同一时刻给出不同内容时并列保留而非任选其一', async context => {
  const { archive, sources } = await harness(context, {
    providers: [{}, { oldText: '另一归档站保存的同日正文' }],
  });
  const result = await collectHistorical(archive, request(sources, '2026-10-15T00:00:00Z'));
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.outcome, 'divergent');
  assert.equal(result.body.evidence.length, 2);
  assert.equal(new Set(result.body.evidence.map(item => item.contentSha256)).size, 2);
  assert.equal(new Set(result.body.evidence.map(item => item.source)).size, 2);
  assert.ok(result.body.warnings.some(warning => warning.code === 'same_instant_different_content'));

  const records = await archive.list();
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.versions[0].data.divergent, true);
    assert.equal(record.versions[0].data.archive.declaredDatetime.iso, '2026-10-01T00:00:00.000Z');
  }
});

test('目录不完整与目录完整但没有版本必须区分', async context => {
  const { archive, sources } = await harness(context);
  const [source] = sources;
  await fetch(source + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ complete: false }),
  });
  const incomplete = await collectHistorical(archive, request(source, '2026-09-01'));
  assert.equal(incomplete.statusCode, 422);
  assert.equal(incomplete.body.code, 'directory_incomplete');
  assert.ok(incomplete.body.warnings.some(warning => warning.code === 'directory_incomplete'));

  await fetch(source + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ complete: true }),
  });
  const empty = await collectHistorical(archive, request(source, '2026-09-01'));
  assert.equal(empty.statusCode, 404);
  assert.equal(empty.body.code, 'no_version_at_or_before_target');
  assert.equal(empty.body.evidence.length, 0);

  // Neither determination may fall back to the live page.
  for (const result of [incomplete, empty]) {
    assert.equal(result.body.evidence.length, 0);
    assert.equal(result.body.originalPages[0].historical, false);
    assert.equal(result.body.note.includes('不会用当前网页'), true);
  }
  assert.deepEqual((await archive.list()), []);
});

test('重复核对同一日期能解释沿用或改变选中证据', async context => {
  const { archive, sources } = await harness(context);
  const [source] = sources;
  const first = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));
  assert.equal(first.body.resolution.code, 'first_check');

  const second = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));
  assert.equal(second.body.resolution.reused, true);
  assert.equal(second.body.resolution.code, 'same_evidence_reused');
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.evidence[0].version, first.body.evidence[0].version);
  assert.equal(second.body.evidence[0].observations.length, 2);

  // The archive now serves different bytes at the same instant.
  await fetch(source + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldText: '重新整理的借展说明' }),
  });
  const third = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));
  assert.equal(third.body.resolution.reused, false);
  assert.equal(third.body.resolution.code, 'same_instant_content_changed');
  assert.equal(third.body.evidence[0].version, second.body.evidence[0].version + 1);
  assert.notEqual(third.body.evidence[0].contentSha256, second.body.evidence[0].contentSha256);

  // Both bodies stay retrievable; the check history explains the change.
  const [record] = await archive.list();
  assert.equal(record.versions.length, 2);
  assert.equal((await archive.bytes(record.versions[0].sha256)).toString(), '借展说明第一版');
  assert.equal((await archive.bytes(record.versions[1].sha256)).toString(), '重新整理的借展说明');

  const journal = await archive.resolution({
    source, original: source + '/original/loan', date: '2026-10-15',
  });
  assert.equal(journal.checks.length, 3);
  assert.equal(journal.checks[1].comparison.reused, true);
  assert.equal(journal.checks[2].comparison.code, 'same_instant_content_changed');
  assert.match(journal.checks[2].comparison.explanation, /正文内容变化/);
});

test('核对当天可见的当前网页不会被写进历史证据', async context => {
  const { archive, sources } = await harness(context);
  const [source] = sources;
  await fetch(source + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentOriginal: '借展说明（今天的最新版本）' }),
  });
  const result = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));
  const [record] = await archive.list();
  assert.equal((await archive.bytes(result.body.evidence[0].contentSha256)).toString(), '借展说明第一版');
  assert.equal(record.versions[0].data.rawSha256, result.body.evidence[0].contentSha256);
  const current = await archive.bytes(result.body.originalPages[0].sha256);
  assert.match(current.toString(), /今天的最新版本/);
  assert.notEqual(record.versions[0].data.rawSha256, result.body.originalPages[0].sha256);
});

test('无效目标时点与不一致的原网页被拒绝', async context => {
  const { archive, sources } = await harness(context);
  const [source] = sources;
  await assert.rejects(() => collectHistorical(archive, { source, datetime: '十月十五日' }), /目标时点/);
  await assert.rejects(() => collectHistorical(archive, { source, datetime: '2026-10-15T00:00:00' }), /时区/);
  await assert.rejects(
    () => collectHistorical(archive, request(source, '2026-10-15T00:00:00Z', { original: '/original/other' })),
    /不一致/,
  );
});

test('目录未排序也按时刻选择，且目标日期按整天处理', async context => {
  const { archive, sources } = await harness(context);
  const [source] = sources;
  const sameDay = await collectHistorical(archive, request(source, '2026-10-01'));
  assert.equal(sameDay.statusCode, 201);
  assert.equal(sameDay.body.selectedInstant, '2026-10-01T00:00:00.000Z');

  const dayBefore = await collectHistorical(archive, request(source, '2026-09-30'));
  assert.equal(dayBefore.statusCode, 404);
  assert.equal(dayBefore.body.code, 'no_version_at_or_before_target');
});

test('取回失败与目录没有版本可区分', async context => {
  const { archive, sources } = await harness(context, { providers: [{ missingOld: true }] });
  const [source] = sources;
  const result = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));
  assert.equal(result.statusCode, 502);
  assert.equal(result.body.code, 'no_retrievable_version');
  assert.equal(result.body.evidence.length, 0);
  assert.equal(result.body.rejected[0].reasons[0].code, 'source_http_error');

  await fetch(source + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ missingOld: false }),
  });
  const recovered = await collectHistorical(archive, request(source, '2026-10-15T00:00:00Z'));
  assert.equal(recovered.statusCode, 201);
  assert.equal(recovered.body.resolution.code, 'evidence_now_available');
});

test('缺少来源地址时拒绝且不写记录', async context => {
  const { archive } = await harness(context);
  await assert.rejects(() => collectHistorical(archive, { datetime: '2026-10-15T00:00:00Z' }), /缺少来源地址/);
  assert.deepEqual(await archive.list(), []);
});

test('最近时点取回失败时退回更早版本，并说明退回了哪些时点', async context => {
  const { archive, sources } = await harness(context, { providers: [{ missingNew: true }] });
  const [source] = sources;
  const result = await collectHistorical(archive, request(source, '2026-11-05T00:00:00Z'));
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.selectedInstant, '2026-10-01T00:00:00.000Z');
  assert.equal(result.body.evidence[0].capture, 'old');
  const fallback = result.body.warnings.find(warning => warning.code === 'fell_back_to_earlier_version');
  assert.deepEqual(fallback.rejectedInstants, ['2026-11-02T00:00:00.000Z']);
  assert.equal(result.body.rejected[0].instant, '2026-11-02T00:00:00.000Z');
  assert.equal(result.body.rejected[0].reasons[0].code, 'source_http_error');
});
