import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory);
const provider = createProvider();
const providerEcho = createProvider();
try {
  intake.listen(0, '127.0.0.1');
  provider.listen(0, '127.0.0.1');
  providerEcho.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening'), once(providerEcho, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const other = `http://127.0.0.1:${providerEcho.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));

  const control = (address, value) => fetch(address + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  const collect = async body => {
    const response = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const brief = result => ({
    状态: result.status,
    结果: result.body.outcome,
    原因: result.body.code,
    选中时刻: result.body.selectedInstant,
    证据: result.body.evidence.map(item => ({
      来源: item.source,
      归档: item.capture,
      目录时刻: item.directoryDatetime,
      声明时刻: item.declaredDatetime,
      观察时刻: item.observedAt,
      版本: item.version,
    })),
    原网页: result.body.originalPages.map(page => ({ 角色: page.role, 历史事实: page.historical, 观察时刻: page.observedAt })),
    时间入口: result.body.timeEntries.map(entry => ({ 状态: entry.status, 正文声明: entry.declaredDatetime, 晚于目标: entry.afterTarget })),
    核对说明: result.body.resolution && result.body.resolution.explanation,
  });

  console.log(JSON.stringify({ 人工收件: await (await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) })).json() }));

  const first = await collect({ source, datetime: '2026-10-15T00:00:00Z', original: '/original/loan' });
  console.log(JSON.stringify({ 历史采集_10月15日: brief(first) }));
  const again = await collect({ source, datetime: '2026-10-15T00:00:00Z', original: '/original/loan' });
  console.log(JSON.stringify({ 重复核对_10月15日: brief(again) }));

  await control(source, { redirectFuture: true });
  const later = await collect({ source, datetime: '2026-10-15T00:00:00Z', original: '/original/loan' });
  console.log(JSON.stringify({ 时间入口给出11月版本: brief(later) }));

  await control(source, { redirectFuture: false, complete: false });
  const gap = await collect({ source, datetime: '2026-09-01', original: '/original/loan' });
  console.log(JSON.stringify({ 目录不完整_9月1日: brief(gap) }));

  await control(source, { complete: true });
  await control(other, { oldText: '另一归档站保存的同日正文' });
  const conflict = await collect({ source: [source, other], datetime: '2026-10-15T00:00:00Z', original: '/original/loan' });
  console.log(JSON.stringify({ 两站同日不同内容: brief(conflict) }));

  const records = await (await fetch(base + '/api/records')).json();
  console.log(JSON.stringify({
    已存记录: records.map(record => ({
      来源: record.source,
      身份: record.identity,
      版本: record.versions.map(version => ({
        版本: version.version,
        归档时刻: version.data.archive?.declaredDatetime?.iso,
        观察次数: version.observations?.length,
        冲突: version.data.divergent,
      })),
    })),
  }));
  const resolutions = await (await fetch(base + '/api/resolutions')).json();
  console.log(JSON.stringify({
    核对记录: resolutions.map(entry => ({
      范围: entry.scope,
      次数: entry.checks.length,
      最近: entry.checks.at(-1).comparison,
    })),
  }));
} finally {
  intake.closeAllConnections();
  provider.closeAllConnections();
  providerEcho.closeAllConnections();
  await Promise.all([
    new Promise(resolve => intake.close(resolve)),
    new Promise(resolve => provider.close(resolve)),
    new Promise(resolve => providerEcho.close(resolve)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
