import { createHash } from 'node:crypto';
import { fail, money, positive, sellerNet, timestamp } from './core.mjs';

export const HOME = 'https://steamcommunity.com/market/';
export const digest = text => createHash('sha256').update(text).digest('hex');
export const category = name => / Case$/.test(name) ? 'case' : / Capsule$/.test(name) ? 'capsule' : null;
export function sourceGate(config, source) {
  const entry = config.sources[source];
  if (!entry?.enabled) return 'source_disabled';
  for (const field of ['accessEvidenceUrl', 'redistributionEvidenceUrl']) {
    try { const u = new URL(entry[field]); if (u.protocol !== 'https:' || u.username || u.password) return 'source_review_missing'; }
    catch { return 'source_review_missing'; }
  }
  if (!timestamp(entry.reviewedAt)) return 'source_review_missing';
  if (!Number.isFinite(entry.monthlyCostCny) || entry.monthlyCostCny < 0) return 'source_cost_unverified';
  const enabled = Object.values(config.sources).filter(s => s.enabled);
  if (enabled.some(s => !Number.isFinite(s.monthlyCostCny) || s.monthlyCostCny < 0) ||
      enabled.reduce((sum, s) => sum + s.monthlyCostCny, 0) > config.monthlyBudgetCny) return 'budget_exceeded';
  return null;
}
export function parsePopular(html) {
  const start = html.search(/id=["']popularItemsRows["']/), end = html.search(/id=["']popularItemsMore["']/);
  if (start < 0 || end <= start) fail('homepage_schema');
  const entries = [], seen = new Set(); let rank = 0;
  for (const anchor of html.slice(start, end).matchAll(/<a\b[^>]*>/gi)) {
    const tag = anchor[0];
    if (!/class=["'][^"']*\bmarket_listing_row_link\b[^"']*["']/.test(tag)) continue;
    rank++;
    const href = /href=["']([^"']+)["']/.exec(tag)?.[1]?.replaceAll('&amp;', '&');
    let url; try { url = new URL(href); } catch { fail('homepage_schema'); }
    if (url.origin !== 'https://steamcommunity.com' || url.username || url.password || url.search || url.hash) fail('homepage_schema');
    const match = /^\/market\/listings\/(\d+)\/([^/]+)$/.exec(url.pathname);
    if (!match) fail('homepage_schema');
    if (match[1] !== '730') continue;
    let name; try { name = decodeURIComponent(match[2]); } catch { fail('homepage_schema'); }
    if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name) || seen.has(name)) fail('homepage_schema');
    seen.add(name);
    if (category(name)) entries.push({ steamHashName: name, category: category(name), sourceRank: rank });
  }
  if (!rank) fail('homepage_schema');
  return { rowsDisplayed: rank, entries };
}
export function selectPool(popular, observedAt) {
  if (!timestamp(observedAt)) fail('invalid_time');
  if (!Array.isArray(popular.entries) || popular.entries.some(x => typeof x.steamHashName !== 'string' ||
      category(x.steamHashName) !== x.category || !positive(x.sourceRank)) ||
      new Set(popular.entries.map(x => x.steamHashName)).size !== popular.entries.length ||
      new Set(popular.entries.map(x => x.sourceRank)).size !== popular.entries.length ||
      popular.entries.some((x, i) => i && x.sourceRank <= popular.entries[i - 1].sourceRank)) fail('pool_invalid');
  const cases = popular.entries.filter(x => x.category === 'case').slice(0, 10);
  const capsules = popular.entries.filter(x => x.category === 'capsule').slice(0, 5);
  if (cases.length !== 10 || capsules.length !== 5) fail('insufficient_homepage_candidates');
  const entries = [...cases, ...capsules].sort((a, b) => a.sourceRank - b.sourceRank)
    .map(x => ({ ...x, id: digest(x.steamHashName).slice(0, 16) }));
  const expiry = new Date(observedAt), day = expiry.getUTCDate();
  expiry.setUTCDate(1); expiry.setUTCMonth(expiry.getUTCMonth() + 6);
  const lastDay = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)).getUTCDate();
  expiry.setUTCDate(Math.min(day, lastDay));
  return { schemaVersion: 1, observedAt, frozenUntil: expiry.toISOString(),
    source: HOME, sourceLabel: 'Steam market homepage popular items',
    selection: { cases: 10, capsules: 5, ordering: 'homepage_display_order' },
    entries, version: digest(JSON.stringify(entries)) };
}
export function validatePool(pool) {
  if (pool?.schemaVersion !== 1 || pool.source !== HOME || !timestamp(pool.observedAt) ||
      !timestamp(pool.frozenUntil) || !Array.isArray(pool.entries) || pool.entries.length !== 15) fail('pool_invalid');
  const expected = selectPool({ entries: pool.entries }, pool.observedAt);
  if (JSON.stringify(expected) !== JSON.stringify(pool)) fail('pool_invalid');
  return pool;
}
export function parseC5(text, names) {
  let data;
  try { data = JSON.parse(text, (key, value, context) =>
    key === 'price' && typeof value === 'number' ? { numericToken: context.source } : value); }
  catch { fail('c5_schema'); }
  if (data?.success !== true || !data.data || typeof data.data !== 'object' || Array.isArray(data.data)) fail('c5_rejected');
  return Object.fromEntries(names.map(hash => {
    try {
      const x = data.data[hash];
      if (!x || x.marketHashName !== hash || !positive(x.count) ||
          !(typeof x.itemId === 'string' || positive(x.itemId)) || !/^[1-9]\d{0,29}$/.test(String(x.itemId))) fail('mapping_or_availability');
      const price = x.price?.numericToken ? money(x.price.numericToken, true) : money(x.price);
      if (!positive(price)) fail('empty_quote');
      return [hash, { status: 'ok', listingCents: price, onSaleCount: x.count, itemId: String(x.itemId), currency: 'CNY' }];
    } catch (e) { return [hash, { status: 'failed', reason: e.code ?? 'c5_schema' }]; }
  }));
}
export function parseItemNameId(html, hash) {
  const ids = [...html.matchAll(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/g)].map(m => m[1]);
  const escaped = JSON.stringify(hash).slice(1, -1);
  const assetIdentity = html.includes('"market_hash_name":"' + escaped + '"') || html.includes('"market_hash_name": "' + escaped + '"');
  if (!assetIdentity || ids.length !== 1 || !/^[1-9]\d{0,19}$/.test(ids[0])) fail('steam_item_identity');
  return ids[0];
}
export function parseBuyOrders(text) {
  let d; try { d = JSON.parse(text); } catch { fail('steam_schema'); }
  if (d?.success !== 1 || !['¥', '￥'].includes(d.price_prefix?.trim()) || (d.price_suffix ?? '').trim()) fail('currency_or_schema');
  if (!/^[1-9]\d*$/.test(String(d.highest_buy_order ?? ''))) fail('empty_buy_order');
  const gross = Number(d.highest_buy_order), level = d.buy_order_graph?.[0];
  if (!positive(gross) || !Array.isArray(level) || !positive(level[1]) || money(level[0]) !== gross) fail('buy_order_quantity');
  return { status: 'ok', currency: 'CNY', grossCents: gross, topLevelQuantity: level[1], basis: 'highest_buy_order_buyer_total' };
}
export async function c5Quotes(client, pool, key) {
  const url = new URL('https://openapi.c5game.com/merchant/product/price/batch');
  url.searchParams.set('app-key', key);
  const names = pool.entries.map(x => x.steamHashName);
  const raw = await client.request('c5', 'batch', url, { body: JSON.stringify({ appId: '730', marketHashNames: names }) });
  return parseC5(raw, names);
}
export async function steamQuote(client, item) {
  const listing = new URL('https://steamcommunity.com/market/listings/730/' + encodeURIComponent(item.steamHashName));
  const id = parseItemNameId(await client.request('steam', item.id + ':id', listing), item.steamHashName);
  const url = new URL('https://steamcommunity.com/market/itemordershistogram');
  url.search = new URLSearchParams({ country: 'CN', language: 'english', currency: '23', item_nameid: id, two_factor: '0' });
  return { ...parseBuyOrders(await client.request('steam', item.id + ':bid', url)), itemNameId: id };
}
export function estimate(c5, steam, fees) {
  if (c5.status !== 'ok' || steam.status !== 'ok') return { status: 'unavailable', reason: 'missing_current_quote' };
  if (fees?.verified !== true || typeof fees.version !== 'string' || !fees.version || !fees.evidenceUrl?.startsWith('https://') ||
      !Number.isSafeInteger(fees.c5BuyerFeeCents) || fees.c5BuyerFeeCents < 0) return { status: 'unavailable', reason: 'fee_unverified' };
  try {
    const fee = sellerNet(steam.grossCents, fees.wallet), cash = c5.listingCents + fees.c5BuyerFeeCents;
    if (!positive(cash)) fail('invalid_money');
    return { status: 'quote_estimate_only', feeVersion: fees.version, cashCostCents: cash,
      netSteamCents: fee.netCents, steamFeeCents: fee.steamFeeCents, publisherFeeCents: fee.publisherFeeCents,
      executable: false, reason: 'account_sale_eligibility_and_fill_not_verified' };
  } catch (e) { return { status: 'unavailable', reason: e.code ?? 'fee_unverified' }; }
}
