import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTarget,
  parseArchiveTime,
  parseDeclaredTime,
  sourceKey,
  sourceDirectory,
  resolveSourceReference,
  sameUrl,
  CollectError,
  SourceError,
} from '../src/timepoint.mjs';

test('目标时刻接受带时区 RFC3339 与整天日期', () => {
  assert.equal(parseTarget('2026-10-15T00:00:00Z').iso, '2026-10-15T00:00:00.000Z');
  assert.equal(parseTarget('2026-10-15T08:00:00+08:00').iso, '2026-10-15T00:00:00.000Z');
  const day = parseTarget('2026-10-15');
  assert.equal(day.date, '2026-10-15');
  assert.equal(day.iso, '2026-10-15T23:59:59.999Z');
  // A date-only target never spills into the next day.
  assert.ok(day.milliseconds < Date.parse('2026-10-16T00:00:00Z'));
});

test('缺少时区或格式错误的目标时刻被拒绝', () => {
  assert.throws(() => parseTarget('2026-10-15T00:00:00'), CollectError);
  assert.throws(() => parseTarget('2026/10/15'), CollectError);
  assert.throws(() => parseTarget('十月十五日'), CollectError);
  assert.throws(() => parseTarget(''), CollectError);
  // Surrounding whitespace is harmless.
  assert.equal(parseTarget('  2026-10-15T00:00:00Z  ').iso, '2026-10-15T00:00:00.000Z');
});

test('来源时间必须是带时区的 RFC3339', () => {
  assert.equal(parseArchiveTime('2026-10-01T00:00:00Z').milliseconds, Date.parse('2026-10-01T00:00:00Z'));
  assert.throws(() => parseArchiveTime('2026-10-01'), SourceError);
  assert.throws(() => parseArchiveTime('2026-10-01T00:00:00'), SourceError);
  assert.throws(() => parseArchiveTime(undefined), SourceError);
});

test('正文声明的 Memento-Datetime 可以是 HTTP 日期', () => {
  assert.equal(parseDeclaredTime('Thu, 01 Oct 2026 00:00:00 GMT').iso, '2026-10-01T00:00:00.000Z');
  assert.throws(() => parseDeclaredTime(''), SourceError);
  assert.throws(() => parseDeclaredTime('sometime'), SourceError);
});

test('相对链接按实际来源地址解释，来源身份不受尾斜杠影响', () => {
  const source = new URL('http://127.0.0.1:4200/base/');
  assert.equal(sourceKey(source), 'http://127.0.0.1:4200/base');
  assert.equal(sourceKey(new URL('http://127.0.0.1:4200/base')), sourceKey(source));
  assert.equal(sourceDirectory(new URL('http://127.0.0.1:4200')).href, 'http://127.0.0.1:4200/');
  assert.equal(resolveSourceReference(source, '/original/loan').href, 'http://127.0.0.1:4200/original/loan');
  assert.equal(resolveSourceReference(source, 'captures/old').href, 'http://127.0.0.1:4200/base/captures/old');
  assert.ok(sameUrl(new URL('http://a/x?q=1'), new URL('http://a/x?q=1')));
  assert.ok(!sameUrl(new URL('http://a/x?q=1'), new URL('http://a/x?q=2')));
  assert.throws(() => resolveSourceReference(source, 'javascript:alert(1)'), SourceError);
  assert.throws(() => resolveSourceReference(source, ''), SourceError);
});
