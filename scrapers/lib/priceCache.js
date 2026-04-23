'use strict';

/**
 * Persistent price cache backed by Supabase.
 *
 * - Stores fetched closing prices so re-runs don't re-fetch the same data.
 * - Dead ticker list: tracks tickers that consistently return nothing across runs.
 *   After DEAD_THRESHOLD consecutive misses, the ticker is suppressed for DEAD_TTL_DAYS.
 *
 * Usage in track-performance:
 *   const pc = new PriceCache(supabase);
 *   await pc.load();
 *   const prices = await pc.fetchRange(ticker, countryCode, from, to, fetchFn);
 *   // prices is [] if dead, or [{date, price}] from cache/Yahoo
 */

const DEAD_THRESHOLD = 3;   // misses before declaring dead
const DEAD_TTL_DAYS  = 30;  // days to suppress a dead ticker before retrying

class PriceCache {
  constructor(supabase) {
    this.sb = supabase;
    // In-memory indexes populated by load()
    this._prices = new Map();       // `${ticker}:${date}` → price
    this._dead   = new Map();       // ticker → { misses, last_miss }
    this._hits   = new Map();       // ticker → consecutive hit count (resets dead counter)
    this._dirty  = [];              // new price rows to flush
    this._deadDirty = [];           // new dead-ticker updates to flush
  }

  /** Load cache state from Supabase. Call once before the processing loop. */
  async load() {
    // Load recent prices (last 400 days is enough — oldest horizon is 365d)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 400);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let from = 0;
    while (true) {
      const { data, error } = await this.sb
        .from('price_cache')
        .select('ticker, price_date, close_price')
        .gte('price_date', cutoffStr)
        .range(from, from + 999);
      if (error) {
        // Table doesn't exist yet — run migrations/003_price_cache.sql in Supabase dashboard
        console.log('  PriceCache: tables not yet created — run migrations/003_price_cache.sql');
        this._disabled = true;
        return;
      }
      if (!data || data.length === 0) break;
      for (const r of data) this._prices.set(`${r.ticker}:${r.price_date}`, r.close_price);
      if (data.length < 1000) break;
      from += 1000;
    }

    // Load dead ticker list
    const { data: dead } = await this.sb
      .from('ticker_dead_list')
      .select('ticker, country_code, reason, added_at');
    for (const r of dead || []) {
      this._dead.set(r.ticker, {
        reason: r.reason,
        addedAt: new Date(r.added_at),
        misses: DEAD_THRESHOLD,
      });
    }

    console.log(`  PriceCache: ${this._prices.size} prices, ${this._dead.size} dead tickers loaded`);
  }

  /**
   * Get prices for a ticker over a date range.
   * Returns cached results if available, otherwise calls fetchFn (Yahoo).
   * Stores new prices into dirty buffer for batch flush.
   *
   * @param {string} ticker - e.g. "ASML.AS", "SHA0.DE"
   * @param {string} symbol - the Yahoo symbol (ticker+suffix)
   * @param {string} fromStr - YYYY-MM-DD
   * @param {string} toStr   - YYYY-MM-DD
   * @param {Function} fetchFn - async (symbol, from, to) => [{date, price}]
   * @returns {Promise<Array<{date:string, price:number}>>}
   */
  async fetchRange(ticker, symbol, fromStr, toStr, fetchFn) {
    // If tables don't exist yet, pass straight through to Yahoo
    if (this._disabled) return fetchFn(symbol, fromStr, toStr);

    // Dead check — respect TTL
    const dead = this._dead.get(ticker);
    if (dead) {
      const daysSinceDead = (Date.now() - dead.addedAt.getTime()) / 86400000;
      if (daysSinceDead < DEAD_TTL_DAYS) return [];
      // TTL expired — retry and remove from dead list
      this._dead.delete(ticker);
    }

    // Try to assemble from cache
    const cached = this._getFromCache(ticker, fromStr, toStr);
    if (cached !== null) return cached;

    // Fetch from source
    const data = await fetchFn(symbol, fromStr, toStr);

    if (data.length === 0) {
      this._recordMiss(ticker);
      return [];
    }

    // Record hit — reset miss counter
    this._hits.set(ticker, (this._hits.get(ticker) || 0) + 1);

    // Store in cache
    for (const { date, price } of data) {
      const key = `${ticker}:${date}`;
      if (!this._prices.has(key)) {
        this._prices.set(key, price);
        this._dirty.push({ ticker, price_date: date, close_price: price, source: 'yahoo' });
      }
    }

    return data;
  }

  /** Return cached prices between fromStr and toStr if we have any, null if none. */
  _getFromCache(ticker, fromStr, toStr) {
    const result = [];
    for (const [key, price] of this._prices) {
      if (!key.startsWith(ticker + ':')) continue;
      const date = key.slice(ticker.length + 1);
      if (date >= fromStr && date <= toStr) result.push({ date, price });
    }
    if (result.length === 0) return null;
    return result.sort((a, b) => a.date.localeCompare(b.date));
  }

  _recordMiss(ticker) {
    const existing = this._dead.get(ticker);
    const misses = existing ? (existing.misses || 1) + 1 : 1;

    if (misses >= DEAD_THRESHOLD) {
      const entry = { reason: `${misses} consecutive Yahoo misses`, addedAt: new Date() };
      this._dead.set(ticker, entry);
      this._deadDirty.push({ ticker, reason: entry.reason });
    } else {
      // Track intermediate misses without declaring dead
      this._dead.set(ticker, { misses, addedAt: new Date() });
    }
  }

  /** Flush dirty price rows to Supabase in batches. Call after processing loop. */
  async flush() {
    if (this._disabled) return;
    if (this._dirty.length > 0) {
      for (let i = 0; i < this._dirty.length; i += 500) {
        await this.sb.from('price_cache').upsert(this._dirty.slice(i, i + 500), { onConflict: 'ticker,price_date', ignoreDuplicates: true });
      }
      console.log(`  PriceCache: flushed ${this._dirty.length} new prices`);
      this._dirty = [];
    }

    if (this._deadDirty.length > 0) {
      await this.sb.from('ticker_dead_list')
        .upsert(this._deadDirty.map(d => ({
          ticker: d.ticker,
          reason: d.reason,
          added_at: new Date().toISOString(),
        })), { onConflict: 'ticker' });
      console.log(`  PriceCache: added ${this._deadDirty.length} dead tickers`);
      this._deadDirty = [];
    }
  }

  /** Remove a ticker from the dead list (e.g. after TICKER_MAP fix). */
  async revive(ticker) {
    this._dead.delete(ticker);
    await this.sb.from('ticker_dead_list').delete().eq('ticker', ticker);
  }
}

module.exports = { PriceCache };
