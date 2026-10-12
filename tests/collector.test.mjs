import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Client, SafeError, money, sellerNet, feeTotal, transport } from '../src/core.mjs';
import { parsePopular, selectPool, validatePool, parseC5, parseBuyOrders, parseItemNameId, sourceGate, estimate } from '../src/market.mjs';
import { appendDelta, allowedPath, GitHubArchive } from '../src/archive.mjs';
import { collect, validateState } from '../src/collect.mjs';

// All market identities below are synthetic, in memory only. No live requests or production writes.
const rawConfig = JSON.parse(fs.readFileSync(new URL('../config/collection.json', import.meta.url)));
const sha = 'a'.repeat(40);
const wallet = { minimumCents: 7, incrementCents: 1, steamBasisPoints: 500, publisherBasisPoints: 1000 };
function config() {
  const c = structuredClone(rawConfig);
  for (const s of Object.values(c.sources)) Object.assign(s, { enabled: true,
    accessEvidenceUrl: 'https://example.com/test-only-access', redistributionEvidenceUrl: 'https://example.com/test-only-redistribution',
    reviewedAt: '2026-10-01T00:00:00.000Z', monthlyCostCny: 0 });
  c.fees = { verified: true, version: 'synthetic-test', evidenceUrl: 'https://example.com/test-only-fees', wallet, c5BuyerFeeCents: 0 };
  return c;
}
function home(cases = 10, capsules = 5) {
  const names = [...Array.from({ length: cases }, (_, i) => `Test ${i} Case`), ...Array.from({ length: capsules }, (_, i) => `Test ${i} Capsule`)];
  return '<div id="popularItemsRows">' + names.map(n => `<a class="market_listing_row_link" href="https://steamcommunity.com/market/listings/730/${encodeURIComponent(n)}">x</a>`).join('') + '<span id="popularItemsMore">';
}
const pool = () => selectPool(parsePopular(home()), '2026-10-12T00:00:00.000Z');
const bid = () => JSON.stringify({ success: 1, price_prefix: '¥', price_suffix: '', highest_buy_order: '117', buy_order_graph: [[1.17, 3, 'ignored']], buy_order_count: 900 });
const response = text => ({ status: 200, headers: {}, text });
class MemoryArchive {
  constructor() { this.files = new Map(); this.writes = 0; }
  async load() {}
  paths(p) { return [...this.files.keys()].filter(x => x.startsWith(p)).sort(); }
  async json(p) { return this.files.has(p) ? JSON.parse(this.files.get(p)) : null; }
  async append(files) { const delta = appendDelta(this.files, files); for (const f of delta) this.files.set(f.path, f.content); this.writes += delta.length; return !!delta.length; }
  capacity() { return { files: this.files.size, currentTreeBytes: 0, warning: false }; }
}
function fakeClient(send, state) {
  let time = Date.parse('2026-10-12T00:00:00Z');
  return new Client({ send, state, clock: () => time, sleep: async ms => { time += ms; } });
}
function collectorClock() { let t = Date.parse('2026-10-12T00:00:00Z'); return () => (t += 4000); }

test('exact money tokens, exponent, tail zeroes and overflow never round', () => {
  assert.equal(money('101e-2', true), 101);
  assert.equal(money('1.010000', true), 101);
  assert.equal(money('0.29'), 29);
  for (const s of ['1.001', '-1', 'NaN', '1e999', '90071992547409.92']) assert.throws(() => money(s, true));
  assert.throws(() => money('1.0100'));
});
test('fees use integer inverse and reject gaps instead of applying 85 percent', () => {
  assert.equal(sellerNet(117, wallet).netCents, 100);
  assert.equal(feeTotal(7, wallet).grossCents, 21);
  let gaps = 0;
  for (let i = 21; i < 500; i++) { try { assert.equal(sellerNet(i, wallet).grossCents, i); } catch (e) { assert.equal(e.code, 'fee_inverse_ambiguous'); gaps++; } }
  assert.ok(gaps > 0);
  assert.throws(() => sellerNet(117, { ...wallet, minimumCents: 0 }));
});
test('C5 exact identity, item count and original numeric tokens; no server messages retained', () => {
  const make = (price, extra = '') => `{"success":true,"data":{"Test Case":{"marketHashName":"Test Case","itemId":123,"count":2,"price":${price}${extra}}}}`;
  assert.equal(parseC5(make('101e-2'), ['Test Case'])['Test Case'].listingCents, 101);
  assert.equal(parseC5(make('1.001'), ['Test Case'])['Test Case'].reason, 'invalid_money');
  assert.equal(parseC5(make('1.01', ',"count":0'), ['Test Case'])['Test Case'].reason, 'mapping_or_availability');
  assert.equal(parseC5(make('1.01', ',"marketHashName":"Other"'), ['Test Case'])['Test Case'].status, 'failed');
  assert.throws(() => parseC5('{"success":false,"errorMsg":"SECRET_TOKEN"}', ['Test Case']), e => e.message === 'c5_rejected');
});
test('Steam requires CNY highest bid with matching top-level quantity; asks cannot substitute', () => {
  assert.equal(parseBuyOrders(bid()).topLevelQuantity, 3);
  assert.equal(parseBuyOrders(bid()).grossCents, 117);
  const d = JSON.parse(bid()); d.price_prefix = 'HK$'; assert.throws(() => parseBuyOrders(JSON.stringify(d)));
  d.price_prefix = '¥'; d.highest_buy_order = null; d.lowest_sell_order = 117; assert.throws(() => parseBuyOrders(JSON.stringify(d)));
  d.highest_buy_order = '117'; d.buy_order_graph[0][0] = 1.18; assert.throws(() => parseBuyOrders(JSON.stringify(d)));
  d.buy_order_graph[0] = [1.17, 0]; assert.throws(() => parseBuyOrders(JSON.stringify(d)));
});
test('Steam item ID is bound to the exact requested public item identity', () => {
  const html = '"market_hash_name":"Test Case"; Market_LoadOrderSpread( 1234 );';
  assert.equal(parseItemNameId(html, 'Test Case'), '1234');
  assert.throws(() => parseItemNameId(html, 'Other Case'));
  assert.throws(() => parseItemNameId(html + 'Market_LoadOrderSpread(5678)', 'Test Case'));
});
test('homepage scope, order and strict counts; never fills from another list', () => {
  assert.equal(pool().entries.length, 15);
  assert.equal(validatePool(pool()).version, pool().version);
  assert.throws(() => selectPool(parsePopular(home(8, 0)), '2026-10-12T00:00:00Z'), e => e.code === 'insufficient_homepage_candidates');
  assert.throws(() => parsePopular(home().replace('popularItemsRows', 'searchResultsRows')));
  assert.throws(() => parsePopular(home().replace('/listings/730/', '/listings/730/../')));
});
test('source approvals and total costs are explicit; default sources stay disabled', () => {
  assert.equal(sourceGate(rawConfig, 'steam'), 'source_disabled');
  const c = config(); assert.equal(sourceGate(c, 'steam'), null);
  c.sources.c5.monthlyCostCny = 11; assert.equal(sourceGate(c, 'steam'), 'budget_exceeded');
  c.sources.c5.monthlyCostCny = 0; c.sources.steam.redistributionEvidenceUrl = null;
  assert.equal(sourceGate(c, 'steam'), 'source_review_missing');
});
test('429 stops the entire source, checkpoints and restores cooldown in a fresh client', async () => {
  let calls = 0, saved;
  const c = fakeClient(async () => { calls++; return { status: 429, headers: { 'retry-after': '900' }, text: 'SECRET' }; });
  c.checkpoint = async state => { saved = structuredClone(state); };
  await assert.rejects(c.request('steam', 'a', new URL('https://steamcommunity.com')), e => e.code === 'rate_limited');
  await assert.rejects(c.request('steam', 'b', new URL('https://steamcommunity.com')), e => e.code === 'cooldown');
  const fresh = fakeClient(async () => { calls++; }, saved);
  await assert.rejects(fresh.request('steam', 'c', new URL('https://steamcommunity.com')), e => e.code === 'cooldown');
  assert.equal(calls, 1);
});
test('5xx retries are bounded, persistent long cooldowns skip sleeping and raw errors are discarded', async () => {
  let calls = 0;
  const c = fakeClient(async () => { calls++; return { status: 503, headers: {}, text: '' }; });
  await assert.rejects(c.request('steam', 'x', new URL('https://steamcommunity.com')), e => e.code === 'server_cooldown');
  assert.equal(calls, 3);
  const long = fakeClient(async () => ({ status: 503, headers: { 'retry-after': '1000' }, text: '' }));
  let saved = false; long.checkpoint = async () => { saved = true; };
  await assert.rejects(long.request('steam', 'x', new URL('https://steamcommunity.com')));
  assert.equal(long.requests, 1); assert.ok(saved);
  const network = fakeClient(async () => { throw new Error('SECRET_KEY'); });
  await assert.rejects(network.request('steam', 'x', new URL('https://steamcommunity.com')), e => e.message === 'network');
});
test('inflight calls merge and subsequent calls obey the 3-second source interval', async () => {
  const times = [];
  const c = fakeClient(async () => { times.push(c.clock()); return response('ok'); });
  const url = new URL('https://steamcommunity.com');
  await Promise.all([c.request('steam', 'x', url), c.request('steam', 'x', url)]);
  await c.request('steam', 'y', url);
  assert.equal(times.length, 2); assert.ok(times[1] - times[0] >= 3000);
});
test('transport rejects external destinations and authenticated URLs before connecting', () => {
  assert.throws(() => transport(new URL('https://example.com')));
  assert.throws(() => transport(new URL('http://steamcommunity.com')));
  assert.throws(() => transport(new URL('https://user:secret@steamcommunity.com')));
});
test('append path guard prevents source writes, traversal, duplicate names and history changes', () => {
  const p = 'runs/2026/10/12/1.json', old = new Map([[p, '{}\n']]);
  assert.equal(appendDelta(old, [{ path: p, content: '{}\n' }]).length, 0);
  assert.throws(() => appendDelta(old, [{ path: p, content: '{"changed":true}' }]), e => e.code === 'append_conflict');
  for (const path of ['.github/workflows/evil.yml', 'main/a', 'quotes/../../AGENTS.md', 'state/latest.json', 'pool/other.json', 'quotes\\2026\\1.json']) {
    assert.equal(allowedPath(path), false); assert.throws(() => appendDelta(old, [{ path, content: '{}' }]));
  }
  assert.throws(() => appendDelta(old, [{ path: p, content: '{}' }, { path: p, content: '{}' }]));
});
test('archive repository visibility is verified and API errors never echo response bodies', async () => {
  const privateArchive = new GitHubArchive({ token: 'test-token', fetcher: async () => ({ ok: true, json: async () => ({ full_name: 'zfy06011/cs2-market-data', private: true, default_branch: 'main' }) }) });
  await assert.rejects(privateArchive.load(), e => e.code === 'archive_identity');
  const rejected = new GitHubArchive({ token: 'test-token', fetcher: async () => ({ ok: false, status: 403, json: async () => ({ message: 'SECRET' }) }) });
  await assert.rejects(rejected.load(), e => e.message === 'archive_http' && e.httpStatus === 403);
  assert.throws(() => new GitHubArchive({ token: 'test-token', repository: 'other/repo' }));
});
test('unverified fee or missing side never produces a executable return', () => {
  assert.equal(estimate({ status: 'ok', listingCents: 80 }, { status: 'ok', grossCents: 117 }, rawConfig.fees).reason, 'fee_unverified');
  assert.equal(estimate({ status: 'failed' }, { status: 'ok' }, config().fees).reason, 'missing_current_quote');
  assert.equal(estimate({ status: 'ok', listingCents: 80 }, { status: 'ok', grossCents: 117 }, config().fees).executable, false);
});
test('disabled sources record blockers with no market network, no fake quotes; rerun deduplicates', async () => {
  const a = new MemoryArchive();
  const options = { archive: a, config: rawConfig, batchId: '1', sourceCommit: sha, clock: collectorClock(), send: () => { throw Error('must not fetch'); } };
  const r = await collect(options);
  assert.equal(r.status, 'blocked_or_partial'); assert.equal(r.requests, 0);
  assert.equal(r.evidenceType, 'cloud_run_no_market_requests');
  assert.equal(a.paths('quotes/').length, 0); assert.equal(a.paths('state/').length, 1);
  const writes = a.writes;
  assert.equal((await collect(options)).status, 'already_archived'); assert.equal(a.writes, writes);
});
test('insufficient real-format homepage is archived as observation; pool stays unset', async () => {
  const a = new MemoryArchive();
  const r = await collect({ archive: a, config: config(), batchId: '2', sourceCommit: sha,
    clock: collectorClock(), send: async () => response(home(8, 0)) });
  assert.ok(r.blockers.includes('insufficient_homepage_candidates'));
  assert.equal(a.paths('pool/').length, 0); assert.equal(a.paths('selection/').length, 1); assert.equal(a.paths('quotes/').length, 0);
});
test('end-to-end mock collection freezes the pool, pairs 15 items and preserves state on next run', async () => {
  const a = new MemoryArchive(); let homepageCalls = 0;
  const send = async (u, options) => {
    if (u.href === 'https://steamcommunity.com/market/') { homepageCalls++; return response(home()); }
    if (u.hostname === 'openapi.c5game.com') {
      const names = JSON.parse(options.body).marketHashNames;
      return response(JSON.stringify({ success: true, data: Object.fromEntries(names.map((n, i) => [n, { marketHashName: n, itemId: 100 + i, count: 5, price: 0.8 }])) }));
    }
    if (u.pathname.includes('/listings/')) return response(`"market_hash_name":${JSON.stringify(decodeURIComponent(u.pathname.split('/').at(-1)))}; Market_LoadOrderSpread(12345);`);
    return response(bid());
  };
  const r = await collect({ archive: a, config: config(), batchId: '3', sourceCommit: sha, c5Key: 'synthetic-key', send, clock: collectorClock() });
  assert.equal(r.status, 'quotes_complete_not_trade_verified'); assert.equal(r.pairedQuotes, 15);
  assert.equal(r.realTradeVerified, false); assert.equal(a.paths('quotes/').length, 1);
  let t = Date.parse('2026-10-13T00:00:00Z');
  const second = await collect({ archive: a, config: config(), batchId: '4', sourceCommit: sha, c5Key: 'synthetic-key', send, clock: () => (t += 4000) });
  assert.equal(homepageCalls, 1); assert.equal(second.pairedQuotes, 15); assert.ok(second.previousStateRead);
  assert.equal(a.paths('quotes/').length, 2); assert.equal(a.paths('pool/').length, 1);
});
test('secret sentinel blocks public archive writes and invalid saved cooldown fails closed', async () => {
  const a = new MemoryArchive();
  await assert.rejects(collect({ archive: a, config: rawConfig, batchId: '5', sourceCommit: sha,
    clock: collectorClock(), secrets: ['blocked_or_partial'] }), e => e.code === 'secret_in_output');
  assert.equal(a.files.size, 0);
  assert.throws(() => validateState({ cooldowns: { steam: -1 }, lastRequests: {} }));
  assert.throws(() => validateState({ cooldowns: { evil: 123 }, lastRequests: {} }));
});
test('production workflow has no schedule or PR trigger; tests get no credentials and data pushes do not run checks', () => {
  const collectWorkflow = fs.readFileSync(new URL('../.github/workflows/collect.yml', import.meta.url), 'utf8');
  const checks = fs.readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  assert.ok(!/^\s+(schedule|pull_request|pull_request_target|push):/m.test(collectWorkflow));
  assert.ok(collectWorkflow.includes('cancel-in-progress: false'));
  assert.ok(collectWorkflow.indexOf('npm test') < collectWorkflow.indexOf('C5_APP_KEY:'));
  assert.ok(!checks.includes('secrets.') && !checks.includes('contents: write'));
  assert.ok(checks.includes('branches: [main]'));
});

test('freeze validates duplicate identities/order and clamps the six-month anniversary', () => {
  const p = parsePopular(home()); p.entries[1].steamHashName = p.entries[0].steamHashName;
  assert.throws(() => selectPool(p, '2026-10-12T00:00:00Z'));
  const q = parsePopular(home()); [q.entries[0], q.entries[1]] = [q.entries[1], q.entries[0]];
  assert.throws(() => selectPool(q, '2026-10-12T00:00:00Z'));
  const frozen = selectPool(parsePopular(home()), '2026-08-31T12:00:00.000Z');
  assert.equal(frozen.frozenUntil, '2027-02-28T12:00:00.000Z');
});
test('failure to persist a cooldown stops collection before any subsequent source request', async () => {
  const a = new MemoryArchive(); a.files.set('pool/frozen-v1.json', JSON.stringify(pool()));
  a.append = async () => { throw new Error('storage_unavailable'); };
  let calls = 0;
  await assert.rejects(collect({ archive: a, config: config(), batchId: '6', sourceCommit: sha,
    c5Key: 'synthetic-key', clock: collectorClock(), send: async () => {
      calls++; return { status: 429, headers: { 'retry-after': '900' }, text: '' };
    } }), e => e.code === 'archive_checkpoint_failed');
  assert.equal(calls, 1); assert.equal(a.paths('index/').length, 0);
});
test('archive appends through data refs, reads back, deduplicates and rejects a stale ref without force', async () => {
  const blobs = new Map(), trees = new Map(), commits = new Map(), calls = [];
  let head = null, serial = 0, conflict = false;
  const id = () => createHash('sha1').update(String(++serial)).digest('hex');
  const ok = value => ({ ok: true, status: 200, json: async () => value });
  const http = status => ({ ok: false, status, json: async () => ({ message: 'never show raw' }) });
  const fetcher = async (url, options) => {
    const root = 'https://api.github.com/repos/zfy06011/cs2-market-data';
    assert.ok(url.startsWith(root));
    const route = url.slice(root.length), method = options.method, body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, method, body });
    if (route === '') return ok({ full_name: 'zfy06011/cs2-market-data', private: false, default_branch: 'main' });
    if (route === '/git/ref/heads/data') return head ? ok({ object: { sha: head, type: 'commit' } }) : http(404);
    if (route.startsWith('/git/commits/') && method === 'GET') return ok(commits.get(route.split('/').at(-1)));
    if (route.startsWith('/git/trees/') && method === 'GET') return ok({ truncated: false, tree: [...trees.get(route.split('/').at(-1).split('?')[0]).values()] });
    if (route.startsWith('/git/blobs/')) { const content = blobs.get(route.split('/').at(-1)); return ok({ encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') }); }
    if (route === '/git/trees' && method === 'POST') {
      const tree = new Map(body.base_tree ? trees.get(body.base_tree) : []);
      for (const entry of body.tree) {
        assert.equal(entry.mode, '100644'); assert.ok(allowedPath(entry.path));
        const sha = id(); blobs.set(sha, entry.content);
        tree.set(entry.path, { path: entry.path, sha, type: 'blob', mode: '100644', size: Buffer.byteLength(entry.content) });
      }
      const sha = id(); trees.set(sha, tree); return ok({ sha });
    }
    if (route === '/git/commits' && method === 'POST') {
      assert.deepEqual(body.parents, head ? [head] : []);
      const sha = id(); commits.set(sha, { tree: { sha: body.tree } }); return ok({ sha });
    }
    if (route === '/git/refs' && method === 'POST') { assert.equal(body.ref, 'refs/heads/data'); assert.equal(head, null); head = body.sha; return ok({}); }
    if (route === '/git/refs/heads/data' && method === 'PATCH') { assert.equal(body.force, false); if (conflict) return http(422); head = body.sha; return ok({}); }
    assert.fail('unexpected GitHub route: ' + route);
  };
  const a = new GitHubArchive({ token: 'synthetic-token', fetcher }); await a.load();
  const first = { path: 'runs/2026/10/12/10.json', content: '{"ok":true}\n' };
  assert.equal(await a.append([first], '10'), true);
  assert.equal(await a.read(first.path), first.content);
  const mutations = () => calls.filter(c => c.method !== 'GET').length;
  const before = mutations(); assert.equal(await a.append([first], '10'), false); assert.equal(mutations(), before);
  await assert.rejects(a.append([{ ...first, content: 'changed' }], '10'), e => e.code === 'append_conflict');
  assert.equal(mutations(), before);
  await a.append([{ path: 'runs/2026/10/12/11.json', content: '{}\n' }], '11');
  const saved = head; conflict = true;
  await assert.rejects(a.append([{ path: 'runs/2026/10/12/12.json', content: '{}\n' }], '12'), e => e.httpStatus === 422);
  assert.equal(head, saved); assert.equal(await a.read('runs/2026/10/12/12.json'), null);
  assert.ok(calls.every(c => !c.route.includes('heads/main')));
});
