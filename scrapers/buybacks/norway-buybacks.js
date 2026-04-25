'use strict';
/**
 * NO — Share Buyback Scraper
 *
 * Source: Oslo Bors / Euronext Oslo — NewsWeb (api3.oslo.oslobors.no)
 * Category: 1007 — "Acquisition or Disposal of an Issuer's Own Shares"
 *
 * Companies file daily or weekly buyback execution reports as plain-text
 * announcements with ASCII tables:
 *
 *   +----------+-------+-------------------+-------------------+
 *   | Trading  |Number | Weighted average  |Total cost, EUR    |
 *   | venue    |shares |price / share, EUR |                   |
 *   +----------+-------+-------------------+-------------------+
 *   |XHEL      |233,667|15.69              |3,666,819.40       |
 *   |Total     |425,142|15.68              |6,665,154.53       |
 *   +----------+-------+-------------------+-------------------+
 *
 * We parse the Total row for aggregate shares, avg price, total value.
 * One DB row saved per filing (one per company per day/week).
 */

const https   = require('https');
const { saveBuybackPrograms } = require('../lib/db');

const COUNTRY_CODE   = 'NO';
const SOURCE         = 'Oslo Bors / Euronext Oslo';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const BUYBACK_CAT_ID = 1007;
const NEWSWEB_BASE   = 'https://newsweb.oslobors.no';
const API_BASE       = 'https://api3.oslo.oslobors.no';
const DELAY_MS       = 300;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function parseNum(s) {
  if (!s && s !== 0) return null;
  const str = String(s).trim().replace(/\s/g, '');
  if (!str) return null;
  if (/\d\.\d{3},\d/.test(str)) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(\.\d{3})+$/.test(str)) return parseFloat(str.replace(/\./g, ''));
  if (/\d,\d{3}\./.test(str)) return parseFloat(str.replace(/,/g, ''));
  if (/,/.test(str) && !/\./.test(str)) {
    const parts = str.split(',');
    if (parts.length > 2 || (parts[1] && parts[1].length === 3)) return parseFloat(str.replace(/,/g, ''));
    return parseFloat(str.replace(',', '.'));
  }
  return parseFloat(str);
}

const HEADERS = {
  'Accept': 'application/json',
  'Origin': NEWSWEB_BASE,
  'Referer': `${NEWSWEB_BASE}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

function getJson(url) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Parse buyback message body ────────────────────────────────────────────────

function parseBuybackBody(body, issuerName, issuerSign, msgDate) {
  if (!body || typeof body !== 'string') return null;

  const text = body.replace(/\r\n?/g, '\n');

  // Detect currency from table header: "Total cost, EUR" / "NOK" / "GBP" etc.
  const currM = text.match(/Total\s+cost[,\s]+([A-Z]{3})/i)
             || text.match(/(?:price|kurs)[,\s]+([A-Z]{3})(?:\s*\*|\s*\n|\s+per)/i)
             || text.match(/\b(NOK|EUR|USD|GBP|SEK|DKK|CHF)\b/);
  const currency = currM ? currM[1].toUpperCase() : 'NOK';

  // Parse Total row from ASCII table:
  // |Total     |425,142|15.68              |6,665,154.53       |
  const totalRowM = text.match(
    /\|\s*Total\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|/i
  );

  let sharesBought = null, avgPrice = null, totalValue = null;

  if (totalRowM) {
    // Nordea / pipe-table format: |Total |425,142|15.68|6,665,154.53|
    sharesBought = Math.round(parseNum(totalRowM[1]) || 0) || null;
    avgPrice     = parseNum(totalRowM[2]);
    totalValue   = parseNum(totalRowM[3]);
  }

  // Tieto / Helsinki space-table format:
  // "Total                  51 800    15.78"  (no pipes, space-separated)
  if (!sharesBought) {
    const spaceTotal = text.match(/^Total\s+([\d ,]+)\s+([\d.,]+)/im)
                    || text.match(/\bTotal\b\s+([\d ,]+)\s+([\d.,]+)/im);
    if (spaceTotal) {
      sharesBought = Math.round(parseNum(spaceTotal[1]) || 0) || null;
      avgPrice     = parseNum(spaceTotal[2]);
      totalValue   = (sharesBought && avgPrice) ? Math.round(sharesBought * avgPrice) : null;
    }
  }

  // Prose format: "X shares ... at a price of NOK Y" or "bought back X shares at Y"
  if (!sharesBought) {
    const proseSharesM = text.match(/([\d, ]+)\s+(?:own\s+)?shares?\s+(?:at|for|@)/i);
    const prosePriceM  = text.match(/(?:at|price\s+of|average\s+price\s+of)\s+(?:NOK|EUR|GBP|USD|SEK|DKK)?\s*([\d.,]+)\s*(?:per\s+share)?/i);
    if (proseSharesM) sharesBought = Math.round(parseNum(proseSharesM[1]) || 0) || null;
    if (prosePriceM)  avgPrice     = parseNum(prosePriceM[1]);
    if (sharesBought && avgPrice)  totalValue = Math.round(sharesBought * avgPrice);
  }

  // Generic fallback: pipe-table rows sum
  if (!sharesBought) {
    const rowRe = /\|\s*[A-Z]{3,5}\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|/g;
    let totalShares = 0, totalCost = 0, count = 0;
    let m;
    while ((m = rowRe.exec(text)) !== null) {
      const s = parseNum(m[1]);
      const c = parseNum(m[3]);
      if (s && c) { totalShares += s; totalCost += c; count++; }
    }
    if (count > 0) {
      sharesBought = Math.round(totalShares);
      totalValue   = Math.round(totalCost * 100) / 100;
      avgPrice     = sharesBought > 0 ? Math.round((totalCost / totalShares) * 10000) / 10000 : null;
    }
  }

  // Extract execution date from body text
  // "on 10.04.2026" or "10 April 2026" or from title "on 10.04.2026"
  let execDate = msgDate;
  const dateM = text.match(/on\s+(\d{1,2})[./](\d{1,2})[./](\d{4})/i)
             || text.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (dateM) {
    if (dateM[0].includes('/') || dateM[0].includes('.')) {
      const [, dd, mm, yyyy] = dateM;
      execDate = `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    } else {
      const moMap = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
      execDate = `${dateM[3]}-${String(moMap[dateM[2].toLowerCase()]).padStart(2,'0')}-${String(dateM[1]).padStart(2,'0')}`;
    }
  }

  // Extract program completion info
  // "amounts to 2,829,295,540 Euros, which represents approximately 56.3 % of the maximum"
  const pctM = text.match(/([\d.]+)\s*%\s+of\s+the\s+maximum/i);
  const completionPct = pctM ? parseFloat(pctM[1]) : null;

  // Extract ISIN
  const isinM = text.match(/(?:ISIN|isin)[:\s]+([A-Z]{2}[A-Z0-9]{10})/i);
  const isin  = isinM ? isinM[1] : null;

  if (!sharesBought && !totalValue) return null;

  return {
    currency,
    shares_bought:    sharesBought,
    avg_price:        avgPrice,
    total_value:      totalValue ? Math.round(totalValue) : null,
    execution_date:   execDate,
    completion_pct:   completionPct,
    isin,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeNOBuybacks() {
  console.log('🇳🇴  Oslo Bors — Share Buyback Programs (category 1007)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const listData = await getJson(
    `${API_BASE}/v1/newsreader/list?category=${BUYBACK_CAT_ID}&fromDate=${from}&toDate=${to}`
  );

  const messages = listData?.data?.messages || [];
  console.log(`  Found ${messages.length} buyback filings`);

  if (!messages.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen   = new Set();
  const dbRows = [];
  let   parsed = 0, skipped = 0;

  for (const msg of messages) {
    const msgId   = msg.messageId;
    const filingId = `NO-BUY-${msgId}`;
    if (seen.has(filingId)) continue;
    seen.add(filingId);

    // Fetch message body
    const detail = await getJson(
      `${API_BASE}/v1/newsreader/message?messageId=${msgId}`
    );
    await delay(DELAY_MS);

    const body    = detail?.data?.message?.body || '';
    const msgDate = (msg.publishedTime || '').slice(0, 10);
    const result  = parseBuybackBody(body, msg.issuerName, msg.issuerSign, msgDate);

    if (!result) { skipped++; continue; }

    parsed++;
    dbRows.push({
      filing_id:      filingId,
      country_code:   COUNTRY_CODE,
      ticker:         msg.issuerSign  || null,
      company:        msg.issuerName  || null,
      announced_date: result.execution_date || msgDate,
      execution_date: result.execution_date || msgDate,
      shares_bought:  result.shares_bought,
      avg_price:      result.avg_price,
      total_value:    result.total_value,
      currency:       result.currency,
      completion_pct: result.completion_pct,
      status:         'Active',
      filing_url:     `${NEWSWEB_BASE}/message/${msgId}`,
      source_url:     `${NEWSWEB_BASE}/message/${msgId}`,
      source:         SOURCE,
    });
  }

  console.log(`  Parsed: ${parsed}, Skipped (no data): ${skipped}`);

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { inserted, error } = await saveBuybackPrograms(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  console.log(`  Sample: ${dbRows.slice(0,3).map(r=>`${r.company} ${r.shares_bought?.toLocaleString()} shares @ ${r.avg_price} ${r.currency}`).join('; ')}`);
  return { saved: dbRows.length };
}

scrapeNOBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
