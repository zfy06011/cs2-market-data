import https from 'node:https';
import fs from 'node:fs';
import { createCipheriv, createHash } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'zfy06011/cs2-market-data';
export const TARGET = Object.freeze({ id: '4578', hash: 'Revolution Case', days: 360 });
export const HISTORY_KEYS = Object.freeze(['buff', 'uuyp', 'c5', 'igxe', 'eco', 'steam'].flatMap(p => [p + 'SellPrice', p + 'SellNum']));
const ORIGIN = 'https://smis.club';
const MAX_REQUESTS = 4;
class ProbeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const stop = code => { throw new ProbeFailure(code); };

// Adapted from the existing desktop SMIS public-client reader. Config values
// remain in memory; reports never contain response bodies, headers or keys.
export function bootstrapConfig(html, bundle = null) {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)]
    .map(match => { try { return new URL(match[1], ORIGIN); } catch { return null; } })
    .filter(url => url?.origin === ORIGIN && /^\/assets\/index-[\w-]+\.js$/.test(url.pathname) && !url.search && !url.hash);
  if (scripts.length !== 1) stop('public_client_changed');
  if (bundle === null) return { bundleUrl: scripts[0].href };
  const pair = /([\w$]+)=([\w$]+)\.enc\.Utf8\.parse\("([^"\\]+)"\),([\w$]+)=\2\.enc\.Utf8\.parse\("([^"\\]+)"\);function[\s\S]{0,240}?\.AES\.encrypt/.exec(bundle);
  const tenant = /\.headers\.Auth2\s*=\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(bundle);
  if (!pair || !tenant || Buffer.byteLength(pair[3]) !== 16 || Buffer.byteLength(pair[5]) !== 16 || !bundle.includes('/commodity/suggest') || !bundle.includes('/commodity/exchange')) stop('public_client_changed');
  return { key: Buffer.from(pair[3]), iv: Buffer.from(pair[5]), tenant: tenant[1] };
}
function envelope(text) {
  let value;
  try {
    value = JSON.parse(text, (key, data, context) => typeof data === 'number' && (key === 'id' || /^\d+$/.test(key)) ? context.source : data);
  } catch { stop('response_schema'); }
  if (!value || ![0, 200].includes(value.code)) stop('source_rejected');
  return value.data;
}
function validPrice(value) {
  if (typeof value !== 'string' || value.length > 80) return false;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match) return false;
  const shift = 2 + Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (Math.abs(shift) > 100) return false;
  let cents = BigInt(match[1] + (match[2] ?? ''));
  if (shift >= 0) cents *= 10n ** BigInt(shift);
  else { const divisor = 10n ** BigInt(-shift); if (cents % divisor) return false; cents /= divisor; }
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER);
}
export function historySummary(text, now = Date.now()) {
  const data = envelope(text), samples = data?.[0]?.length;
  if (!Array.isArray(data) || data.length !== 13 || !Number.isInteger(samples) || samples < 2 || samples > 10000 || data.some(column => !Array.isArray(column) || column.length !== samples)) stop('history_schema');
  const timestamps = data[0].map(value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
  if (timestamps.some(time => !Number.isSafeInteger(time) || time < Date.UTC(2000, 0, 1) || time > now + 60000) || new Set(timestamps).size !== samples) stop('history_time_invalid');
  let steamPricePoints = 0;
  for (let i = 0; i < samples; i++) {
    const value = data[12][i], count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (Number.isSafeInteger(count) && count > 0 && validPrice(data[11][i])) steamPricePoints++;
  }
  if (!steamPricePoints) stop('steam_history_empty');
  timestamps.sort((a, b) => a - b);
  const intervals = timestamps.slice(1).map((time, i) => time - timestamps[i]).sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const median = intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2;
  return { samples, steamPricePoints, from: new Date(timestamps[0]).toISOString(), to: new Date(timestamps.at(-1)).toISOString(), medianIntervalHours: median / 3600000 };
}
export function cloudContext(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')) stop('github_hosted_run_required');
  return { repository: REPOSITORY, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runner: 'github-hosted/Linux', event: env.GITHUB_EVENT_NAME };
}
export function transport(url, { body = null, headers = {} } = {}) {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.search || parsed.hash || !(/^\/assets\/index-[\w-]+\.js$/.test(parsed.pathname) || ['/exchange', '/api/commodity/4578', '/api/commodity/history/line'].includes(parsed.pathname))) stop('endpoint_not_allowed');
  return new Promise((resolve, reject) => {
    const request = https.request(parsed, { method: body === null ? 'GET' : 'POST', headers: {
      'User-Agent': 'cs2-market-data-cloud-probe/0.1 (+https://github.com/' + REPOSITORY + ')', Accept: 'application/json,text/html', 'Accept-Encoding': 'gzip, br, zstd, deflate',
      ...(body === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }), ...headers
    } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 3000000) request.destroy(new ProbeFailure('response_too_large')); else chunks.push(chunk); });
      response.on('aborted', () => reject(new ProbeFailure('network')));
      response.on('error', () => reject(new ProbeFailure('network')));
      response.on('end', () => {
        try {
          const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync, zstd: zstdDecompressSync }, encoding = response.headers['content-encoding'];
          let bytes = Buffer.concat(chunks);
          if (encoding && encoding !== 'identity') { if (!decoders[encoding]) stop('decode'); bytes = decoders[encoding](bytes, { maxOutputLength: 6000000 }); }
          resolve({ status: response.statusCode, text: bytes.toString('utf8') });
        } catch { reject(new ProbeFailure('decode')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new ProbeFailure('timeout')), 20000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', error => reject(error instanceof ProbeFailure ? error : new ProbeFailure(['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ? 'dns' : 'network')));
    if (body !== null) request.write(body);
    request.end();
  });
}
export async function probe({ send = transport, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), context = {} } = {}) {
  const started = clock(), phases = []; let attempts = 0, last = null, activePhase = 'public_page';
  const report = { schemaVersion: 1, evidenceType: 'smis_cloud_readonly_probe', context, target: TARGET, status: 'failed', phases, rawDataRetained: false, trainingPerformed: false };
  const request = async (name, url, options) => {
    activePhase = name;
    if (attempts >= MAX_REQUESTS || clock() - started > 100000) stop('probe_limit');
    if (last !== null) { const wait = 3000 - (clock() - last); if (wait > 0) await sleep(wait); }
    last = clock(); attempts++;
    const phase = { name, status: 'failed', httpStatus: null }; phases.push(phase);
    const response = await send(url, options); phase.httpStatus = response.status;
    if (response.status === 429) stop('rate_limited');
    if ([401, 403].includes(response.status)) stop('access_denied');
    if (response.status >= 300 && response.status < 400) stop('redirect_not_followed');
    if (response.status !== 200) stop('http_error');
    phase.status = 'received';return response.text;
  };
  try {
    const html = await request('public_page', ORIGIN + '/exchange');
    const { bundleUrl } = bootstrapConfig(html); phases.at(-1).status = 'passed';
    const bundle = await request('public_bundle', bundleUrl);
    const config = bootstrapConfig(html, bundle); report.publicBundleSha256 = createHash('sha256').update(bundle).digest('hex'); phases.at(-1).status = 'passed';
    const headers = () => {
      const cipher = createCipheriv('aes-128-cbc', config.key, config.iv);
      return { Auth: Buffer.concat([cipher.update(String(clock()), 'utf8'), cipher.final()]).toString('base64'), Auth2: config.tenant, Origin: ORIGIN, Referer: ORIGIN + '/exchange' };
    };
    const identity = envelope(await request('identity', ORIGIN + '/api/commodity/' + TARGET.id, { headers: headers() }));
    if (!identity || identity.hashName !== TARGET.hash || String(identity.appid) !== '730' || String(identity.id) !== TARGET.id) stop('identity_mismatch');
    phases.at(-1).status = 'passed';
    const history = await request('history', ORIGIN + '/api/commodity/history/line', { headers: headers(), body: JSON.stringify({ commodityId: Number(TARGET.id), days: TARGET.days, keys: HISTORY_KEYS }) });
    report.history = historySummary(history, clock()); phases.at(-1).status = 'passed'; report.status = 'passed';
  } catch (error) { report.failure = error instanceof ProbeFailure ? error.code : 'internal_error'; report.failedPhase = activePhase; }
  report.requests = attempts; report.elapsedMs = clock() - started;
  return report;
}
export function markdown(report) {
  return ['## SMIS GitHub-hosted probe', '', `Result: **${report.status}**`, `Source commit: \`${report.context.commit ?? 'unknown'}\``, '',
    ...report.phases.map(phase => `- ${phase.name}: ${phase.status}; HTTP ${phase.httpStatus ?? 'not received'}`),
    ...(report.history ? [`- History samples: ${report.history.samples}; valid Steam price points: ${report.history.steamPricePoints}`, `- Coverage: ${report.history.from} — ${report.history.to}`, `- Median interval: ${report.history.medianIntervalHours} hours`] : []),
    ...(report.failure ? [`- Failure: \`${report.failure}\`; phase: ${report.failedPhase}`] : []),
    '', 'One known item only. No raw market records retained. Does not validate all-item coverage, redistribution permission, training or execution prices.', ''].join('\n');
}
async function main() {
  let report;
  try { const context = cloudContext(process.env); report = await probe({ context }); }
  catch { report = { status: 'failed', failure: 'github_hosted_run_required', failedPhase: 'environment', phases: [], context: {}, requests: 0 }; }
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY && process.env.GITHUB_ACTIONS === 'true') fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(report));
  if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('probe_internal_error'); process.exitCode = 1; });
