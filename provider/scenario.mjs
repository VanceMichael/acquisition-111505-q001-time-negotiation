export const initialState = () => ({ name: '历史网页归档', revision: 1 });

const OLD = 'Thu, 01 Oct 2026 00:00:00 GMT';
const NEW = 'Mon, 02 Nov 2026 00:00:00 GMT';
const RENEGOTIATED = 'Wed, 30 Sep 2026 23:00:00 GMT';

export async function handle({ incoming, url, state, json, bytes }) {
  if (url.pathname === '/timeline') {
    const via = target => (state.renegotiate ? `/redirect?to=${target}` : `/captures/${target}`);
    const swapped = state.swapEntryVersion ? 'new' : 'old';
    json(200, { original: '/original/loan', complete: state.complete !== false, entries: [
      { datetime: '2026-11-02T00:00:00Z', uri: via('new'), capture: 'new' },
      { datetime: '2026-10-01T00:00:00Z', uri: via(swapped), capture: 'old' },
      ...(state.conflict ? [{ datetime: '2026-10-01T00:00:00Z', uri: via('other'), capture: 'other' }] : [])
    ] }); return true;
  }
  if (url.pathname === '/gate') {
    const target = Date.parse(incoming.headers['accept-datetime'] || '');
    if (!Number.isFinite(target)) { json(400, { error: '需要有效的 Accept-Datetime' }); return true; }
    const location = state.redirectFuture || target >= Date.parse('2026-11-02') ? '/captures/new' : '/captures/old';
    bytes(302, '', 'text/plain', { location, vary: 'Accept-Datetime', 'memento-datetime': RENEGOTIATED }); return true;
  }
  if (url.pathname === '/redirect') {
    // Re-negotiation on the way to a representation: the redirect announces
    // one time, and the representation it points at announces another.
    const capture = url.searchParams.get('to') || 'old';
    bytes(302, '', 'text/plain', {
      location: `/captures/${capture}`,
      vary: 'Accept-Datetime',
      'memento-datetime': state.renegotiateDeclared || RENEGOTIATED,
    }); return true;
  }
  if (url.pathname === '/original/loan') {
    if (state.originalUnavailable) { json(503, { error: '当前原网页暂不可用' }); return true; }
    bytes(200, Buffer.from(state.currentOriginal ?? '借展说明当前页面（核对时可见）'), 'text/plain; charset=utf-8', { 'cache-control': 'no-store' }); return true;
  }
  if (url.pathname.startsWith('/captures/')) {
    const capture = url.pathname.split('/').at(-1);
    if (capture === 'old' && state.missingOld) { json(410, { error: '该归档表示已撤下' }); return true; }
    if (capture === 'new' && state.missingNew) { json(410, { error: '该归档表示已撤下' }); return true; }
    const time = capture === 'new' ? NEW : OLD;
    const texts = {
      old: state.oldText ?? '借展说明第一版',
      other: state.otherText ?? '同日另馆保存的不同文本',
      new: state.newText ?? '借展说明后续修订',
    };
    bytes(200, Buffer.from(texts[capture]), 'text/plain; charset=utf-8', { 'memento-datetime': time, link: '</original/loan>; rel="original"', 'x-capture-id': capture }); return true;
  }
  return false;
}
