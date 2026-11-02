import test from 'node:test';
import assert from 'node:assert/strict';
import { cents, collect, normalizeHistory, transport, validateCohort } from '../scripts/collect-training-history.mjs';

const now = Date.UTC(2026, 10, 2, 12);
const html = '<script src="/assets/index-fixture.js"></script>';
const bundle = 'a=b.enc.Utf8.parse("abcdefghijklmnop"),c=b.enc.Utf8.parse("ponmlkjihgfedcba");function f(){b.AES.encrypt(1)};r.headers.Auth2="12345678-1234-1234-1234-123456789abc";"/commodity/suggest";"/commodity/exchange"';
const items = Array.from({ length: 22 }, (_, i) => ({ id: String(i + 1), hash: 'Fixture ' + (i + 1), category: 'case' }));
const cohort = { schemaVersion: 1, items };
function history() {
  const data = [Array.from({ length: 200 }, (_, i) => now - (200 - i) * 86400000)];
  for (let i = 0; i < 6; i++) data.push(Array(200).fill(1.23), Array(200).fill(100));
  return JSON.stringify({ code: 0, data });
}
function fixture(change = () => null) {
  let time = now;
  const calls = [];
  return { calls, options: { cohort, clock: () => time, sleep: async n => { time += n; }, send: async (url, options) => {
    const n = calls.length; calls.push({ url, time, options });
    const replacement = change(n, url); if (replacement) return replacement;
    if (n === 0) return { status: 200, text: html };
    if (n === 1) return { status: 200, text: bundle };
    const match = /\/commodity\/(\d+)$/.exec(url);
    return { status: 200, text: match ? JSON.stringify({ code: 0, data: { id: Number(match[1]), appid: 730, hashName: 'Fixture ' + match[1] } }) : history() };
  } } };
}
test('training collection stops at 20 qualified items and uses serial bounded requests', async () => {
  const f = fixture(), r = await collect(f.options);
  assert.equal(r.report.status, 'passed'); assert.equal(r.snapshots.length, 20); assert.equal(f.calls.length, 42);
  for (let i = 1; i < f.calls.length; i++) assert.ok(f.calls[i].time - f.calls[i - 1].time >= 3000);
  assert.equal(r.report.sourceRequestDays, 360); assert.equal(r.report.requestedWindowDays, 365);
  for (const secret of ['abcdefghijklmnop', 'ponmlkjihgfedcba', '12345678-1234-1234-1234-123456789abc']) assert.equal(JSON.stringify(r).includes(secret), false);
});
test('429 stops without retrying or fetching more products at each initial phase', async () => {
  for (let at = 0; at < 4; at++) {
    const f = fixture(n => n === at ? { status: 429, text: 'private response' } : null), r = await collect(f.options);
    assert.equal(r.report.failure, 'rate_limited'); assert.equal(f.calls.length, at + 1);
    assert.equal(JSON.stringify(r).includes('private response'), false);
  }
});
test('wrong exact item identity never gets a history request and is reported', async () => {
  const f = fixture(n => n === 2 ? { status: 200, text: JSON.stringify({ code: 0, data: { id: 1, appid: 730, hashName: 'Wrong' } }) } : null);
  const r = await collect(f.options);
  assert.equal(r.report.status, 'passed'); assert.equal(r.report.skipped[0].reason, 'identity_mismatch');
  assert.equal(r.snapshots.some(s => s.item.id === '1'), false); assert.equal(f.calls.length, 43);
});
test('malformed and duplicate cohort records are rejected before network', () => {
  for (const value of [{}, { schemaVersion: 1, items: items.slice(0, 19) }, { schemaVersion: 1, items: [...items, items[0]] }]) {
    assert.throws(() => validateCohort(value), /cohort_invalid/);
  }
});
test('money uses exact cents and missing observations are never converted to zero', () => {
  assert.equal(cents('1.23'), 123); assert.equal(cents('1.23e2'), 12300);
  assert.equal(cents('1.231'), null); assert.equal(cents('0'), null); assert.equal(cents('-1'), null);
  const raw = JSON.parse(history()); raw.data[12][0] = 0; raw.data[11][1] = null;
  const r = normalizeHistory(JSON.stringify(raw), items[0], new Date(now).toISOString());
  assert.equal(r.observations[0].priceCents, null); assert.equal(r.observations[1].priceCents, null);
  assert.equal(r.validCompletedDays, 198);
});
test('duplicate times and future observations cannot enter a training snapshot', () => {
  const raw = JSON.parse(history()); raw.data[0][1] = raw.data[0][0];
  assert.throws(() => normalizeHistory(JSON.stringify(raw), items[0], new Date(now).toISOString()), /history_time_invalid/);
  raw.data[0][1] = now + 86400000;
  assert.throws(() => normalizeHistory(JSON.stringify(raw), items[0], new Date(now).toISOString()), /history_time_invalid/);
});
test('collector refuses arbitrary hosts, credentials, queries and trading endpoints', () => {
  for (const url of ['https://other.example/exchange', 'https://user:pass@smis.club/exchange',
    'https://smis.club/api/order', 'https://smis.club/api/commodity/1?token=secret']) {
    assert.throws(() => transport(url), /endpoint_not_allowed/);
  }
});
