// Read-only, bounded historical collection. Public client config stays in memory.
// Adapted from the existing desktop SMIS reader at a5a6779; no account is used.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createHash } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { bootstrapConfig, HISTORY_KEYS } from './probe-smis-cloud.mjs';

const ORIGIN = 'https://smis.club';
export const TARGET_ITEMS = 20;
export const MIN_DAYS = 180;
export const SOURCE_DAYS = 360;
const DAY = 86400000;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const identifier = id => typeof id === 'string' && /^[1-9]\d{0,14}$/.test(id) && Number.isSafeInteger(Number(id));
const hash = text => createHash('sha256').update(text).digest('hex');

export function validateCohort(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.items) || value.items.length < TARGET_ITEMS || value.items.length > 40) fail('cohort_invalid');
  const ids = new Set(), names = new Set();
  for (const item of value.items) {
    if (!identifier(item.id) || typeof item.hash !== 'string' || !item.hash.trim() || item.hash.length > 200 ||
        /[\x00-\x1f\x7f]/.test(item.hash) || !/^[a-z_]{1,30}$/.test(item.category ?? '') ||
        ids.has(item.id) || names.has(item.hash)) fail('cohort_invalid');
    ids.add(item.id); names.add(item.hash);
  }
  return value.items;
}

export function envelope(text) {
  let value;
  try { value = JSON.parse(text, (key, data, context) => typeof data === 'number' && (key === 'id' || /^\d+$/.test(key)) ? context.source : data); }
  catch { fail('response_schema'); }
  if (!value || ![0, 200].includes(value.code)) fail('source_rejected');
  return value.data;
}

export function cents(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!m) return null;
  const shift = 2 + Number(m[3] ?? 0) - (m[2]?.length ?? 0);
  if (Math.abs(shift) > 100) return null;
  let n = BigInt(m[1] + (m[2] ?? ''));
  if (shift >= 0) n *= 10n ** BigInt(shift);
  else { const d = 10n ** BigInt(-shift); if (n % d) return null; n /= d; }
  return n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}

export function normalizeHistory(text, item, collectedAt) {
  const data = envelope(text), size = data?.[0]?.length, now = Date.parse(collectedAt);
  if (!Number.isFinite(now) || !Array.isArray(data) || data.length !== 13 || !Number.isInteger(size) ||
      size < 2 || size > 10000 || data.some(c => !Array.isArray(c) || c.length !== size)) fail('history_schema');
  const seen = new Set();
  const observations = data[0].map((value, i) => {
    const time = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(time) || time < Date.UTC(2000, 0, 1) || time > now + 60000 || seen.has(time)) fail('history_time_invalid');
    seen.add(time);
    const countText = data[12][i], countValue = typeof countText === 'string' && /^\d+$/.test(countText) ? Number(countText) : NaN;
    const count = Number.isSafeInteger(countValue) && countValue >= 0 ? countValue : null;
    return { observedAt: new Date(time).toISOString(), priceCents: count > 0 ? cents(data[11][i]) : null, onSaleCount: count };
  }).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const endDay = Math.floor(now / DAY), validDays = new Set(observations.filter(r =>
    r.priceCents !== null && Math.floor(Date.parse(r.observedAt) / DAY) < endDay &&
    Math.floor(Date.parse(r.observedAt) / DAY) >= endDay - 365).map(r => r.observedAt.slice(0, 10)));
  return { schemaVersion: 1, evidenceType: 'smis_training_history', source: 'smis', item,
    collectedAt, requestedWindowDays: 365, sourceRequestDays: SOURCE_DAYS, currency: 'CNY',
    currencyEvidence: 'supplier_display_convention_not_independently_verified',
    priceBasis: 'steam_aggregate_lowest_listing', countBasis: 'total_on_sale_not_completed_sales',
    validCompletedDays: validDays.size, observations };
}

export function transport(url, { body = null, headers = {} } = {}) {
  const u = new URL(url);
  if (u.origin !== ORIGIN || u.username || u.password || u.search || u.hash ||
      !(/^\/assets\/index-[\w-]+\.js$/.test(u.pathname) || /^\/api\/commodity\/[1-9]\d{0,14}$/.test(u.pathname) ||
        ['/exchange', '/api/commodity/history/line'].includes(u.pathname))) fail('endpoint_not_allowed');
  return new Promise((resolve, reject) => {
    const req = https.request(u, { method: body === null ? 'GET' : 'POST', headers: {
      'User-Agent': 'cs2-market-data-training/0.1 (+https://github.com/zfy06011/cs2-market-data)',
      Accept: 'application/json,text/html', 'Accept-Encoding': 'gzip, br, zstd, deflate',
      ...(body === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }), ...headers
    } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 3000000) req.destroy(new Error('response_too_large')); else chunks.push(chunk); });
      response.on('aborted', () => reject(new Error('network')));
      response.on('error', () => reject(new Error('network')));
      response.on('end', () => {
        try {
          let bytes = Buffer.concat(chunks);
          const encoding = response.headers['content-encoding'];
          const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync, zstd: zstdDecompressSync };
          if (encoding && encoding !== 'identity') {
            if (!decoders[encoding]) throw Error();
            bytes = decoders[encoding](bytes, { maxOutputLength: 6000000 });
          }
          resolve({ status: response.statusCode, text: bytes.toString('utf8') });
        } catch { reject(new Error('decode')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), 20000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(new Error('network')));
    if (body !== null) req.write(body);
    req.end();
  });
}

export async function collect({ cohort, send = transport, clock = Date.now,
  sleep = ms => new Promise(r => setTimeout(r, ms)), save = () => {}, progress = () => {} }) {
  const items = validateCohort(cohort), started = clock(), snapshots = [];
  const report = { schemaVersion: 1, status: 'failed', source: 'smis', requestedWindowDays: 365,
    sourceRequestDays: SOURCE_DAYS, minimumValidDays: MIN_DAYS, targetItems: TARGET_ITEMS,
    cohortSha256: hash(JSON.stringify(cohort)), startedAt: new Date(started).toISOString(),
    requests: 0, skipped: [], accepted: [], accountUsed: false, rawResponsesRetained: false };
  let last = null;
  async function request(url, options) {
    if (report.requests >= 82 || clock() - started > 1200000) fail('collection_limit');
    if (last !== null) { const wait = 3000 - (clock() - last); if (wait > 0) await sleep(wait); }
    last = clock(); report.requests++;
    let response;
    try { response = await send(url, options); } catch { fail('network'); }
    if (response.status === 429) fail('rate_limited');
    if ([401, 403].includes(response.status)) fail('access_denied');
    if (response.status >= 300 && response.status < 400) fail('redirect_not_followed');
    if (response.status !== 200) fail('http_error');
    return response.text;
  }
  try {
    const html = await request(ORIGIN + '/exchange'), { bundleUrl } = bootstrapConfig(html);
    const bundle = await request(bundleUrl), config = bootstrapConfig(html, bundle);
    report.publicBundleSha256 = hash(bundle);
    const headers = () => {
      const cipher = createCipheriv('aes-128-cbc', config.key, config.iv);
      return { Auth: Buffer.concat([cipher.update(String(clock()), 'utf8'), cipher.final()]).toString('base64'),
        Auth2: config.tenant, Origin: ORIGIN, Referer: ORIGIN + '/exchange' };
    };
    for (const item of items) {
      try {
        const detail = envelope(await request(ORIGIN + '/api/commodity/' + item.id, { headers: headers() }));
        if (detail?.hashName !== item.hash || String(detail?.id) !== item.id || String(detail?.appid) !== '730') fail('identity_mismatch');
        const text = await request(ORIGIN + '/api/commodity/history/line', { headers: headers(),
          body: JSON.stringify({ commodityId: Number(item.id), days: SOURCE_DAYS, keys: HISTORY_KEYS }) });
        const snapshot = normalizeHistory(text, item, new Date(clock()).toISOString());
        snapshot.publicBundleSha256 = report.publicBundleSha256;
        if (snapshot.validCompletedDays < MIN_DAYS) {
          report.skipped.push({ item, reason: 'insufficient_history', validDays: snapshot.validCompletedDays });
          progress({ id: item.id, status: 'insufficient_history', accepted: snapshots.length });
          continue;
        }
        await save(snapshot); snapshots.push(snapshot);
        report.accepted.push({ item, validDays: snapshot.validCompletedDays, snapshotSha256: hash(JSON.stringify(snapshot) + '\n') });
        progress({ id: item.id, status: 'accepted', accepted: snapshots.length });
        if (snapshots.length >= TARGET_ITEMS) break;
      } catch (error) {
        const code = ['identity_mismatch', 'history_schema', 'history_time_invalid', 'source_rejected', 'response_schema'].includes(error.code) ? error.code : null;
        if (!code) throw error;
        report.skipped.push({ item, reason: code });
        progress({ id: item.id, status: code, accepted: snapshots.length });
      }
    }
    report.status = snapshots.length >= TARGET_ITEMS ? 'passed' : 'insufficient_items';
  } catch (error) {
    report.failure = ['rate_limited', 'access_denied', 'redirect_not_followed', 'http_error', 'collection_limit', 'network',
      'public_client_changed'].includes(error.code) ? error.code : 'collection_failed';
  }
  report.completedAt = new Date(clock()).toISOString(); report.elapsedMs = clock() - started;
  return { report, snapshots };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--live') fail('usage_live_cohort_output');
  const cohort = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'));
  validateCohort(cohort);
  const root = path.resolve('.local'), out = path.resolve(args[2]);
  if (!out.startsWith(root + path.sep) || fs.existsSync(out)) fail('output_must_be_new_local_directory');
  fs.mkdirSync(path.join(out, 'histories'), { recursive: true });
  const { report } = await collect({ cohort,
    save: snapshot => fs.writeFileSync(path.join(out, 'histories', snapshot.item.id + '.json'), JSON.stringify(snapshot) + '\n', { flag: 'wx' }),
    progress: value => console.log(JSON.stringify(value)) });
  fs.writeFileSync(path.join(out, 'collection.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, accepted: report.accepted.length, requests: report.requests,
    failure: report.failure ?? null, output: out }));
  if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('collection_failed_check_arguments_or_local_files'); process.exitCode = 1; });
}
