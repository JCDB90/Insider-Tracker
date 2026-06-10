'use strict';
process.chdir(__dirname);
const https   = require('https');
const cheerio = require('./node_modules/cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function fetchHtml(path) {
  return new Promise((resolve) => {
    const req = https.get({ hostname: 'www.fsma.be', path, headers: HEADERS }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location || '';
        const newPath = loc.startsWith('http') ? new URL(loc).pathname + new URL(loc).search : loc;
        res.resume(); return resolve(fetchHtml(newPath));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

function extractField($, cssClass) {
  return $(`.field--name-${cssClass} .field__item`).first().text().trim()
      || $(`.field--name-${cssClass} time`).first().attr('datetime')?.slice(0, 10) || '';
}

(async () => {
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const qs = `/en/transaction-search?date%5Bmin%5D=${from}&date%5Bmax%5D=${to}`;
  console.log('List:', qs);
  const html = await fetchHtml(qs);
  if (!html) { console.log('Failed to fetch list'); process.exit(1); }

  const $ = cheerio.load(html);
  const links = [];
  $('a[href^="/en/manager-transaction/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!links.includes(href)) links.push(href);
  });
  console.log(`Found ${links.length} links\n`);

  for (const link of links) {
    const dhtml = await fetchHtml(link);
    if (!dhtml) { console.log(`SKIP fetch-fail: ${link}`); continue; }
    const d = cheerio.load(dhtml);
    const company = extractField(d, 'field-ct-issuer');
    const person  = extractField(d, 'field-ct-declarer-name');
    const txDate  = d('.field--name-field-ct-transaction-date time').first().attr('datetime')?.slice(0, 10)
                 || extractField(d, 'field-ct-date-time');
    const pubDate = extractField(d, 'field-ct-date-time');
    const txType  = extractField(d, 'field-ct-transaction-type');
    const sharesEl = d('.field--name-field-ct-transaction-quantity .field__item').first();
    const priceEl  = d('.field--name-field-ct-price .field__item').first();
    const shares = sharesEl.attr('content') || sharesEl.text().trim();
    const price  = priceEl.attr('content') || priceEl.text().trim();
    console.log(`${link}`);
    console.log(`  company=${company} | person=${person}`);
    console.log(`  pubDate=${pubDate} | txDate=${txDate} | type=${txType} | shares=${shares} | price=${price}`);
    await new Promise(r => setTimeout(r, 300));
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
