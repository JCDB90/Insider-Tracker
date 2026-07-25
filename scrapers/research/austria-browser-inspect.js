/**
 * Research script (NOT part of the scraping pipeline) — Puppeteer-driven network
 * inspection of my.oekb.at's Angular portal, used to discover the real (undocumented)
 * REST API behind the "OAM Issuer Info" list/detail/download UI. Not wired into CI;
 * run manually.
 *
 * Discovered chain (confirmed working, no auth required):
 *   1. List/search:  GET https://my.oekb.at/issuer-info/rest/public/meldedaten/iic
 *                     ?spalte=uploadDatum&sortDirection=-1&status=VEROEFFENTLICHT
 *                     &startPosition=0&offset=10&locale=DE
 *      -> { anzahlTreffer, dokumente: [{ id, emittent, titel, meldetypCode,
 *            uploadzeitpunkt, dateien: [{ id, dateiname, sizeInKB }] }, ...] }
 *      meldetypCode 'EP_EIGENGESCHAEFT_VON_FUEHRUNGSKRAFT' = Art. 19 MAR managers'
 *      transactions. A guessed `meldetypCode=` query param on this endpoint is a
 *      no-op (server ignores it, ignore-tested against EP_QUARTALBER) — filter
 *      client-side after fetching, same pattern used elsewhere in this codebase.
 *   2. Detail (not actually needed — the list response already has `dateien`):
 *      GET https://my.oekb.at/issuer-info/rest/public/meldedaten/meldung/{id}
 *   3. PDF download: GET https://my.oekb.at/issuer-info/rest/public/meldedaten/download/{fileId}
 *      (fileId = dateien[0].id from step 1, NOT the document id itself)
 *
 * Verified live: this download endpoint serves the underlying PDF regardless of which
 * newswire (EQS or PTA) originally distributed the announcement — real, native-text
 * PDFs confirmed for both an EQS-DD (Kontron AG) and a PTA-DD (Zumtobel Group AG)
 * filing, both following the standard EU MAR Art. 19 form structure.
 */
'use strict';

const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  const requests = [];
  page.on('request', (req) => {
    if (req.url().includes('oekb.at')) requests.push({ url: req.url(), method: req.method() });
  });
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('oekb.at') && (url.includes('.pdf') || url.toLowerCase().includes('datei') || url.toLowerCase().includes('download') || url.toLowerCase().includes('anhang'))) {
      console.log(`RESP: ${response.status()} ${(response.headers()['content-type'] || '')} ${url}`);
    }
  });

  // A known Article 19 filing (Kontron AG / ENNOCONN CORPORATION) — doc-id from the
  // list endpoint's `dokumente[].id`.
  await page.goto('https://my.oekb.at/kapitalmarkt-services/kms-output/oamn/iic/detail?doc-id=250616', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  // The portal gates all content behind a one-time disclaimer modal.
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a')];
    const btn = btns.find(b => /ZUR KENNTNIS GENOMMEN/i.test(b.textContent));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 2000));

  console.log('Clicking PDF button...');
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => /\.pdf/i.test(b.textContent));
    if (btn) { btn.click(); return true; }
    return false;
  });
  console.log('PDF button clicked:', clicked);
  await new Promise(r => setTimeout(r, 4000));

  console.log('\n--- ALL requests containing rest/ or .pdf ---');
  requests.filter(r => r.url.includes('/rest/') || r.url.includes('.pdf')).forEach(r => console.log(r.method, r.url));

  await browser.close();
})().catch(e => console.error('FATAL:', e.message));
