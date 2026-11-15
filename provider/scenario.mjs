export const initialState = () => ({ name: '历史网页归档', revision: 1 });

export async function handle({ incoming, url, state, json, bytes }) {
  if (url.pathname === '/timeline') {
    json(200, { original: '/original/loan', complete: state.complete !== false, entries: [
      { datetime: '2026-11-02T00:00:00Z', uri: '/captures/new', capture: 'new' },
      { datetime: '2026-10-01T00:00:00Z', uri: '/captures/old', capture: 'old' },
      ...(state.conflict ? [{ datetime: '2026-10-01T00:00:00Z', uri: '/captures/other', capture: 'other' }] : [])
    ] }); return true;
  }
  if (url.pathname === '/gate') {
    const target = Date.parse(incoming.headers['accept-datetime'] || '');
    if (!Number.isFinite(target)) { json(400, { error: '需要有效的 Accept-Datetime' }); return true; }
    const location = state.redirectFuture || target >= Date.parse('2026-11-02') ? '/captures/new' : '/captures/old';
    bytes(302, '', 'text/plain', { location, vary: 'Accept-Datetime', 'memento-datetime': 'Wed, 30 Sep 2026 23:00:00 GMT' }); return true;
  }
  if (url.pathname.startsWith('/captures/')) {
    const capture = url.pathname.split('/').at(-1);
    const time = capture === 'new' ? 'Mon, 02 Nov 2026 00:00:00 GMT' : 'Thu, 01 Oct 2026 00:00:00 GMT';
    bytes(200, Buffer.from(capture === 'old' ? '借展说明第一版' : capture === 'other' ? '同日另馆保存的不同文本' : '借展说明后续修订'), 'text/plain; charset=utf-8', { 'memento-datetime': time, link: '</original/loan>; rel="original"', 'x-capture-id': capture }); return true;
  }
  return false;
}
