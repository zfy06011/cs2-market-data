import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';

export class SafeError extends Error {
  constructor(code, httpStatus = null) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
export const fail = code => { throw new SafeError(code); };
export const positive = n => Number.isSafeInteger(n) && n > 0;
export const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function money(value, numericToken = false) {
  const text = String(value);
  if (text.length > 100) fail('invalid_money');
  const m = numericToken ? /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text)
    : /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) fail('invalid_money');
  const exponent = 2 + Number(m[3] ?? 0) - (m[2]?.length ?? 0);
  if (Math.abs(exponent) > 100) fail('invalid_money');
  let n = BigInt(m[1] + (m[2] ?? ''));
  if (exponent >= 0) n *= 10n ** BigInt(exponent);
  else { const d = 10n ** BigInt(-exponent); if (n % d) fail('invalid_money'); n /= d; }
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_money');
  return Number(n);
}

// Integer fee algorithm adapted from the user's cs2-balance-mobile-ui, af51ed1.
export function feeTotal(net, wallet) {
  if (!positive(net) || !positive(wallet?.minimumCents) || wallet.incrementCents !== 1 ||
      wallet.steamBasisPoints !== 500 || wallet.publisherBasisPoints !== 1000) fail('fee_unverified');
  const minimum = BigInt(wallet.minimumCents), n = BigInt(net);
  const part = rate => { const p = n * BigInt(rate) / 10000n; return p < minimum ? minimum : p; };
  const steamFee = part(500), publisherFee = part(1000), base = n < minimum ? minimum : n;
  const gross = base + steamFee + publisherFee;
  if (gross > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_money');
  return { netCents: Number(base), steamFeeCents: Number(steamFee), publisherFeeCents: Number(publisherFee), grossCents: Number(gross) };
}
export function sellerNet(gross, wallet) {
  if (!positive(gross)) fail('invalid_money');
  feeTotal(1, wallet);
  let lo = wallet.minimumCents, hi = gross, best = null;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2), fee = feeTotal(mid, wallet);
    if (fee.grossCents <= gross) { best = fee; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best || best.grossCents !== gross) fail('fee_inverse_ambiguous');
  return best;
}
export function retryAfter(value, now) {
  if (value == null) return null;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 && now + ms <= 8640000000000000 ? ms : null;
}

// No cookies, redirects, proxy credentials, response-body logs or server messages.
export function transport(url, { body = null, timeoutMs = 20000 } = {}) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['steamcommunity.com', 'openapi.c5game.com'].includes(url.hostname)) fail('endpoint_not_allowed');
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: body ? 'POST' : 'GET', headers: {
      'User-Agent': 'cs2-market-data/0.1 (+https://github.com/zfy06011/cs2-market-data)',
      Accept: 'application/json,text/html', 'Accept-Encoding': 'gzip, br, zstd, deflate',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
    } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 3000000) req.destroy(new SafeError('response_too_large')); else chunks.push(chunk); });
      res.on('aborted', () => reject(new SafeError('network')));
      res.on('error', () => reject(new SafeError('network')));
      res.on('end', () => {
        try {
          let bytes = Buffer.concat(chunks);
          const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync, zstd: zstdDecompressSync };
          const encoding = res.headers['content-encoding'];
          if (decoders[encoding]) bytes = decoders[encoding](bytes, { maxOutputLength: 6000000 });
          else if (encoding && encoding !== 'identity') fail('decode');
          resolve({ status: res.statusCode, headers: res.headers, text: bytes.toString('utf8') });
        } catch { reject(new SafeError('decode')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new SafeError('timeout')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', err => reject(err instanceof SafeError ? err : new SafeError('network')));
    if (body) req.write(body);
    req.end();
  });
}

export class Client {
  constructor({ send = transport, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
    state = { cooldowns: {}, lastRequests: {} }, checkpoint = async () => {} } = {}) {
    this.send = send; this.clock = clock; this.sleep = sleep; this.state = structuredClone(state);
    this.checkpoint = checkpoint; this.queue = Promise.resolve(); this.inflight = new Map();
    this.stopped = new Set(); this.requests = 0; this.deadline = clock() + 25 * 60000;
  }
  request(source, key, url, options) {
    if (!['steam', 'c5'].includes(source)) fail('invalid_source');
    const id = source + ':' + key;
    if (this.inflight.has(id)) return this.inflight.get(id);
    const p = this.queue.then(() => this.run(source, url, options));
    this.queue = p.catch(() => {}); this.inflight.set(id, p);
    p.then(() => this.inflight.delete(id), () => this.inflight.delete(id)); return p;
  }
  async run(source, url, options) {
    if (this.stopped.has(source) || (this.state.cooldowns[source] ?? 0) > this.clock()) fail('cooldown');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.clock() >= this.deadline || this.requests >= 100) fail('run_limit');
      const wait = 3000 - (this.clock() - (this.state.lastRequests[source] ?? -Infinity));
      if (wait > 0) await this.sleep(wait);
      this.state.lastRequests[source] = this.clock(); this.requests++;
      let r;
      try { r = await this.send(url, options); } catch (e) { throw e instanceof SafeError ? e : new SafeError('network'); }
      if (r.status === 429) {
        this.stopped.add(source);
        this.state.cooldowns[source] = this.clock() + Math.max(1000, retryAfter(r.headers['retry-after'], this.clock()) ?? 900000);
        await this.checkpoint(this.state); throw new SafeError('rate_limited', 429);
      }
      if (r.status >= 500 && r.status <= 599) {
        const delay = Math.max(retryAfter(r.headers['retry-after'], this.clock()) ?? 0, 2000 * 2 ** attempt);
        if (delay > 60000 || attempt === 2) {
          this.stopped.add(source); this.state.cooldowns[source] = this.clock() + Math.max(delay, 60000);
          await this.checkpoint(this.state); throw new SafeError('server_cooldown', r.status);
        }
        await this.sleep(delay); continue;
      }
      if (r.status === 401 || r.status === 403) { this.stopped.add(source); throw new SafeError('auth_or_access', r.status); }
      if (r.status < 200 || r.status >= 300) throw new SafeError('http', r.status);
      return r.text;
    }
  }
}
