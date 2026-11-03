import test from 'node:test';
import assert from 'node:assert/strict';
import { attachC5 } from '../scripts/collect-unseen-backtest.mjs';

const times = [Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2)];
function fixture() {
  const data = [times];
  for (let p = 0; p < 6; p++) data.push([1.23, 1.24], [100, 100]);
  data[5] = [0.71, 0.72];
  return data;
}
function snapshot() { return { observations: [...times].reverse().map(t => ({ observedAt: new Date(t).toISOString(), priceCents: 123 })) }; }
test('C5 values join by observation time while Steam quotes remain untouched', () => {
  const r = attachC5(snapshot(), JSON.stringify({ code: 0, data: fixture() }));
  assert.deepEqual(r.observations.map(x => x.c5PriceCents), [72, 71]);
  assert.deepEqual(r.observations.map(x => x.priceCents), [123, 123]);
  assert.equal(r.entryPriceBasis, 'c5_aggregate_lowest_listing');
});
test('C5 zero availability is a missing entry quote, never a zero-cost purchase', () => {
  const data = fixture(); data[6][0] = 0;
  const r = attachC5(snapshot(), JSON.stringify({ code: 0, data }));
  assert.equal(r.observations[1].c5PriceCents, null);
});
test('mismatched and duplicate C5 times cannot be paired with Steam', () => {
  const data = fixture(); data[0] = [times[0], times[0]];
  assert.throws(() => attachC5(snapshot(), JSON.stringify({ code: 0, data })), /c5_time_alignment/);
});
