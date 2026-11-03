// Finer public history for execution-time resolution only; no model fitting.
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createHash } from 'node:crypto';
import { bootstrapConfig, HISTORY_KEYS } from './probe-smis-cloud.mjs';
import { transport, normalizeHistory } from './collect-training-history.mjs';

const origin = 'https://smis.club';
async function main() {
  const [flag, rootArg] = process.argv.slice(2);
  if (flag !== '--live' || !rootArg) throw Error('arguments');
  const root = path.resolve(rootArg), base = path.resolve('.local');
  if (!root.startsWith(base + path.sep)) throw Error('local_only');
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'exit-data-plan.json'), 'utf8'));
  const previous = JSON.parse(fs.readFileSync(path.join(root, 'input/collection.json'), 'utf8'));
  if (plan.sourceRequestDays !== 90 || previous.status !== 'passed' || previous.requests + previous.accepted.length + 2 > 82)
    throw Error('budget_or_plan_invalid');
  const out = path.join(root, 'exit-history');
  if (fs.existsSync(out)) throw Error('output_exists');
  fs.mkdirSync(out);
  const report = { schemaVersion: 1, purpose: 'finer_exit_quote_grid_no_decision_rule_change', sourceRequestDays: 90,
    startedAt: new Date().toISOString(), requests: 0, accepted: [], status: 'failed' };
  let last = null;
  async function request(url, options) {
    if (report.requests >= previous.accepted.length + 2) throw Error('budget');
    if (last !== null) { const wait = 3000 - (Date.now() - last); if (wait > 0) await new Promise(r => setTimeout(r, wait)); }
    last = Date.now(); report.requests++;
    const response = await transport(url, options);
    if (response.status !== 200) throw Error(response.status === 429 ? 'rate_limited' : 'source_http_failure');
    return response.text;
  }
  try {
    const html = await request(origin + '/exchange'), { bundleUrl } = bootstrapConfig(html);
    const bundle = await request(bundleUrl), config = bootstrapConfig(html, bundle);
    report.publicBundleSha256 = createHash('sha256').update(bundle).digest('hex');
    for (const entry of previous.accepted) {
      const cipher = createCipheriv('aes-128-cbc', config.key, config.iv);
      const auth = Buffer.concat([cipher.update(String(Date.now()), 'utf8'), cipher.final()]).toString('base64');
      const text = await request(origin + '/api/commodity/history/line', {
        body: JSON.stringify({ commodityId: Number(entry.item.id), days: 90, keys: HISTORY_KEYS }),
        headers: { Auth: auth, Auth2: config.tenant, Origin: origin, Referer: origin + '/exchange' } });
      const snapshot = normalizeHistory(text, entry.item, new Date().toISOString());
      snapshot.sourceRequestDays = 90;
      snapshot.purpose = 'finer_exit_quote_grid_no_model_features';
      snapshot.publicBundleSha256 = report.publicBundleSha256;
      const bytes = JSON.stringify(snapshot) + '\n';
      fs.writeFileSync(path.join(out, entry.item.id + '.json'), bytes, { flag: 'wx' });
      const intervals = snapshot.observations.slice(1).map((r, i) => Date.parse(r.observedAt) - Date.parse(snapshot.observations[i].observedAt)).sort((a, b) => a - b);
      const medianHours = intervals[Math.floor(intervals.length / 2)] / 3600000;
      report.accepted.push({ item: entry.item, sha256: createHash('sha256').update(bytes).digest('hex'),
        points: snapshot.observations.length, medianIntervalHours: medianHours });
      console.log(JSON.stringify({ id: entry.item.id, points: snapshot.observations.length, medianIntervalHours: medianHours }));
    }
    report.status = 'passed';
  } catch (error) { report.failure = error.message === 'rate_limited' ? 'rate_limited' : 'finer_history_failed'; }
  report.completedAt = new Date().toISOString();
  report.totalRequestsIncludingDaily = previous.requests + report.requests;
  fs.writeFileSync(path.join(out, 'collection.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, requests: report.requests, totalRequests: report.totalRequestsIncludingDaily }));
  if (report.status !== 'passed') process.exitCode = 1;
}
main().catch(() => { console.error('exit_history_collection_failed'); process.exitCode = 1; });
