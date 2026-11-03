import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { threeMarketHistory, validateExperiment, collectDual } from '../scripts/collect-dual-training.mjs';

const now = Date.UTC(2026, 10, 2, 12);
function history() {
  const data = [Array.from({ length: 200 }, (_, i) => now - (200 - i) * 86400000)];
  for (let m = 0; m < 6; m++) data.push(Array(200).fill(1.23), Array(200).fill(100));
  data[3][0] = .71; data[5][0] = .82;
  return { code: 0, data };
}
test('three-market normalization preserves separate UUYP and C5 prices and absence', () => {
  const raw = history(); raw.data[4][1] = 0;
  const s = threeMarketHistory(JSON.stringify(raw), { id: '1', hash: 'Fixture', category: 'case' },
    new Date(now).toISOString(), 360, new Date(now - 12 * 3600000).toISOString());
  assert.equal(s.observations[0].uuypPriceCents, 71);
  assert.equal(s.observations[0].c5PriceCents, 82);
  assert.equal(s.observations[0].priceCents, 123);
  assert.equal(s.observations[1].uuypPriceCents, null);
  assert.equal(s.validCompletedDaysByMarket.uuyp, 199);
});
test('fine history is explicitly marked as 90 days', () => {
  const s = threeMarketHistory(JSON.stringify(history()), { id: '1', hash: 'Fixture' },
    new Date(now).toISOString(), 90, new Date(now).toISOString());
  assert.equal(s.sourceRequestDays, 90);
  assert.throws(() => threeMarketHistory('', {}, '', 365, ''), /history_window_invalid/);
});
test('roles cannot leak previous candidates into the final unseen-item test', () => {
  const config = JSON.parse(fs.readFileSync('config/dual-training.json', 'utf8'));
  const copy = structuredClone(config); copy.items.find(x => x.role === 'test').hash = copy.testExcludedPriorNames[0];
  assert.throws(() => validateExperiment(copy), /cohort_invalid/);
  validateExperiment(config);
});
test('rate limits stop the collector and persist budget and cooldown without retry', async (t) => {
  const config = JSON.parse(fs.readFileSync('config/dual-training.json', 'utf8'));
  const out = fs.mkdtempSync(path.resolve(tmpdir(), 'dual-collection-test-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  let calls = 0;
  const report = await collectDual(config, out, { clock: () => now, sleep: async () => {},
    send: async () => { calls++; return { status: 429, text: 'not retained' }; } });
  assert.equal(calls, 1); assert.equal(report.requests, 1);
  assert.equal(report.failure, 'rate_limited'); assert.ok(Date.parse(report.cooldownUntil) > now);
  const saved = fs.readFileSync(path.join(out, 'collection.json'), 'utf8');
  assert.equal(saved.includes('not retained'), false);
  await assert.rejects(() => collectDual(config, out, { clock: () => now }), /source_cooldown/);
});
