import { digest } from './archive.mjs';
import { request as httpRequest, decodeJson } from './transport.mjs';
import {
  CollectError,
  SourceError,
  parseTarget,
  parseArchiveTime,
  parseDeclaredTime,
  normalizeSource,
  sourceKey,
  sourceDirectory,
  resolveSourceReference,
  captureName,
  sameUrl,
  requestField,
} from './timepoint.mjs';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
const MAX_ENTRIES = 200;
const CONCURRENCY = 6;
const MAX_REPRESENTATION_BYTES = 10 * 1024 * 1024;
const MAX_TIMELINE_BYTES = 1024 * 1024;
const LIVE_PAGE_NOTE = '历史采集只读取来源时间目录与归档表示；核对当时的当前网页只作参照，不会用当前网页补成历史事实';

const header = (headers, name) => {
  const value = headers?.[name.toLowerCase()] ?? headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

function optionalHeaderTime(value, label) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = parseDeclaredTime(value, label);
  return { text: parsed.text, iso: parsed.iso, milliseconds: parsed.milliseconds };
}

function linkOriginal(headers, base) {
  const value = header(headers, 'link');
  if (typeof value !== 'string') return null;
  for (const part of value.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?original"?/i);
    if (match) {
      try { return resolveSourceReference(base, match[1]); }
      catch { return null; }
    }
  }
  return null;
}

function parseTimeline(payload, timelineUrl) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SourceError('时间目录不是 JSON 对象', 'invalid_directory');
  }
  if (typeof payload.original !== 'string' || !payload.original.trim()) {
    throw new SourceError('时间目录缺少原网页标识 original', 'invalid_directory');
  }
  if (typeof payload.complete !== 'boolean') {
    throw new SourceError('时间目录缺少布尔字段 complete', 'invalid_directory');
  }
  if (!Array.isArray(payload.entries)) {
    throw new SourceError('时间目录缺少 entries 数组', 'invalid_directory');
  }
  const original = resolveSourceReference(timelineUrl, payload.original);
  const entries = payload.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SourceError(`时间目录第 ${index + 1} 条不是对象`, 'invalid_directory');
    }
    if (typeof entry.capture !== 'string' || !entry.capture.trim()) {
      throw new SourceError(`时间目录第 ${index + 1} 条缺少 capture`, 'invalid_directory');
    }
    if (typeof entry.uri !== 'string' || !entry.uri.trim()) {
      throw new SourceError(`时间目录第 ${index + 1} 条缺少 uri`, 'invalid_directory');
    }
    const time = parseArchiveTime(entry.datetime, `时间目录第 ${index + 1} 条 datetime`);
    const url = resolveSourceReference(timelineUrl, entry.uri);
    return {
      index,
      datetime: time,
      uri: url,
      capture: entry.capture,
      uriName: captureName(url),
      url: url.href,
      key: `${entry.capture}\u0000${url.origin}\u0000${url.pathname}\u0000${url.search}`,
    };
  });
  return { original, entries, complete: payload.complete };
}

async function fetchTimeline(timelineUrl) {
  let reply;
  try {
    reply = await httpRequest(timelineUrl, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new SourceError(`来源时间目录无法连接：${error.message}`, 'source_unreachable', { url: timelineUrl.href });
  }
  if (reply.status < 200 || reply.status > 299) {
    throw new SourceError(`来源时间目录返回 ${reply.status}`, 'source_http_error', { status: reply.status, url: timelineUrl.href });
  }
  if (reply.bytes.length > MAX_TIMELINE_BYTES) {
    throw new SourceError('来源时间目录超过 1 MiB 上限', 'directory_too_large', { url: timelineUrl.href });
  }
  try { return decodeJson(reply); }
  catch (error) {
    throw new SourceError(`来源时间目录无法解析：${error.message}`, 'invalid_directory', { url: timelineUrl.href });
  }
}

async function follow(url, acceptInstant) {
  const hops = [];
  const visited = new Set();
  let current = url;
  for (let step = 0; step <= MAX_REDIRECTS; step += 1) {
    if (visited.has(current.href)) {
      throw new SourceError('来源跳转形成循环', 'redirect_loop', { url: current.href });
    }
    visited.add(current.href);
    let response;
    try {
      response = await httpRequest(current, {
        headers: {
          'accept-datetime': new Date(acceptInstant).toUTCString(),
          'user-agent': 'time-negotiation-intake/1.0',
        },
      });
    } catch (error) {
      throw new SourceError(`来源无法连接 ${current.href}：${error.message}`, 'source_unreachable', { url: current.href });
    }
    const location = header(response.headers, 'location');
    let declared = null;
    let declarationError = null;
    try { declared = optionalHeaderTime(header(response.headers, 'memento-datetime'), '跳转响应时间'); }
    catch (error) { declarationError = error.message; }
    const redirect = REDIRECT_STATUS.has(response.status);
    hops.push({
      url: current.href,
      status: response.status,
      role: redirect ? 'time-negotiation' : 'representation',
      location: location || null,
      mementoDatetime: declared ? declared.text : (header(response.headers, 'memento-datetime') || null),
      vary: header(response.headers, 'vary') || null,
      ...(declarationError ? { declarationError } : {}),
    });
    if (redirect) {
      if (!location) {
        throw new SourceError(`来源返回 ${response.status} 却没有 Location`, 'invalid_redirect', { url: current.href });
      }
      let next;
      try { next = resolveSourceReference(current, location); }
      catch (error) {
        throw new SourceError(`来源跳转目标无效：${error.message}`, 'invalid_redirect', { url: current.href, location });
      }
      if (next.origin !== current.origin) {
        throw new SourceError('来源跳转到了另一个站点', 'cross_origin_redirect', { from: current.href, to: next.href });
      }
      current = next;
      continue;
    }
    if (response.status < 200 || response.status > 299) {
      throw new SourceError(`归档表示返回 ${response.status}`, 'source_http_error', { status: response.status, url: current.href });
    }
    if (response.bytes.length > MAX_REPRESENTATION_BYTES) {
      throw new SourceError('归档表示超过 10 MiB 上限', 'representation_too_large', { url: current.href });
    }
    return { final: response, finalUrl: current, hops };
  }
  throw new SourceError(`来源跳转超过 ${MAX_REDIRECTS} 次`, 'redirect_limit', { url: url.href });
}

// Retrieve one directory entry and verify it against its own declaration.
// A retrieval can pass through a redirect that re-negotiates the time; the
// only time that counts for the saved body is the final representation's own
// Memento-Datetime, never the redirect response's hint.
async function retrieve(entry, context) {
  const { target, original, now } = context;
  const startedAt = now();
  try {
    const negotiated = await follow(entry.uri, entry.datetime.milliseconds);
    const declared = parseDeclaredTime(header(negotiated.final.headers, 'memento-datetime'));
    const observedAt = now();
    if (declared.milliseconds > target.milliseconds) {
      throw new SourceError(
        `取回的正文声明 ${declared.iso} 晚于目标时点 ${target.iso}`,
        'representation_after_target',
        { declared: declared.iso, entryDatetime: entry.datetime.iso, finalUrl: negotiated.finalUrl.href },
      );
    }
    const warnings = [];
    if (declared.milliseconds !== entry.datetime.milliseconds) {
      warnings.push({
        code: 'representation_timestamp_differs_from_directory',
        message: `目录条目时间为 ${entry.datetime.iso}，最终正文声明为 ${declared.iso}；目录时间只用于挑选，归档时点以正文自己的声明为准。`,
      });
    }
    if (negotiated.hops.length > 1) {
      warnings.push({
        code: 'time_renegotiated_during_redirect',
        message: '取回过程中经过跳转；最终正文自己的 Memento-Datetime 才是其历史时点声明，跳转响应的中间时间不作数。',
      });
    }
    if (negotiated.finalUrl.href !== entry.uri.href) {
      warnings.push({
        code: 'representation_uri_changed',
        message: `目录条目指向 ${entry.uri.href}，最终取得 ${negotiated.finalUrl.href}。`,
      });
    }
    const finalOriginal = linkOriginal(negotiated.final.headers, negotiated.finalUrl);
    if (finalOriginal && !sameUrl(finalOriginal, original)) {
      warnings.push({
        code: 'original_link_mismatch',
        message: `最终正文声明的原网页 ${finalOriginal.href} 与目录声明的 ${original.href} 不一致。`,
      });
    }
    return {
      ok: true,
      entry,
      finalUrl: negotiated.finalUrl,
      finalCapture: captureName(negotiated.finalUrl),
      representationOriginal: finalOriginal ? finalOriginal.href : null,
      declared,
      startedAt,
      observedAt,
      bytes: negotiated.final.bytes,
      contentSha256: digest(negotiated.final.bytes),
      contentType: header(negotiated.final.headers, 'content-type') || null,
      hops: negotiated.hops,
      vary: header(negotiated.final.headers, 'vary') || null,
      warnings,
    };
  } catch (error) {
    return {
      ok: false,
      entry,
      startedAt,
      observedAt: now(),
      code: error.code || 'retrieval_failed',
      message: error.message,
      details: error.details || {},
    };
  }
}

// The archive's time entry is a cross-check, not the selector. Asked for a day
// between captures it may answer with the closest version it holds even when
// that version is later than the day. Such a body is recorded as a rejected
// observation and never archived as a historical fact.
async function probeTimeEntry(source, target, now) {
  const gate = new URL('gate', sourceDirectory(source));
  const observedAt = now();
  try {
    const negotiated = await follow(gate, target.milliseconds);
    const declared = parseDeclaredTime(header(negotiated.final.headers, 'memento-datetime'));
    return {
      uri: gate.href,
      finalUri: negotiated.finalUrl.href,
      status: 'answered',
      observedAt,
      declaredDatetime: declared.iso,
      afterTarget: declared.milliseconds > target.milliseconds,
      hops: negotiated.hops,
      usedAsHistoricalEvidence: false,
    };
  } catch (error) {
    return {
      uri: gate.href,
      status: 'unavailable',
      observedAt,
      code: error.code || 'probe_failed',
      message: error.message,
      afterTarget: false,
      usedAsHistoricalEvidence: false,
    };
  }
}

// Keep the page that was live at check time only as a reference. Its bytes get
// their own blob so the current page and the archived capture stay separable.
async function fetchOriginalPage(archive, original, now) {
  const observedAt = now();
  try {
    const reply = await httpRequest(original, {
      headers: { accept: '*/*', 'user-agent': 'time-negotiation-intake/1.0' },
    });
    return {
      uri: original.href,
      role: 'current-original',
      historical: false,
      observedAt,
      status: reply.status,
      contentType: header(reply.headers, 'content-type') || null,
      bytes: reply.bytes.length,
      sha256: await archive.store(reply.bytes),
      note: '这是核对当时的当前网页，仅作为原网页参照，不能当作目标时点的历史事实。',
    };
  } catch (error) {
    return {
      uri: original.href,
      role: 'current-original',
      historical: false,
      observedAt,
      status: 'unavailable',
      code: 'original_unreachable',
      message: error.message,
      note: '核对当时的当前网页未能取回；历史判定不使用它。',
    };
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function snapshot(item) {
  return {
    source: item.source,
    capture: item.capture,
    directoryDatetime: item.directoryDatetime,
    declaredDatetime: item.declaredDatetime,
    sha256: item.contentSha256,
    version: item.version,
  };
}

const selectionKeys = list => list
  .map(item => `${item.source}\u0000${item.capture}\u0000${item.declaredDatetime}`)
  .sort();
const contentKeys = list => list
  .map(item => `${item.source}\u0000${item.capture}\u0000${item.declaredDatetime}\u0000${item.sha256}`)
  .sort();

function compareChecks(previous, next, target) {
  if (!previous) {
    return {
      reused: false,
      code: 'first_check',
      explanation: `首次核对目标 ${target.text}；本次${next.outcome === 'unavailable' ? '未选定' : '选定'}证据。`,
    };
  }
  if (previous.target && previous.target.iso !== target.iso) {
    return {
      reused: false,
      code: 'target_instant_changed',
      explanation: `目标时点由 ${previous.target.text} 变为 ${target.text}，按新时点重新选择版本。`,
    };
  }
  const before = previous.selected || [];
  const after = next.selected || [];
  const sameSelection = JSON.stringify(selectionKeys(before)) === JSON.stringify(selectionKeys(after));
  const sameContent = JSON.stringify(contentKeys(before)) === JSON.stringify(contentKeys(after));
  const beforeKeys = selectionKeys(before).join('、') || '（无）';
  const afterKeys = selectionKeys(after).join('、') || '（无）';
  const previousLabel = { at: previous.at, outcome: previous.outcome, code: previous.code };

  if (previous.outcome === next.outcome) {
    if (next.outcome === 'collected') {
      if (sameContent) {
        return {
          reused: true,
          code: 'same_evidence_reused',
          explanation: `同一目标日期再次核对：来源仍给出相同正文，沿用已存证据（版本 ${after.map(item => item.version).join('、')}）。`,
          previous: previousLabel,
        };
      }
      if (sameSelection) {
        return {
          reused: false,
          code: 'same_instant_content_changed',
          explanation: `同一目标日期再次核对：选中的归档时点未变（${afterKeys}），但正文内容变化，已保存为新版本并保留旧版本。`,
          previous: previousLabel,
        };
      }
      return {
        reused: false,
        code: 'selection_changed',
        explanation: `同一目标日期再次核对：选中的证据由 ${beforeKeys} 变为 ${afterKeys}。`,
        previous: previousLabel,
      };
    }
    if (next.outcome === 'divergent') {
      if (sameContent) {
        return {
          reused: true,
          code: 'same_divergence_reused',
          explanation: `同一目标日期再次核对：同一时刻仍有多份不同正文（${afterKeys}），继续并列保留，未改为单一版本。`,
          previous: previousLabel,
        };
      }
      return {
        reused: false,
        code: 'divergence_evidence_changed',
        explanation: `同一目标日期再次核对：并列证据由 ${beforeKeys} 变为 ${afterKeys}。`,
        previous: previousLabel,
      };
    }
    return {
      reused: false,
      code: previous.code === next.code ? 'same_unavailable_determination' : 'unavailable_reason_changed',
      explanation: previous.code === next.code
        ? `同一目标日期再次核对：仍无法选定证据（${next.code}），未用当前网页顶替。`
        : `同一目标日期再次核对：无法选定的原因由 ${previous.code} 变为 ${next.code}。`,
      previous: previousLabel,
    };
  }
  const transitions = {
    'unavailable->collected': ['evidence_now_available', '上次未选出证据，本次已取得符合目标时点的证据。'],
    'unavailable->divergent': ['divergence_now_observed', '上次未选出证据，本次在同一时刻发现并列的不同正文。'],
    'collected->unavailable': ['evidence_no_longer_available', `上次选定的证据本次无法取得（${next.code}），未沿用旧证据。`],
    'divergent->unavailable': ['divergence_evidence_no_longer_available', `上次并列的证据本次无法取得（${next.code}），未沿用旧证据。`],
    'collected->divergent': ['evidence_became_divergent', `同一时刻本次出现并列的不同正文（${afterKeys}）。`],
    'divergent->collected': ['divergence_resolved_to_single_evidence', `上次并列的不同正文本次只剩 ${afterKeys}。`],
  };
  const [code, explanation] = transitions[`${previous.outcome}->${next.outcome}`]
    || ['outcome_changed', `同一目标日期再次核对：结果由 ${previous.code} 变为 ${next.code}。`];
  return { reused: false, code, explanation, previous: previousLabel };
}

function evidenceData(context, target, attempt, group, warnings, divergent) {
  const { timelineUrl } = context;
  return {
    kind: 'historical_capture',
    source: { id: context.sourceId, url: context.source.href },
    target: { text: target.text, iso: target.iso, date: target.date },
    original: { uri: context.original.href, declaredBy: timelineUrl.href },
    directory: {
      uri: timelineUrl.href,
      complete: context.complete,
      completeAttested: context.complete === true,
      entry: {
        datetime: attempt.entry.datetime.text,
        normalizedDatetime: attempt.entry.datetime.iso,
        uri: attempt.entry.uri.href,
        capture: attempt.entry.capture,
      },
      parallelCaptures: group.items.map(item => ({
        source: item.source,
        capture: item.attempt.entry.capture,
        retrieved: item.attempt.ok,
      })),
    },
    archive: {
      representationUri: attempt.finalUrl.href,
      capture: attempt.finalCapture,
      declaredDatetime: { header: attempt.declared.text, iso: attempt.declared.iso },
      directoryDatetime: attempt.entry.datetime.iso,
      hops: attempt.hops,
      vary: attempt.vary,
      representationOriginal: attempt.representationOriginal,
      contentType: attempt.contentType,
    },
    observedAt: attempt.observedAt,
    requestStartedAt: attempt.startedAt,
    rawSha256: attempt.contentSha256,
    divergent,
    warnings,
    note: LIVE_PAGE_NOTE,
  };
}

async function saveEvidence(archive, context, target, attempt, group, warnings, divergent) {
  // Identity is the archived representation, addressed by its own body and
  // declared time; re-checking the same body records another observation
  // instead of pretending it is a new version. Fetch routes may change.
  const fingerprint = digest(Buffer.from(JSON.stringify([
    context.sourceId,
    context.original.href,
    attempt.entry.capture,
    attempt.declared.iso,
    attempt.contentSha256,
  ])));
  const data = evidenceData(context, target, attempt, group, warnings, divergent);
  const identity = { original: context.original.href, capture: attempt.entry.capture };
  return archive.accept(context.sourceId, identity, data, attempt.bytes, {
    fingerprint,
    observeAt: attempt.observedAt,
  });
}

function scopeFor(contexts, requestedOriginal, target) {
  const originals = [...new Set(contexts.map(context => context.original.href))].sort();
  return {
    source: contexts.map(context => context.sourceId).sort().join(','),
    // Keep the journal keyed by the original page the caller named; sources
    // that declare a different original are still listed in each check.
    original: originals.length === 1
      ? originals[0]
      : requestedOriginal === null
        ? originals.join(',')
        : resolveSourceReference(contexts[0].timelineUrl, requestedOriginal).href,
    originalBySource: contexts.map(context => ({ source: context.sourceId, original: context.original.href })),
    date: target.date,
  };
}

function directorySummary(contexts) {
  return contexts.map(context => ({
    source: context.sourceId,
    uri: context.timelineUrl.href,
    complete: context.complete,
    entries: context.entries.length,
    eligibleEntries: context.eligible.length,
  }));
}

function rejectedSummary(rejected) {
  return rejected.map(item => ({
    instant: item.instant,
    reasons: item.reasons,
  }));
}

export async function collectHistorical(archive, payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CollectError('采集请求应是 JSON 对象', 400);
  }
  const rawSources = payload.source ?? payload.sources ?? payload.sourceUrl ?? payload.source_url
    ?? payload.provider ?? payload.providerUrl ?? payload.archive ?? payload.archives;
  const sourceList = Array.isArray(rawSources) ? rawSources : [rawSources];
  if (rawSources === undefined || rawSources === null || rawSources === '' || sourceList.length === 0) {
    throw new CollectError('缺少来源地址 source');
  }
  if (sourceList.some(item => item === undefined || item === null || item === '')) {
    throw new CollectError('来源地址列表中有空值');
  }
  const sources = [...new Map(sourceList.map(item => {
    const url = normalizeSource(item);
    return [sourceKey(url), url];
  })).values()];
  const target = parseTarget(requestField(payload, ['datetime', 'target', 'targetDatetime', 'acceptDatetime', 'at', 'date', 'time'], '目标时点 datetime'));
  const requestedOriginal = payload.original ?? payload.originalUri ?? payload.url ?? payload.page ?? null;
  if (requestedOriginal !== null && typeof requestedOriginal !== 'string') {
    throw new CollectError('原网页标识 original 应是字符串', 400);
  }
  if (requestedOriginal !== null && !requestedOriginal.trim()) {
    throw new CollectError('原网页标识 original 不能为空', 400);
  }
  const includeOriginal = payload.includeOriginal !== false;
  const now = typeof options.now === 'function' ? options.now : (() => new Date().toISOString());
  const observedAt = now();

  const contexts = [];
  for (const source of sources) {
    const sourceId = sourceKey(source);
    const timelineUrl = new URL('timeline', sourceDirectory(source));
    const timeline = parseTimeline(await fetchTimeline(timelineUrl), timelineUrl);
    if (requestedOriginal !== null) {
      const requestedUrl = resolveSourceReference(timelineUrl, requestedOriginal);
      if (!sameUrl(requestedUrl, timeline.original)) {
        throw new CollectError(
          `请求的原网页 ${requestedUrl.href} 与来源目录声明的 ${timeline.original.href} 不一致`,
          422,
          { code: 'original_mismatch', requested: requestedUrl.href, declared: timeline.original.href },
        );
      }
    }
    const seen = new Set();
    const entries = timeline.entries.filter(entry => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    });
    const eligible = entries.filter(entry => entry.datetime.milliseconds <= target.milliseconds);
    const warnings = [];
    if (!timeline.complete) {
      warnings.push({
        code: 'directory_incomplete',
        message: `${sourceId} 的时间目录声明 complete=false；即使取得可用版本，也不能据此声称全站历史只有这些版本。`,
      });
    }
    if (eligible.length > MAX_ENTRIES) {
      throw new CollectError(`${sourceId} 的目标时点以前有 ${eligible.length} 条目录条目，超过 ${MAX_ENTRIES} 条核对上限`, 422, {
        code: 'directory_too_many_entries',
      });
    }
    contexts.push({
      source,
      sourceId,
      timelineUrl,
      original: timeline.original,
      entries,
      eligible,
      complete: timeline.complete,
      warnings,
      originalPage: null,
      timeEntry: null,
    });
  }

  const originals = [...new Map(contexts.map(context => [context.original.href, context.original])).values()];
  const [originalPages, timeEntries] = await Promise.all([
    includeOriginal
      ? Promise.all(originals.map(original => fetchOriginalPage(archive, original, now)))
      : Promise.resolve(originals.map(() => null)),
    Promise.all(contexts.map(context => probeTimeEntry(context.source, target, now))),
  ]);
  const originalMap = new Map(originals.map((original, index) => [original.href, originalPages[index]]));
  contexts.forEach((context, index) => {
    context.originalPage = originalMap.get(context.original.href) || null;
    context.timeEntry = timeEntries[index];
    if (context.timeEntry.status === 'answered' && context.timeEntry.afterTarget) {
      context.warnings.push({
        code: 'time_entry_answered_with_later_version',
        message: `${context.sourceId} 的时间入口按目标时点返回了 ${context.timeEntry.declaredDatetime}，晚于目标时点；该正文不保存为历史事实，版本改由时间目录条目选择。`,
        timeEntry: { uri: context.timeEntry.finalUri, declaredDatetime: context.timeEntry.declaredDatetime },
      });
    }
  });

  const warnings = contexts.flatMap(context => context.warnings);

  // Walk the directory instants from the latest one at or before the target
  // backwards. Only the entries that can actually be selected are fetched;
  // earlier instants are listed as considered but not downloaded.
  const instantMap = new Map();
  for (const context of contexts) {
    for (const entry of context.eligible) {
      const key = String(entry.datetime.milliseconds);
      if (!instantMap.has(key)) {
        instantMap.set(key, {
          milliseconds: entry.datetime.milliseconds,
          instant: entry.datetime.iso,
          candidates: [],
        });
      }
      instantMap.get(key).candidates.push({ entry, context });
    }
  }
  const instants = [...instantMap.values()].sort((left, right) => right.milliseconds - left.milliseconds);

  const rejected = [];
  let selected = null;
  for (const instant of instants) {
    const results = await mapLimit(instant.candidates, CONCURRENCY, async candidate => ({
      candidate,
      attempt: await retrieve(candidate.entry, { target, original: candidate.context.original, now }),
    }));
    const items = results.map(result => ({
      source: result.candidate.context.sourceId,
      context: result.candidate.context,
      attempt: result.attempt,
    }));
    const usable = items.filter(item => item.attempt.ok);
    const failed = items.filter(item => !item.attempt.ok);
    if (usable.length === 0) {
      rejected.push({
        instant: instant.instant,
        reasons: failed.map(item => ({
          source: item.source,
          capture: item.attempt.entry.capture,
          code: item.attempt.code,
          message: item.attempt.message,
          ...item.attempt.details,
        })),
      });
      continue;
    }
    selected = { group: { instant: instant.instant, items }, usable, failed };
    break;
  }

  if (selected) {
    const { group, usable, failed } = selected;
    if (rejected.length) {
      warnings.push({
        code: 'fell_back_to_earlier_version',
        message: '较近的目录时点没有可用版本（取回失败或正文声明晚于目标），已退回到更早且仍不晚于目标时点的版本。',
        rejectedInstants: rejected.map(item => item.instant),
      });
    }
    // Only strictly earlier instants are "considered but not selected"; the
    // later instants that had no usable body are already in `rejected`.
    const considered = instants
      .filter(instant => instant.milliseconds < Date.parse(group.instant))
      .flatMap(instant => instant.candidates.map(candidate => ({
        source: candidate.context.sourceId,
        capture: candidate.entry.capture,
        directoryDatetime: candidate.entry.datetime.iso,
        selected: false,
        reason: 'not_the_latest_directory_instant_at_or_before_target',
      })));
    if (considered.length) {
      warnings.push({
        code: 'earlier_entries_not_selected',
        message: '更早的目录时点也存在，但业务只取不晚于目标的最近时刻，故未选入证据，也未取回这些更早正文。',
        considered: considered.map(item => `${item.source}@${item.capture}@${item.directoryDatetime}`),
      });
    }

    // A directory entry may point at a redirect that re-negotiates the time,
    // or at a representation whose own declaration is later than the day
    // under review. Those bodies were rejected above; the gap at this instant
    // is reported separately from an actual content divergence.
    const parallelUnavailable = failed.length > 0;
    if (parallelUnavailable) {
      warnings.push({
        code: 'parallel_evidence_unavailable',
        message: `与选中时刻相同的 ${failed.length} 条目录条目没有可用正文；无法确认该时刻的并列证据是否齐全。`,
        captures: failed.map(item => `${item.source}@${item.attempt.entry.capture}`),
      });
    }
    for (const item of usable) warnings.push(...item.attempt.warnings);

    const distinctContents = new Map();
    for (const item of usable) {
      if (!distinctContents.has(item.attempt.contentSha256)) distinctContents.set(item.attempt.contentSha256, []);
      distinctContents.get(item.attempt.contentSha256).push(`${item.source}@${item.attempt.entry.capture}`);
    }
    const divergent = distinctContents.size > 1;
    if (divergent) {
      warnings.push({
        code: 'same_instant_different_content',
        message: '同一归档时刻存在不同正文，已并列保存，未任选其一。',
        contents: [...distinctContents.entries()].map(([sha256, from]) => ({ sha256, from })),
      });
    }

    const evidence = [];
    let lastObservedAt = observedAt;
    for (const item of usable) {
      const stored = await saveEvidence(archive, item.context, target, item.attempt, group, warnings, divergent);
      evidence.push({
        receipt: stored.receipt,
        version: stored.version,
        duplicate: stored.duplicate,
        sha256: stored.sha256,
        contentSha256: item.attempt.contentSha256,
        source: item.source,
        capture: item.attempt.entry.capture,
        representationUri: item.attempt.finalUrl.href,
        directoryDatetime: item.attempt.entry.datetime.iso,
        declaredDatetime: item.attempt.declared.iso,
        observedAt: item.attempt.observedAt,
        observations: stored.observations,
        divergent,
      });
      lastObservedAt = item.attempt.observedAt;
    }

    const outcome = divergent ? 'divergent' : 'collected';
    const code = divergent ? 'same_instant_divergence' : 'collected';
    const summary = { outcome, code, selected: evidence.map(snapshot) };
    const journal = await archive.appendResolution(scopeFor(contexts, requestedOriginal, target), latest => ({
      observedAt: lastObservedAt,
      target: { text: target.text, iso: target.iso, date: target.date },
      outcome,
      code,
      selected: summary.selected,
      considered,
      rejected: rejectedSummary([...rejected]),
      directory: directorySummary(contexts),
      timeEntries: contexts.map(context => context.timeEntry),
      originalPages: contexts.map(context => context.originalPage),
      warnings,
      comparison: compareChecks(latest, summary, target),
    }));

    return {
      statusCode: divergent ? 409 : 201,
      body: {
        outcome,
        code,
        target: { text: target.text, iso: target.iso, date: target.date },
        sources: contexts.map(context => ({
          id: context.sourceId,
          url: context.source.href,
          original: context.original.href,
          directory: {
            uri: context.timelineUrl.href,
            complete: context.complete,
            entries: context.entries.length,
            eligibleEntries: context.eligible.length,
          },
        })),
        originalPages: contexts.map(context => context.originalPage),
        timeEntries: contexts.map(context => context.timeEntry),
        selectedInstant: group.instant,
        evidence,
        considered,
        rejected: rejectedSummary([...rejected]),
        warnings,
        observedAt: lastObservedAt,
        duplicate: evidence.every(item => item.duplicate),
        parallelUnavailable,
        resolution: { checkCount: journal.count, ...journal.check.comparison },
        note: LIVE_PAGE_NOTE,
        ...(divergent ? { error: '同一归档时刻存在不同来源的不同正文，已并列保存，未任选其一' } : {}),
        ...(parallelUnavailable ? { notice: '同一归档时刻有并列目录条目没有可用正文，已在 warnings 中单独标明，未当作同一内容' } : {}),
      },
    };
  }

  const noneEligible = contexts.every(context => context.eligible.length === 0);
  const incomplete = contexts.some(context => !context.complete);
  const onlyAfterTarget = rejected.length > 0
    && rejected.every(item => item.reasons.every(reason => reason.code === 'representation_after_target'));
  const code = noneEligible
    ? (incomplete ? 'directory_incomplete' : 'no_version_at_or_before_target')
    : onlyAfterTarget
      ? 'representation_after_target'
      : 'no_retrievable_version';
  const message = {
    directory_incomplete: '至少一个来源的时间目录不完整，无法确认目标时点及以前是否存在版本；不会改用当前网页。',
    no_version_at_or_before_target: '时间目录完整地表明目标时点及以前没有版本；不会改用当前网页。',
    representation_after_target: '时间目录中的候选版本取回后声明的时间晚于目标时点，未保存为历史事实。',
    no_retrievable_version: '目标时点以前虽有目录条目，但没有任何版本能按它自己的时间声明取回；未用当前网页顶替。',
  }[code];
  const statusCode = {
    no_version_at_or_before_target: 404,
    representation_after_target: 409,
    directory_incomplete: 422,
    no_retrievable_version: 502,
  }[code];
  const summary = { outcome: 'unavailable', code, selected: [] };
  const journal = await archive.appendResolution(scopeFor(contexts, requestedOriginal, target), latest => ({
    observedAt,
    target: { text: target.text, iso: target.iso, date: target.date },
    outcome: 'unavailable',
    code,
    selected: [],
    rejected: rejectedSummary(rejected),
    directory: directorySummary(contexts),
    timeEntries: contexts.map(context => context.timeEntry),
    originalPages: contexts.map(context => context.originalPage),
    warnings,
    comparison: compareChecks(latest, summary, target),
  }));

  return {
    statusCode,
    body: {
      outcome: 'unavailable',
      code,
      error: message,
      target: { text: target.text, iso: target.iso, date: target.date },
      sources: contexts.map(context => ({
        id: context.sourceId,
        url: context.source.href,
        original: context.original.href,
        directory: {
          uri: context.timelineUrl.href,
          complete: context.complete,
          entries: context.entries.length,
          eligibleEntries: context.eligible.length,
        },
      })),
      originalPages: contexts.map(context => context.originalPage),
      timeEntries: contexts.map(context => context.timeEntry),
      evidence: [],
      rejected: rejectedSummary(rejected),
      warnings,
      observedAt,
      resolution: { checkCount: journal.count, ...journal.check.comparison },
      note: LIVE_PAGE_NOTE,
    },
  };
}

export { CollectError, SourceError };
