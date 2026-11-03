// Collect only normalized public C5/Steam quotes; reuse the bounded read-only client.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collect, transport, envelope, cents, validateCohort } from './collect-training-history.mjs';

export function attachC5(snapshot, text) {
  const data = envelope(text);
  if (!Array.isArray(data) || data.length !== 13 || data.some(c => !Array.isArray(c) || c.length !== data[0].length))
    throw Error('c5_history_schema');
  const byTime = new Map(data[0].map((time, i) => {
    const s = data[6][i], n = typeof s === 'string' && /^\d+$/.test(s) ? Number(s) : NaN;
    const count = Number.isSafeInteger(n) && n >= 0 ? n : null;
    return [new Date(Number(time)).toISOString(), { c5PriceCents: count > 0 ? cents(data[5][i]) : null, c5OnSaleCount: count }];
  }));
  if (byTime.size !== data[0].length || snapshot.observations.some(r => !byTime.has(r.observedAt)))
    throw Error('c5_time_alignment');
  snapshot.observations = snapshot.observations.map(r => ({ ...r, ...byTime.get(r.observedAt) }));
  snapshot.purpose = 'unseen_item_historical_c5_to_steam_quote_simulation';
  snapshot.entryPriceBasis = 'c5_aggregate_lowest_listing';
  return snapshot;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--live') throw Error('arguments');
  const cohort = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  validateCohort(cohort);
  const old = JSON.parse(fs.readFileSync('config/training-cohort.json', 'utf8')).items;
  const names = new Set(old.map(r => r.hash)), ids = new Set(old.map(r => r.id));
  if (cohort.items.some(r => names.has(r.hash) || ids.has(r.id))) throw Error('original_cohort_overlap');
  const base = path.resolve('.local'), out = path.resolve(args[2]);
  if (!out.startsWith(base + path.sep) || fs.existsSync(out)) throw Error('new_local_output_required');
  fs.mkdirSync(path.join(out, 'histories'), { recursive: true });
  const pending = new Map();
  const { report } = await collect({ cohort,
    send: async (url, options) => {
      const result = await transport(url, options);
      if (new URL(url).pathname === '/api/commodity/history/line' && result.status === 200) {
        pending.set(String(JSON.parse(options.body).commodityId), result.text);
      }
      return result;
    },
    save: snapshot => {
      const text = pending.get(snapshot.item.id);
      if (!text) throw Error('history_not_received');
      attachC5(snapshot, text); pending.delete(snapshot.item.id);
      fs.writeFileSync(path.join(out, 'histories', snapshot.item.id + '.json'), JSON.stringify(snapshot) + '\n', { flag: 'wx' });
    },
    progress: value => console.log(JSON.stringify(value)) });
  report.purpose = 'unseen_item_historical_c5_to_steam_quote_simulation';
  report.originalCandidateCohortExcluded = true;
  fs.writeFileSync(path.join(out, 'collection.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, accepted: report.accepted.length, requests: report.requests,
    failure: report.failure ?? null }));
  if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('unseen_collection_failed_check_local_inputs'); process.exitCode = 1; });
}
