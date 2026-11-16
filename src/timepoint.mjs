const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

export class CollectError extends Error {
  constructor(message, statusCode = 422, details = {}) {
    super(message);
    this.name = 'CollectError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class SourceError extends Error {
  constructor(message, code = 'source_error', details = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.details = details;
  }
}

export function parseTarget(value) {
  if (typeof value !== 'string' || !value.trim()) throw new CollectError('缺少目标时点 datetime', 400);
  const text = value.trim();
  let milliseconds;
  if (DATE_ONLY.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    // A bare date means the whole named day, so a later instant on that day
    // can still qualify. It must never be widened into the following day.
    milliseconds = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  } else if (TIMESTAMP.test(text)) {
    milliseconds = Date.parse(text);
  } else {
    throw new CollectError('目标时点应是带时区的 RFC3339 时刻或 YYYY-MM-DD 日期', 400);
  }
  if (!Number.isFinite(milliseconds)) throw new CollectError('目标时点不是有效时刻', 400);
  return {
    text,
    milliseconds,
    iso: new Date(milliseconds).toISOString(),
    date: text.slice(0, 10),
  };
}

export function parseArchiveTime(value, label = '来源时间') {
  if (typeof value !== 'string' || !TIMESTAMP.test(value.trim())) {
    throw new SourceError(`${label}不是带时区的 RFC3339 时刻`, 'invalid_directory');
  }
  const milliseconds = Date.parse(value.trim());
  if (!Number.isFinite(milliseconds)) throw new SourceError(`${label}不是有效时刻`, 'invalid_directory');
  return { text: value.trim(), milliseconds, iso: new Date(milliseconds).toISOString() };
}

export function parseDeclaredTime(value, label = 'Memento-Datetime') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SourceError(`最终正文缺少 ${label}`, 'missing_declared_time');
  }
  const milliseconds = Date.parse(value.trim());
  if (!Number.isFinite(milliseconds)) {
    throw new SourceError(`最终正文的 ${label} 无法解析`, 'invalid_declared_time');
  }
  return { text: value.trim(), milliseconds, iso: new Date(milliseconds).toISOString() };
}

export function normalizeSource(value) {
  if (typeof value !== 'string' || !value.trim()) throw new CollectError('缺少来源地址 source', 400);
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new CollectError('来源地址不是有效 URL', 400); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CollectError('来源地址只支持 http 或 https', 400);
  url.hash = '';
  return url;
}

export function sourceKey(url) {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function sourceDirectory(url) {
  const copy = new URL(url.href);
  if (!copy.pathname.endsWith('/')) copy.pathname += '/';
  copy.search = '';
  copy.hash = '';
  return copy;
}

export function resolveSourceReference(base, reference) {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new SourceError('来源给出了空的链接', 'invalid_directory');
  }
  let url;
  try { url = new URL(reference, base); }
  catch { throw new SourceError('来源链接不是有效 URL', 'invalid_directory'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SourceError('来源链接不是 http 或 https', 'invalid_directory');
  }
  url.hash = '';
  return url;
}

export function captureName(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  return parts.at(-1) || null;
}

export function sameUrl(left, right) {
  return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search;
}

export function requestField(payload, names, label) {
  for (const name of names) {
    if (payload[name] !== undefined && payload[name] !== null && payload[name] !== '') return payload[name];
  }
  throw new CollectError(`缺少${label}`, 400);
}
