// Version 2: bounded, checkpointed public history, three markets, no accounts.
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { bootstrapConfig, HISTORY_KEYS } from './probe-smis-cloud.mjs';
import { normalizeHistory, transport, envelope, cents } from './collect-training-history.mjs';

const ORIGIN = 'https://smis.club', DAY = 86400000;
const sha = s => createHash('sha256').update(s).digest('hex');
const fail = code => { const e = new Error(code); e.code = code; throw e; };

export function validateExperiment(config) {
  if (config?.schemaVersion !== 2 || !Array.isArray(config.items) || config.items.length > 400 ||
      !Number.isFinite(Date.parse(config.asOfUtc)) || config.intervalMs < 3000 ||
      !Number.isInteger(config.maxRequests) || config.maxRequests > 1000 ||
      Object.values(config.targets ?? {}).reduce((a, b) => a + b, 0) !== 200) fail('experiment_invalid');
  const ids = new Set(), names = new Set(), excluded = new Set(config.testExcludedPriorNames);
  for (const item of config.items) {
    if (!/^[1-9]\d{0,14}$/.test(item.id) || !Number.isSafeInteger(Number(item.id)) ||
        typeof item.hash !== 'string' || !item.hash.trim() || item.hash.length > 200 ||
        /[\x00-\x1f\x7f]/.test(item.hash) || !/^[a-z_]{1,30}$/.test(item.category) ||
        !['train', 'validation', 'test'].includes(item.role) ||
        ids.has(item.id) || names.has(item.hash) || (item.role === 'test' && excluded.has(item.hash))) fail('cohort_invalid');
    ids.add(item.id); names.add(item.hash);
  }
}

export function threeMarketHistory(text, item, collectedAt, days, asOfUtc) {
  if (![90, 360].includes(days)) fail('history_window_invalid');
  const result = normalizeHistory(text, item, collectedAt), data = envelope(text);
  const additional = new Map(data[0].map((time, i) => {
    const row = {};
    for (const [market, col] of [['uuyp', 3], ['c5', 5]]) {
      const value = data[col + 1][i], count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
      row[market + 'OnSaleCount'] = Number.isSafeInteger(count) && count >= 0 ? count : null;
      row[market + 'PriceCents'] = row[market + 'OnSaleCount'] > 0 ? cents(data[col][i]) : null;
    }
    return [new Date(Number(time)).toISOString(), row];
  }));
  result.observations = result.observations.map(row => ({ ...row, ...additional.get(row.observedAt) }));
  result.schemaVersion = 2;
  result.evidenceType = 'smis_three_market_history';
  result.sourceRequestDays = days;
  result.asOfUtc = asOfUtc;
  const cutoff = Date.parse(asOfUtc), valid = { steam: new Set(), c5: new Set(), uuyp: new Set(), buy: new Set() };
  for (const row of result.observations) {
    const t = Date.parse(row.observedAt);
    if (t < cutoff - 365 * DAY || t >= cutoff) continue;
    const day = row.observedAt.slice(0, 10);
    if (row.priceCents !== null) valid.steam.add(day);
    if (row.c5PriceCents !== null) valid.c5.add(day);
    if (row.uuypPriceCents !== null) valid.uuyp.add(day);
    if (row.c5PriceCents !== null || row.uuypPriceCents !== null) valid.buy.add(day);
  }
  result.validCompletedDaysByMarket = Object.fromEntries(Object.entries(valid).map(([k, v]) => [k, v.size]));
  return result;
}

export async function collectDual(config, out, { send = transport, clock = Date.now,
  sleep = ms => new Promise(r => setTimeout(r, ms)), progress = () => {} } = {}) {
  validateExperiment(config);
  const file = path.join(out, 'collection.json'), configSha = sha(JSON.stringify(config));
  const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
    schemaVersion: 2, experiment: config.experiment, configSha256: configSha, asOfUtc: config.asOfUtc,
    startedAt: new Date(clock()).toISOString(), requests: 0, accepted: [], skipped: [], nextIndex: 0,
    pending: null, lastRequestAt: null, status: 'running', accountUsed: false, rawResponsesRetained: false };
  if (report.configSha256 !== configSha) fail('frozen_configuration_changed');
  if (report.status === 'passed') return report;
  if (report.cooldownUntil && Date.parse(report.cooldownUntil) > clock()) fail('source_cooldown');
  fs.mkdirSync(path.join(out, 'daily'), { recursive: true });
  fs.mkdirSync(path.join(out, 'fine'), { recursive: true });
  const persist = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(report, null, 2) + '\n'); fs.renameSync(file + '.tmp', file); };
  const counts = () => Object.fromEntries(Object.keys(config.targets).map(role => [role, report.accepted.filter(e => e.item.role === role).length]));
  const write = (kind, snap) => {
    const bytes = JSON.stringify(snap) + '\n', target = path.join(out, kind, snap.item.id + '.json');
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    return sha(bytes);
  };
  const started = clock();
  async function request(url, options) {
    if (report.requests >= config.maxRequests || clock() - started > 3000000) fail('collection_limit');
    if (report.lastRequestAt !== null) {
      const wait = config.intervalMs - (clock() - report.lastRequestAt);
      if (wait > 0) await sleep(wait);
    }
    report.lastRequestAt = clock(); report.requests++; persist();
    let response;
    try { response = await send(url, options); } catch { fail('network'); }
    if (response.status === 429) {
      report.cooldownUntil = new Date(clock() + 3600000).toISOString(); fail('rate_limited');
    }
    if ([401, 403].includes(response.status)) fail('access_denied');
    if (response.status >= 300 && response.status < 400) fail('redirect_not_followed');
    if (response.status !== 200) fail('http_error');
    return response.text;
  }
  try {
    report.status = 'running'; delete report.failure; persist();
    const html = await request(ORIGIN + '/exchange'), { bundleUrl } = bootstrapConfig(html);
    const bundle = await request(bundleUrl), auth = bootstrapConfig(html, bundle);
    report.publicBundleSha256 = sha(bundle);
    const headers = () => {
      const cipher = createCipheriv('aes-128-cbc', auth.key, auth.iv);
      return { Auth: Buffer.concat([cipher.update(String(clock()), 'utf8'), cipher.final()]).toString('base64'),
        Auth2: auth.tenant, Origin: ORIGIN, Referer: ORIGIN + '/exchange' };
    };
    const readHistory = async (item, days) => {
      const text = await request(ORIGIN + '/api/commodity/history/line', { headers: headers(),
        body: JSON.stringify({ commodityId: Number(item.id), days, keys: HISTORY_KEYS }) });
      const snap = threeMarketHistory(text, item, new Date(clock()).toISOString(), days, config.asOfUtc);
      snap.publicBundleSha256 = report.publicBundleSha256;
      return snap;
    };
    const finishPending = async () => {
      const pending = report.pending, item = pending.item;
      if (sha(fs.readFileSync(path.join(out, 'daily', item.id + '.json'))) !== pending.dailySha256) fail('snapshot_changed');
      let fine;
      try { fine = await readHistory(item, 90); }
      catch (error) {
        if (!['history_schema', 'history_time_invalid', 'response_schema'].includes(error.code)) throw error;
        report.skipped.push({ item, reason: 'invalid_fine_' + error.code, dailySha256: pending.dailySha256 });
        report.pending = null; persist();
        progress({ id: item.id, role: item.role, status: 'invalid_fine_history', reason: error.code });
        return;
      }
      const fineSha256 = write('fine', fine);
      report.accepted.push({ ...pending, fineSha256, finePoints: fine.observations.length });
      report.pending = null; persist();
      progress({ accepted: report.accepted.length, counts: counts(), role: item.role, id: item.id,
        days: pending.validDays, uuypDays: pending.coverage.uuyp, requests: report.requests });
      if (report.accepted.length === 10 && !report.accepted.some(e => e.coverage.uuyp > 0)) fail('uuyp_history_unavailable');
    };
    if (report.pending) await finishPending();
    for (; report.nextIndex < config.items.length;) {
      const item = config.items[report.nextIndex++];
      if (counts()[item.role] >= config.targets[item.role]) { persist(); continue; }
      try {
        const identity = envelope(await request(ORIGIN + '/api/commodity/' + item.id, { headers: headers() }));
        if (identity?.hashName !== item.hash || String(identity.id) !== item.id || String(identity.appid) !== '730') fail('identity_mismatch');
        const daily = await readHistory(item, 360), c = daily.validCompletedDaysByMarket;
        if (c.steam < config.minimumValidDays || c.buy < config.minimumValidDays) {
          report.skipped.push({ item, reason: 'insufficient_history', coverage: c }); persist(); continue;
        }
        const dailySha256 = write('daily', daily);
        report.pending = { item, dailySha256, validDays: c.steam, coverage: c };
        persist(); await finishPending();
      } catch (error) {
        if (report.pending || !['identity_mismatch', 'history_schema', 'history_time_invalid', 'response_schema', 'source_rejected'].includes(error.code)) throw error;
        report.skipped.push({ item, reason: error.code }); persist();
      }
      if (Object.entries(config.targets).every(([r, n]) => counts()[r] >= n)) break;
    }
    report.counts = counts();
    report.status = Object.entries(config.targets).every(([r, n]) => report.counts[r] >= n) ? 'passed' : 'insufficient_items';
  } catch (error) {
    report.status = 'failed';
    report.failure = ['rate_limited', 'access_denied', 'redirect_not_followed', 'http_error', 'network',
      'collection_limit', 'public_client_changed', 'snapshot_changed', 'uuyp_history_unavailable',
      'history_schema', 'history_time_invalid', 'response_schema', 'source_rejected'].includes(error.code) ? error.code : 'collection_failed';
  }
  report.updatedAt = new Date(clock()).toISOString();
  report.counts = counts(); persist();
  return report;
}

async function main() {
  const [live, configPath, outArg] = process.argv.slice(2);
  if (live !== '--live' || !configPath || !outArg) fail('arguments');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')), out = path.resolve(outArg), local = path.resolve('.local');
  if (!out.startsWith(local + path.sep)) fail('local_only');
  const report = await collectDual(config, out, { progress: x => console.log(JSON.stringify(x)) });
  console.log(JSON.stringify({ status: report.status, counts: report.counts, requests: report.requests, failure: report.failure ?? null }));
  if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('dual_collection_failed_check_local_state'); process.exitCode = 1; });
