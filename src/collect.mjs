import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client, SafeError, fail } from './core.mjs';
import { GitHubArchive, REPOSITORY } from './archive.mjs';
import { HOME, sourceGate, parsePopular, selectPool, validatePool, c5Quotes, steamQuote, estimate, digest } from './market.mjs';

const json = data => JSON.stringify(data, null, 2) + '\n';
const datePath = iso => iso.slice(0, 10).replaceAll('-', '/');
const safeCode = e => e instanceof SafeError ? e.code : 'internal_error';
export function validateConfig(config) {
  if (config?.schemaVersion !== 1 || config.repository !== REPOSITORY || config.monthlyBudgetCny !== 10 ||
      config.selection?.cases !== 10 || config.selection?.capsules !== 5 || config.selection?.freezeMonths !== 6 ||
      !config.sources?.steam || !config.sources?.c5 || typeof config.schedule?.enabled !== 'boolean') fail('config_invalid');
  return config;
}
export function validateState(state) {
  if (!state || !state.cooldowns || !state.lastRequests) fail('state_invalid');
  for (const obj of [state.cooldowns, state.lastRequests]) {
    if (Object.keys(obj).some(x => !['c5', 'steam'].includes(x))) fail('state_invalid');
    if (Object.values(obj).some(n => !Number.isSafeInteger(n) || n < 0 || n > 8640000000000000)) fail('state_invalid');
  }
  return { cooldowns: state.cooldowns, lastRequests: state.lastRequests };
}
export async function collect({ archive, config, batchId, sourceCommit, c5Key = null, clock = Date.now,
  send, secrets = [], event = 'workflow_dispatch' }) {
  validateConfig(config);
  if (!/^\d+$/.test(batchId) || !/^[a-f0-9]{40}$/.test(sourceCommit)) fail('run_identity');
  const startedAt = new Date(clock()).toISOString(), day = datePath(startedAt), blockers = [];
  if (event === 'schedule' && (!config.schedule.enabled || !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.schedule.timeAsiaShanghai ?? ''))) fail('schedule_not_configured');
  await archive.load();
  if (await archive.json(`index/${batchId}.json`)) return { status: 'already_archived', batchId };
  const statePaths = archive.paths('state/');
  const previous = statePaths.length ? await archive.json(statePaths.at(-1)) : { cooldowns: {}, lastRequests: {} };
  const state = validateState(previous);
  let sequence = 0;
  const append = async files => {
    for (const f of files) for (const secret of secrets) if (secret && f.content.includes(secret)) fail('secret_in_output');
    return archive.append(files, batchId);
  };
  const stateFile = current => {
    const savedAt = new Date(clock()).toISOString(), stamp = savedAt.replace(/[-:.]/g, '');
    return { path: `state/${datePath(savedAt)}/${stamp}-${batchId}-${String(++sequence).padStart(3, '0')}.json`,
      content: json({ schemaVersion: 1, batchId, savedAt, ...validateState(current) }) };
  };
  const client = new Client({ state, clock, send, checkpoint: async s => {
    try { await append([stateFile(s)]); } catch { throw new SafeError('archive_checkpoint_failed'); }
  } });
  const files = [], rows = [];
  let pool = await archive.json('pool/frozen-v1.json');
  if (pool) {
    validatePool(pool);
    if (Date.parse(pool.frozenUntil) <= clock()) { blockers.push('pool_review_due'); pool = null; }
  } else {
    const gate = sourceGate(config, 'steam');
    if (gate) blockers.push('steam_' + gate);
    else {
      try {
        const popular = parsePopular(await client.request('steam', 'popular', new URL(HOME)));
        const observedAt = new Date(clock()).toISOString();
        files.push({ path: `selection/${day}/${batchId}.json`, content: json({ schemaVersion: 1, evidenceType: 'live_network',
          source: HOME, observedAt, ...popular }) });
        pool = selectPool(popular, observedAt);
      } catch (e) {
        if (e.code?.startsWith('archive_') || e.code === 'secret_in_output' || e.code === 'append_conflict') throw e;
        blockers.push(safeCode(e)); pool = null;
      }
      // Persist once before collecting quotes; any archive failure is fatal, not a provider failure.
      if (pool) { await append([...files, { path: 'pool/frozen-v1.json', content: json(pool) }]); files.length = 0; }
    }
  }
  let c5 = {}, c5At = null;
  const c5Gate = sourceGate(config, 'c5') ?? (!c5Key ? 'credential_missing' : null);
  const steamGate = sourceGate(config, 'steam');
  let c5Failure = c5Gate;
  if (pool && !c5Gate) {
    try { c5 = await c5Quotes(client, pool, c5Key); c5At = new Date(clock()).toISOString(); }
    catch (e) { if (e.code?.startsWith('archive_')) throw e; c5Failure = safeCode(e); }
  }
  if (c5Gate) blockers.push('c5_' + c5Gate);
  if (steamGate) blockers.push('steam_' + steamGate);
  if (pool) for (const item of pool.entries) {
    const cq = { ...(c5[item.steamHashName] ?? { status: 'failed', reason: c5Failure ?? 'empty_quote' }), collectedAt: c5At };
    let sq;
    try {
      if (steamGate) throw new SafeError(steamGate);
      sq = { ...await steamQuote(client, item), collectedAt: new Date(clock()).toISOString() };
    } catch (e) {
      if (e.code?.startsWith('archive_')) throw e;
      sq = { status: 'failed', reason: safeCode(e), collectedAt: null };
    }
    rows.push({ schemaVersion: 1, evidenceType: 'live_network', batchId, sourceCommit,
      poolVersion: pool.version, item, c5: cq, steam: sq, estimate: estimate(cq, sq, config.fees) });
  }
  if (rows.length) files.push({ path: `quotes/${day}/${batchId}.jsonl`, content: rows.map(x => JSON.stringify(x)).join('\n') + '\n' });
  const pairs = rows.filter(x => x.c5.status === 'ok' && x.steam.status === 'ok').length;
  const estimates = rows.filter(x => x.estimate.status === 'quote_estimate_only').length;
  const finishedAt = new Date(clock()).toISOString();
  const report = { schemaVersion: 1, evidenceType: client.requests ? 'live_network' : 'cloud_run_no_market_requests', batchId, sourceCommit, startedAt, finishedAt,
    status: pairs === 15 && estimates === 15 ? 'quotes_complete_not_trade_verified' : 'blocked_or_partial',
    blockers: [...new Set(blockers)], poolVersion: pool?.version ?? null, itemsAttempted: rows.length,
    pairedQuotes: pairs, feeEstimates: estimates, requests: client.requests, capacity: archive.capacity(),
    configSha256: digest(JSON.stringify(config)), previousStateRead: statePaths.at(-1) ?? null,
    failureCounts: Object.fromEntries([...new Set(rows.flatMap(r => [r.c5.reason, r.steam.reason,
      r.estimate.status === 'unavailable' ? r.estimate.reason : null]).filter(Boolean))]
      .map(reason => [reason, rows.filter(r => [r.c5.reason, r.steam.reason, r.estimate.reason].includes(reason)).length])),
    realTradeVerified: false };
  files.push(stateFile(client.state), { path: `runs/${day}/${batchId}.json`, content: json(report) },
    { path: `index/${batchId}.json`, content: json({ batchId, report: `runs/${day}/${batchId}.json`, finishedAt }) });
  await append(files);
  return report;
}
async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== REPOSITORY ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      !['workflow_dispatch', 'schedule'].includes(process.env.GITHUB_EVENT_NAME)) fail('trusted_cloud_run_required');
  const token = process.env.GITHUB_TOKEN, key = process.env.C5_APP_KEY || null;
  const config = JSON.parse(fs.readFileSync(new URL('../config/collection.json', import.meta.url), 'utf8'));
  const result = await collect({ archive: new GitHubArchive({ token }), config,
    batchId: process.env.GITHUB_RUN_ID, sourceCommit: process.env.GITHUB_SHA,
    c5Key: key, secrets: [token, key], event: process.env.GITHUB_EVENT_NAME });
  const summary = `Collection ${result.batchId}: ${result.status}; paired quotes ${result.pairedQuotes ?? 0}/15.\n`;
  console.log(summary.trim());
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!['quotes_complete_not_trade_verified', 'already_archived'].includes(result.status)) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('Collection stopped: ' + safeCode(e)); process.exitCode = 1; });
}
