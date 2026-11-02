import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { probe, bootstrapConfig, historySummary, cloudContext, transport, markdown, TARGET, HISTORY_KEYS } from '../scripts/probe-smis-cloud.mjs';

const now = Date.UTC(2026, 10, 2);
const html = '<script type="module" src="/assets/index-test.js"></script>';
const key = '1111111111111111', iv = '2222222222222222', tenant = '00000000-1111-2222-3333-444444444444';
const bundle = `a=b.enc.Utf8.parse("${key}"),c=b.enc.Utf8.parse("${iv}");function x(){b.AES.encrypt()}x.headers.Auth2="${tenant}";/commodity/suggest /commodity/exchange`;
const identity = JSON.stringify({ code: 0, data: { id: 4578, appid: 730, hashName: 'Revolution Case' } });
function history() {
  const data = [[now - 86400000, now]];
  for (let p = 0; p < 6; p++) data.push([0.89, 1.20], [100, 150]);
  return { code: 0, data };
}
function fixture(overrides = {}) {
  let clock = now, calls = [], waits = [];
  const bodies = [html, bundle, identity, JSON.stringify(history())];
  return { calls, waits, options: { clock: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }, send: async (url, options) => {
    const index = calls.length; calls.push({ url, options });
    if (overrides.throwAt === index) throw Error('source_response_secret');
    return overrides[index] ?? { status: 200, text: bodies[index] };
  } } };
}
test('one-item probe validates identity and Steam history with exactly four serial requests', async () => {
  const f = fixture(), result = await probe(f.options);
  assert.equal(result.status, 'passed'); assert.equal(result.requests, 4); assert.equal(result.phases.every(p => p.status === 'passed'), true);
  assert.deepEqual(f.waits, [3000, 3000, 3000]); assert.equal(result.history.samples, 2); assert.equal(result.history.steamPricePoints, 2);
  assert.equal(result.history.medianIntervalHours, 24); assert.equal(result.rawDataRetained, false);
  assert.deepEqual(JSON.parse(f.calls[3].options.body), { commodityId: 4578, days: 360, keys: HISTORY_KEYS });
  assert.equal(f.calls[2].options.headers.Auth2, tenant);
  for (const secret of [key, iv, tenant]) assert.equal(JSON.stringify(result).includes(secret), false);
});
test('changed public client and wrong item identity stop before history', async () => {
  const changed = fixture({ 0: { status: 200, text: '<script src="/assets/new.js"></script>' } });
  assert.equal((await probe(changed.options)).failure, 'public_client_changed'); assert.equal(changed.calls.length, 1);
  const wrong = fixture({ 2: { status: 200, text: JSON.stringify({ code: 0, data: { id: 4578, appid: 730, hashName: 'Wrong Case' } }) } });
  assert.equal((await probe(wrong.options)).failure, 'identity_mismatch'); assert.equal(wrong.calls.length, 3);
});
test('429 immediately stops in every phase without retrying or fetching another item', async () => {
  for (let index = 0; index < 4; index++) {
    const f = fixture({ [index]: { status: 429, text: 'private error response' } }), result = await probe(f.options);
    assert.equal(result.failure, 'rate_limited'); assert.equal(result.requests, index + 1);
    assert.equal(f.calls.length, index + 1); assert.equal(JSON.stringify(result).includes('private error response'), false);
  }
});
test('HTTP denial, server failure and redirect remain distinct failures with no retries', async () => {
  for (const [status, failure] of [[403, 'access_denied'], [503, 'http_error'], [302, 'redirect_not_followed']]) {
    const f = fixture({ 0: { status, text: 'secret body' } }), result = await probe(f.options);
    assert.equal(result.failure, failure); assert.equal(result.requests, 1); assert.equal(result.phases[0].httpStatus, status);
  }
});
test('external exceptions never enter public logs or step summaries', async () => {
  const result = await probe(fixture({ throwAt: 0 }).options);
  assert.equal(result.failure, 'internal_error'); assert.equal((JSON.stringify(result) + markdown(result)).includes('source_response_secret'), false);
});
test('history validation rejects bad dimensions, duplicate times and non-cent or unavailable prices', () => {
  const shape = history(); shape.data.pop(); assert.throws(() => historySummary(JSON.stringify(shape), now), { code: 'history_schema' });
  const duplicate = history(); duplicate.data[0][1] = duplicate.data[0][0]; assert.throws(() => historySummary(JSON.stringify(duplicate), now), { code: 'history_time_invalid' });
  const unavailable = history(); unavailable.data[11] = [0.001, 0.89]; unavailable.data[12] = [100, 0];
  assert.throws(() => historySummary(JSON.stringify(unavailable), now), { code: 'steam_history_empty' });
  const valid = history(); valid.data[11] = [null, 1.23]; assert.equal(historySummary(JSON.stringify(valid), now).steamPricePoints, 1);
});
test('transport refuses arbitrary hosts and endpoints before network', () => {
  for (const url of ['https://evil.example/exchange', 'http://smis.club/exchange', 'https://user:secret@smis.club/exchange', 'https://smis.club/api/commodity/1', 'https://smis.club/exchange?token=secret']) assert.throws(() => transport(url), { code: 'endpoint_not_allowed' });
  assert.throws(() => bootstrapConfig('<script src="https://evil.example/assets/index-test.js"></script>'), { code: 'public_client_changed' });
});
test('CLI requires the intended GitHub-hosted context and performs no local live requests', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'zfy06011/cs2-market-data', GITHUB_REF: 'refs/heads/main', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123' };
  assert.equal(cloudContext(env).runId, '123');
  for (const changes of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/other' }]) assert.throws(() => cloudContext({ ...env, ...changes }), { code: 'github_hosted_run_required' });
  const child = spawnSync(process.execPath, ['scripts/probe-smis-cloud.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8' });
  assert.equal(child.status, 1); const result = JSON.parse(child.stdout); assert.equal(result.requests, 0); assert.equal(result.failure, 'github_hosted_run_required');
});
test('workflow has read-only repository access and no schedule, secrets or archive writes', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/probe-smis-cloud.yml', import.meta.url), 'utf8');
  assert.match(workflow, /contents: read/); assert.match(workflow, /timeout-minutes: 5/);
  assert.doesNotMatch(workflow, /contents: write|secrets\.|schedule:|pull_request:|upload-artifact|actions\/cache|git push/);
  assert.equal(TARGET.hash, 'Revolution Case');
});
