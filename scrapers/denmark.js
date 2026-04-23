/**
 * DK — Insider Transactions Scraper
 *
 * Source: Nasdaq Copenhagen — Managers' Transactions (MAR Article 19)
 * API:    https://api.news.eu.nasdaq.com/news/query.action (JSONP)
 *         market=Main+Market%2C+Copenhagen
 *         cnsCategory=Managers%27+Transactions
 *
 * Full notification HTML fetched from view.news.eu.nasdaq.com for structured data.
 * Returns up to 200 items per page; paginated via start= offset.
 */
'use strict';

const https      = require('https');
const { execSync } = require('child_process');
const os         = require('os');
const fs         = require('fs');
const path       = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');
const { looksLikeCorp }          = require('./lib/entityUtils');

const COUNTRY_CODE   = 'DK';
const SOURCE         = 'Nasdaq Copenhagen / MAR';
const RETENTION_DAYS = 90;
const CURRENCY       = 'DKK';
const MARKET         = 'Main Market, Copenhagen';
const CONCURRENCY    = 4;  // reduced: each notification may also fetch a PDF attachment

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  // SELL first: "tilbagekøb" (buyback) contains "køb" (buy) — check disposal/salg before køb/buy
  if (l.includes('dispos') || l.includes('sale') || l.includes('sell') ||
      l.includes('salg') || l.includes('afstå') || l.includes('tilbagekøb')) return 'SELL';
  if (l.includes('acqui') || l.includes('receipt') || l.includes('grant') ||
      l.includes('subscribe') || l.includes('exercise') ||
      /\bbuy\b/.test(l) || /\bkøb\b/.test(l) ||
      l.includes('tildeling') || l.includes('tegning') || l.includes('udnyttelse')) return 'BUY';
  return 'OTHER';
}

// Parse numbers in both Danish (period=thousands, comma=decimal) and English formats
function parseNum(raw) {
  if (!raw) return NaN;
  const s = raw.trim().replace(/\s/g, '');
  if (/\d\.\d{3},/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.'));   // 1.234,56
  if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g, ''));          // 22.345 (thousands)
  if (/^\d{1,3}(?:,\d{3})+$/.test(s)) return parseFloat(s.replace(/,/g, ''));             // 50,000 (English thousands)
  if (/,/.test(s) && !/\./.test(s)) return parseFloat(s.replace(',', '.'));               // 61,7088 (decimal)
  return parseFloat(s.replace(/,/g, ''));
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function grabAfter(text, ...patterns) {
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
}

function parseNotificationText(text) {
  // ── Try structured MAR form first (used by Finnish-style disclosures on DK market) ──
  let insiderName = grabAfter(text,
    // ESMA section 1.1 — PDF with -layout renders "1.1  Name of the person   John Smith" on one line
    /1\.1\s+\S[^\n]*?([A-ZÆØÅÄÖÜ][a-zA-ZæøåÆØÅäöüÄÖÜ\-]+(?:\s+[A-ZÆØÅÄÖÜ][a-zA-ZæøåÆØÅäöüÄÖÜ\-]+){1,3})\s*$/m,
    /1\.1\b[^\n]*\n[ \t]*([A-ZÆØÅÄÖÜ][a-zA-ZæøåÆØÅäöüÄÖÜ\-]+(?:\s+[A-ZÆØÅÄÖÜ][a-zA-ZæøåÆØÅäöüÄÖÜ\-]+){1,3})\s*\n/m,
    // Tabular ESMA form: "a)   Name                     John Smith"
    /\ba\)\s+Name\s{2,}([^\n]{2,80})/im,
    // Danish ESMA form: "a)   Navn\n                      Christian Herskind Jørgensen"
    /\ba\)\s+Navn\s*\n\s+([A-ZÆØÅ][^\n]{1,80})/im,
    /\bName\s*[:|]\s*([A-Z][^\n|:]{2,60}?)(?:\s*[|:]|\s{2,}|\s*Position)/i,
    /1\s*\.?\s*1\s+Name\s+([^\n|]{2,60})/i,
    /\bName\s*[:|]\s*([A-Z][a-zA-ZæøåäöüÆØÅÄÖÜ\-\s]{2,50})/i,
  );

  let insiderRole = grabAfter(text,
    // ESMA section 1.2 with -layout: "1.2  Position/status   CEO" on one line
    /1\.2\s+\S[^\n]*?([A-Z][a-zA-Z\s\-\/]{2,60}?)\s*$/m,
    /1\.2\b[^\n]*\n[ \t]*([A-Z][a-zA-Z\s\-\/]{2,60})\s*\n/m,
    // Tabular ESMA form: "a)   Position/status          CEO"
    /\ba\)\s+Position\/status\s{2,}([A-Z][a-zA-Z\s\-\/]{2,79}?)(?:\.|,|\n)/im,
    // Danish: "a)   Stilling/titel\n                      Direktør og bestyrelsesmedlem"
    /\ba\)\s+Stilling\/titel\s*\n\s+([^\n]{2,80})/im,
    // Also Danish "Occupation / title" fallback
    /\ba\)\s+Occupation\s*\/\s*title\s{2,}([A-Z][a-zA-Z\s\-\/]{2,79}?)(?:\.|,|\n)/im,
    /\bPosition\s*[:|]\s*([^\n|]+?)(?=\s+(?:Issuer|LEI|ISIN|Reference|Notification type|Name)\s*[:|])/i,
    /Position\s*\/\s*status\s*[:|]\s*([^\n|]{2,80})/i,
  );
  // Don't use role if it's a long descriptive sentence (closely-related-party explanations)
  if (insiderRole && insiderRole.length > 80) insiderRole = null;

  // ── Prose fallback: "X notifies [Company] that X has..." or "...that X, Chairman..." ──
  if (!insiderName) {
    // "where Flemming Nyenstad Enevoldsen notifies" or "that John Smith has..."
    insiderName = grabAfter(text,
      /where\s+([A-Z][a-zA-ZæøåÆØÅ\-]+(?:\s+[A-Z][a-zA-ZæøåÆØÅ\-]+){1,3})\s+notifies/,
      /that\s+([A-Z][a-zA-ZæøåÆØÅ\-]+(?:\s+[A-Z][a-zA-ZæøåÆØÅ\-]+){1,3})\s+(?:has|have)\s+(?:purchased|sold|acquired|disposed|increased|decreased)/i,
      /\bNotification\s+from\s+([A-Z][a-zA-ZæøåÆØÅ\-]+(?:\s+[A-Z][a-zA-ZæøåÆØÅ\-]+){1,3})\b/,
    );
  }

  // Nordic name character class: ASCII letters + Nordic/Germanic accented chars
  const NC = '[a-zA-ZæøåÆØÅäöüÄÖÜ\\-]';

  // ── Free-text: "Group CTO Mikael Kärrsten has been granted 44 shares" ──
  // Pattern: known title + Name + has been granted/sold/awarded
  if (!insiderName) {
    const titleNameMatch = text.match(
      new RegExp(`(?:Group\\s+)?(?:CEO|CFO|CTO|COO|CMO|CSO|CRO|President|Chairman|Vice\\s+President|Head\\s+of\\s+\\S+|Director)\\s+(${NC}+(?:\\s+${NC}+){1,3})\\s+has\\s+been`, 'i')
    );
    if (titleNameMatch) insiderName = titleNameMatch[1].trim();
  }

  // ── Free-text: "primary insider Are Dragesund" ──
  if (!insiderName) {
    insiderName = grabAfter(text,
      new RegExp(`primary\\s+insider\\s+(${NC}+(?:\\s+${NC}+){1,3})`, 'i'),
      new RegExp(`insider[,]?\\s+(${NC}+(?:\\s+${NC}+){1,3})\\b`, 'i'),
    );
  }

  if (!insiderRole) {
    // "is (the) Chairman/CEO/Director of" or "is a member of the board"
    insiderRole = grabAfter(text,
      /(?:is|as)\s+(?:the\s+)?([A-Z][a-zA-Z\s\-]{3,50}?)\s+(?:of|in)\s+[A-Z]/,
      /(?:is\s+a\s+)(member\s+of\s+the\s+board[^,.]*)/i,
      /(?:serving\s+as\s+|appointed\s+(?:as\s+)?)(CEO|CFO|CTO|COO|President|Chairman|Director|[A-Z][a-z]+\s+(?:Executive|Officer|Director|Manager)[^,.]*)/i,
    );
  }

  // ── Free-text role: "board member" ──
  if (!insiderRole) {
    insiderRole = grabAfter(text,
      /(?:close\s+associate\s+of\s+)?(board\s+member)/i,
    );
  }

  const isin = grabAfter(text,
    /4\.3\b[^\n]*?([A-Z]{2}[A-Z0-9]{10})\b/im,   // ESMA section 4.3 ISIN
    /\bISIN\s*[:|]\s*([A-Z]{2}[A-Z0-9]{10})/i,
    /ISIN\s+code\s*[:|]\s*([A-Z]{2}[A-Z0-9]{10})/i,
    /\b(DK[A-Z0-9]{10})\b/,  // DK ISIN without label
  );

  const nature = grabAfter(text,
    /Nature\s+of\s+(?:the\s+)?transaction\s*[:|]\s*([^\n|]+?)(?=\s+Transaction\s+details|\s+Volume|\s*$)/i,
    /Nature\s+of\s+(?:the\s+)?transaction\s*[:|]\s*([^\n|]{2,120})/i,
    // Tabular ESMA form: "Nature of the            Sale"
    /Nature\s+of\s+the\b[^\n]*(Sale|Acquisition|Disposal|Subscription|Exercise|Grant|Award)\b/im,
    /\bNature\s+of\s+the\b[^\n]*?([A-Z][a-z]{2,}(?:ition|al|ion|ise|ize|ase|ent)?)\s*$/im,
    // Danish: "b)   Transaktionens art\n                      Salg af aktier..."
    /\bb\)\s+Transaktionens\s+art\s*\n\s+([^\n]{2,120})/im,
    // Danish: "b)   Transaction type\n                      Sale..."
    /\bb\)\s+Transaction\s+type\s*\n\s+([^\n]{2,120})/im,
  );

  const txDateRaw = grabAfter(text,
    /(?:Transaction date|Date of (?:the )?transaction)\s*[:|]\s*(\d{4}-\d{2}-\d{2})/i,
    /(?:Transaction date|Date of (?:the )?transaction)\s*[:|]\s*(\d{2}[.\/-]\d{2}[.\/-]\d{4})/i,
    // Tabular ESMA form: "Date of the              2026-04-13"
    /Date\s+of\s+the\b[^\n]*(\d{4}-\d{2}-\d{2})/im,
    // Danish: "e)   Dato for transaktionen\n                      2026-04-16"
    /\be\)\s+Dato\s+for\s+transaktionen\s*\n\s*(\d{4}-\d{2}-\d{2})/im,
    /\btoday\b.*?(\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+\s+\d{4})/i,
  );
  let txDate = null;
  if (txDateRaw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(txDateRaw)) {
      txDate = txDateRaw;
    } else {
      const parts = txDateRaw.split(/[.\/-]/);
      if (parts.length === 3) txDate = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    }
  }

  // Volume: structured "Volume: 6187" or prose "purchasing 616 shares"
  // Also handle ESMA 5.3 "Volume and price" line: "1000 at 45.50" or "1,000 at 45.50"
  let shares = null;
  let _pdfPriceFromVol = null;
  const esma53 = text.match(/5\.3\b[^\n]*?([\d][\d\s,\.]*)\s+(?:at|@)\s+([\d,\.]+)/im);
  if (esma53) {
    const sv = parseFloat(esma53[1].replace(/[\s,]/g, ''));
    const pv = parseFloat(esma53[2].replace(/,/g, ''));
    if (!isNaN(sv) && sv > 0) shares = Math.round(sv);
    if (!isNaN(pv) && pv > 0) _pdfPriceFromVol = pv;
  }

  // Tabular ESMA form: "DKK 285.36                              2,160" on one line
  // Also Danish: "DKK 61,7088                         22.345" (comma=decimal, period=thousands in volume)
  if (!shares) {
    const priceVolLine = text.match(/(?:DKK|EUR|SEK|NOK|CHF)\s+([\d,\.]+)\s{3,}([\d,\.]+)\s*$/im);
    if (priceVolLine) {
      const pv = parseNum(priceVolLine[1]);
      const sv = parseNum(priceVolLine[2]);
      if (!isNaN(sv) && sv > 0) shares = Math.round(sv);
      if (!isNaN(pv) && pv > 0) _pdfPriceFromVol = pv;
    }
  }

  // Aggregated volume fallback: "— Aggregated\n      volume\n                 2,160"
  if (!shares) {
    const aggVol = text.match(/Aggregated\s+volume\s+([\d,]+)/im);
    if (!aggVol) {
      // Split across lines: "— Aggregated" then "volume" on next line, then value
      const aggSplit = text.match(/Aggregated\b[^\n]*\n[^\n]*volume\b[^\n]*\n\s*([\d,]+)/im);
      if (aggSplit) {
        const sv = parseFloat(aggSplit[1].replace(/,/g, ''));
        if (!isNaN(sv) && sv > 0) shares = Math.round(sv);
      }
    } else {
      const sv = parseFloat(aggVol[1].replace(/,/g, ''));
      if (!isNaN(sv) && sv > 0) shares = Math.round(sv);
    }
  }

  if (!shares) {
    const volRaw = grabAfter(text,
      /\bVolume\s*[:|]\s*([\d][\d\s,\.]*)/i,
      /(?:purchasing|selling|acquired|disposed\s+of|sold)\s+([\d][,\d\.]*)\s+shares/i,
      /(?:sale|purchase)\s+of\s+([\d][,\d\.]*)\s+shares/i,
      /been\s+(?:granted|awarded)\s+([\d][,\d\.]*)\s+(?:\S+\s+)?shares/i,
      /(?:increased|decreased)\s+(?:his|her|their|its)\s+shareholding.*?by\s+([\d][,\d\.]*)\s+shares/i,
    );
    if (volRaw) {
      const n = parseFloat(volRaw.replace(/[\s,]/g, ''));
      if (!isNaN(n) && n > 0) shares = Math.round(n);
    }
  }

  // Price: structured "Unit price: X" or prose "at DKK X" / "at a price of X"
  let price = null;
  let totalValue = null;
  const priceRaw = grabAfter(text,
    /Unit\s+price\s*[:|]\s*([\d,\.]+)(?!\s*N\/A)/i,
    /Price\s*\(s\)\s*[:|]\s*([\d,\.]+)/i,
    /at\s+(?:a\s+price\s+of\s+)?(?:DKK|EUR|SEK|NOK)\s*([\d,\.]+)/i,
    /at\s+(?:a\s+(?:share\s+)?price\s+of\s+)?([\d,\.]+)\s+(?:DKK|EUR|SEK|NOK)/i,
    /DKK\s*([\d,\.]+)\s+per\s+share/i,
  );
  if (!priceRaw && _pdfPriceFromVol) price = _pdfPriceFromVol;
  if (priceRaw) {
    const n = parseNum(priceRaw);
    if (!isNaN(n) && n > 0) price = n;
  }

  // Total value: "for a total amount of DKK X" or "at a total price of DKK X"
  // Also tabular: "DKK 616,377.60\n      — Price" or Danish "Aggregeret pris: DKK 1.378.883"
  const totalRaw = grabAfter(text,
    /(?:DKK|EUR|SEK|NOK|CHF)\s*([\d,\.]+)\s*\n[^\n]*—\s*Price/im,
    /Aggregeret\s+pris[^\n]*(?:DKK|EUR|SEK|NOK|CHF)\s*([\d,\.]+)/im,  // Danish aggregated price
    /total\s+(?:amount|price|consideration)\s+of\s+(?:DKK|EUR|SEK|NOK|CHF)\s*([\d,\.]+)/i,
    /(?:DKK|EUR|SEK|NOK|CHF)\s*([\d,\.]+)\s+(?:total|in total|aggregate)/i,
    /([\d,\.]+)\s+(?:DKK|EUR|SEK|NOK|CHF)\s*(?:total|in total)\b/i,
  );

  if (!price && totalRaw && shares) {
    const total = parseNum(totalRaw);
    if (!isNaN(total) && total > 0) {
      totalValue = Math.round(total);
      price = parseFloat((total / shares).toFixed(4));
    }
  } else if (totalRaw) {
    const total = parseNum(totalRaw);
    if (!isNaN(total) && total > 0) totalValue = Math.round(total);
  }

  // ── Clean ESMA boilerplate contamination from insider name ───────────────
  // Patterns observed in the wild:
  //   "Nilfisk Holding A/S b) LEI code ..."
  //   "Jon Sintorn 2. Reason for notification a) Occupation / title"
  //   "Kim Junge Andersen 2 Reason for the notification a)"
  //   "Jan Rindbo Reason ..."
  //   "Claus Fuglsang tobb@company.com ..."
  if (insiderName) {
    insiderName = insiderName
      .replace(/\s+b\)\s+LEI\b.*/i, '')                       // " b) LEI code ..."
      .replace(/\s+\d*\.?\s*Reason\b.*/i, '')                 // " 2. Reason ..." or " Reason for ..."
      .replace(/\s+a\)\s+(?:Occupation|Position|Title)\b.*/i, '')  // " a) Occupation / title ..."
      .replace(/\s+[\w.+-]+@[\w.-]+\.[a-z]{2,}\b.*/i, '')   // strip trailing email address
      .trim();
    if (!insiderName) insiderName = null;
  }

  // Normalise insider name: "Surname, Firstname" → "Firstname Surname"
  if (insiderName && insiderName.includes(',')) {
    const parts = insiderName.split(',').map(s => s.trim());
    if (parts.length === 2 && parts[1]) insiderName = `${parts[1]} ${parts[0]}`;
  }

  // If insiderName looks like a corporate entity, check ESMA section 2b for the associated person
  let viaEntity = null;
  if (insiderName && looksLikeCorp(insiderName)) {
    // English: "closely associated with [person]"
    // Danish: "[Corp]s CEO og bestyrelsesmedlem, Johanne C F Riegels, også er bestyrelsesmedlem"
    const assocM =
      text.match(/closely\s+associated\s+(?:with|to)\s+(?:person:\s*)?([A-ZÆØÅ][a-zA-ZæøåÆØÅ\s\-\.]{2,50}?)(?:,|\s+(?:CEO|CFO|Chair|Director|Board|President|Member|Vice)|\s*$)/im) ||
      text.match(/\brelated\s+party\s+to\s+(?:[A-Z][a-z]+\s+)?([A-ZÆØÅ][a-zA-ZæøåÆØÅ\s\-\.]{4,50}?)(?:\s+in\b|\s+at\b|$)/im) ||
      text.match(/\bbestyrelsesmedlem[,\s]+([A-ZÆØÅ][a-zA-ZæøåÆØÅ\s\-\.]{4,50?}?)(?:,\s+ogs)/i) ||
      text.match(/\b(?:CEO|CFO|direktør|bestyrelsesmedlem)\s+(?:og\s+\w+\s+)?([A-ZÆØÅ][a-zA-ZæøåÆØÅ\s\-\.]{4,50}?)(?:,\s+ogs|$)/im);
    if (assocM) {
      viaEntity   = insiderName;
      insiderName = assocM[1].trim();
    }
  }

  return { insiderName, viaEntity, insiderRole, isin, txDate, shares, price, totalValue, nature, transactionType: mapType(nature || '') };
}

function get(hostname, path, headers = {}, _redirects = 5) {
  return new Promise((resolve) => {
    const req = https.get({ hostname, path, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    }}, res => {
      // Follow redirects (Nasdaq view server returns 302 to language-specific URL)
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && _redirects > 0) {
        const loc = res.headers.location;
        const target = loc.startsWith('http') ? new URL(loc) : new URL(`https://${hostname}${loc}`);
        res.resume();
        return resolve(get(target.hostname, target.pathname + target.search, headers, _redirects - 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

// Download a URL as a binary Buffer (follows one redirect)
function getBinary(url, _redirects = 3) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*',
      },
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && _redirects > 0) {
        res.resume();
        return resolve(getBinary(res.headers.location, _redirects - 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

// Convert a PDF buffer to plain text using pdftotext -layout
function pdfBufToText(buf) {
  if (!buf || buf.length < 100) return null;
  const tmp = path.join(os.tmpdir(), `dk_esma_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmp, buf);
    const text = execSync(`/usr/bin/pdftotext -layout "${tmp}" -`, { timeout: 15000 }).toString('utf8');
    return text || null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function fetchNasdaqPage(fromDate, toDate, start) {
  const qs = new URLSearchParams({
    countResults: 'true',
    globalGroup: 'exchangeNotice',
    displayLanguage: 'en',
    timeZone: 'CET',
    dateMask: 'yyyy-MM-dd HH:mm:ss',
    limit: '200',
    start: String(start),
    dir: 'DESC',
    globalName: 'NordicAllMarkets',
    cnsCategory: "Managers' Transactions",
    market: MARKET,
    fromDate,
    toDate,
    callback: 'handleResponse',
  }).toString();

  const res = await get('api.news.eu.nasdaq.com', `/news/query.action?${qs}`);
  if (!res || res.status !== 200) return null;

  let body = res.body.trim();
  if (body.startsWith('handleResponse(')) {
    body = body.slice('handleResponse('.length);
    if (body.endsWith(')')) body = body.slice(0, -1);
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function fetchNotificationDetails(messageUrl) {
  try {
    const url = new URL(messageUrl);
    const res = await get(url.hostname, url.pathname + url.search, { 'Accept': 'text/html' });
    if (!res || res.status !== 200) return null;

    const rawHtml = res.body;
    const inline  = parseNotificationText(stripHtml(rawHtml));

    // If we already have shares and price from inline HTML, return immediately
    if (inline.shares && inline.price) return inline;

    // Extract PDF attachment URLs from raw HTML
    // Nasdaq viewer embeds links like: https://attachment.news.eu.nasdaq.com/abc123
    const pdfUrls = [];
    const pdfRe = /https:\/\/attachment\.news\.eu\.nasdaq\.com\/[a-z0-9]+/g;
    let m;
    while ((m = pdfRe.exec(rawHtml)) !== null) {
      if (!pdfUrls.includes(m[0])) pdfUrls.push(m[0]);
    }

    for (const pdfUrl of pdfUrls) {
      const buf  = await getBinary(pdfUrl);
      const text = pdfBufToText(buf);
      if (!text) continue;

      const fromPdf = parseNotificationText(text);

      // Determine if this PDF is a structured data form (vs. a cover letter).
      // Only a data form provides reliable ISIN, shares, or transaction date.
      const isDataForm = !!(fromPdf.isin || fromPdf.shares || fromPdf.txDate);

      // Merge: PDF values fill nulls from inline; don't overwrite existing values
      if (!inline.isin        && fromPdf.isin)        inline.isin        = fromPdf.isin;
      if (!inline.txDate      && fromPdf.txDate)      inline.txDate      = fromPdf.txDate;
      if (!inline.shares      && fromPdf.shares)      inline.shares      = fromPdf.shares;
      if (!inline.price       && fromPdf.price)       inline.price       = fromPdf.price;
      if (!inline.totalValue  && fromPdf.totalValue)  inline.totalValue  = fromPdf.totalValue;
      if (inline.transactionType === 'UNKNOWN' && fromPdf.transactionType !== 'UNKNOWN')
        inline.transactionType = fromPdf.transactionType;

      // Only take name/role from a data form PDF (not cover letters which may have
      // the signing CFO/CEO's name/title at the bottom, unrelated to the actual filer)
      if (isDataForm) {
        if (!inline.insiderName && fromPdf.insiderName) inline.insiderName = fromPdf.insiderName;
        if (!inline.insiderRole && fromPdf.insiderRole) inline.insiderRole = fromPdf.insiderRole;
      }

      // Stop after first PDF that gives us shares
      if (inline.shares) break;
    }

    return inline;
  } catch {
    return null;
  }
}

async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function scrapeDK() {
  console.log('🇩🇰  Nasdaq Copenhagen — Managers\' Transactions (MAR Article 19)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to} (market: ${MARKET})…`);

  // Paginate newest-first; API ignores fromDate/toDate so we stop by item date.
  // Items include multiple Nordic markets — filter by item.market === MARKET.
  const allItems = [];
  const seenIds = new Set();
  let start = 0;
  const PAGE = 200;
  const MAX_PAGES = 50;
  let page = 0;
  while (page < MAX_PAGES) {
    const data = await fetchNasdaqPage(from, to, start);
    if (!data) {
      if (start === 0) {
        console.log('  ⚠  Nasdaq Nordic API not accessible.');
        console.log('  ℹ  0 rows saved.');
        return { saved: 0 };
      }
      break;
    }
    const items = (data.results && data.results.item) || [];
    if (!items.length) break;

    let added = 0;
    let allBefore = true;
    for (const item of items) {
      const itemDate = (item.releaseTime || item.published || '').slice(0, 10);
      if (itemDate >= from) allBefore = false;
      if (itemDate < from) continue;
      if (item.market !== MARKET) continue;
      const id = String(item.disclosureId || item.id || '');
      if (id && seenIds.has(id)) continue;
      seenIds.add(id);
      allItems.push(item);
      added++;
    }
    console.log(`  Page start=${start}: ${items.length} raw, ${added} in window+market`);

    if (allBefore) { console.log('  All items before cutoff, stopping pagination.'); break; }
    if (items.length < PAGE) break;
    start += PAGE;
    page++;
  }

  if (!allItems.length) {
    console.log('  No manager transactions found.');
    return { saved: 0 };
  }
  console.log(`  Total from API: ${allItems.length} items. Fetching details…`);

  const details = await pMap(allItems, async (item) => {
    if (!item.messageUrl) return null;
    return fetchNotificationDetails(item.messageUrl);
  }, CONCURRENCY);

  const seen = new Set();
  const dbRows = [];
  for (let i = 0; i < allItems.length; i++) {
    const r   = allItems[i];
    const det = details[i];

    const publishIso = (r.releaseTime || r.published || '').slice(0, 10) || from;
    const txIso      = (det && det.txDate) || publishIso;
    const fid        = `DK-${r.disclosureId || r.id || i}`;
    if (seen.has(fid)) continue; seen.add(fid);

    // Skip company-buyback disclosures (issuer reporting its own share purchases under MAR Art. 5).
    // These appear in the "Managers' Transactions" feed but the "insider" is the company itself.
    // Detect: insiderName starts with or contains the company name, or contains "LEI" boilerplate.
    const companyKey  = (r.company || '').toLowerCase().replace(/\s+a\/s$|\s+plc$|\s+se$|\s+nv$|\s+sa$/i, '').trim().slice(0, 12);
    const insiderKey  = (det && det.insiderName || '').toLowerCase().slice(0, 12);
    const isBuyback   = (companyKey && insiderKey && insiderKey.startsWith(companyKey))
                     || /\blei\b/i.test(det && det.insiderName || '');
    if (isBuyback) {
      console.log(`  ℹ  Skipping company-buyback row: ${r.company} (insider="${det && det.insiderName}")`);
      continue;
    }

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           (det && det.isin) || '',
      company:          r.company || null,
      insider_name:     det && det.insiderName ? det.insiderName : null,
      via_entity:       det && det.viaEntity   ? det.viaEntity  : null,
      insider_role:     translateRole(det && det.insiderRole ? det.insiderRole : null),
      transaction_type: (det && det.transactionType !== 'UNKNOWN') ? det.transactionType : mapType(r.headline || ''),
      transaction_date: txIso,
      shares:           det ? det.shares : null,
      price_per_share:  det ? det.price : null,
      total_value:      det ? (det.totalValue || ((det.shares && det.price) ? Math.round(det.shares * det.price) : null)) : null,
      currency:         CURRENCY,
      filing_url:       r.messageUrl || `https://view.news.eu.nasdaq.com/`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  const other = dbRows.filter(r => r.transaction_type === 'OTHER').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL, ${other} OTHER)`);
  return { saved: dbRows.length };
}

scrapeDK().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
