/**
 * Research script (NOT part of the scraping pipeline) — tests whether OeKB's public
 * bulk Excel export is a viable discovery source for Austrian MAR Article 19 filings.
 * See conversation/memory for context. Not wired into CI; run manually.
 */
'use strict';

const XLSX = require('xlsx');
const fetch = require('node-fetch');

async function testOeKB() {
  console.log('Downloading OeKB Excel...');
  const res = await fetch(
    'https://my.oekb.at/issuer-info/rest/public/meldedaten/iic/download'
  );
  const buf = await res.buffer();
  console.log('Downloaded bytes:', buf.length);

  const wb = XLSX.read(buf, { type: 'buffer' });
  console.log('Sheet names:', wb.SheetNames);

  // The data lives on the "Übermittlungen" sheet, not necessarily SheetNames[0]
  // (the workbook also has an explanation/disclaimer sheet and a summary sheet).
  const sheetName = wb.SheetNames.find(n => /bermittlung/i.test(n)) || wb.SheetNames[0];
  console.log('Using sheet:', sheetName);
  const ws = wb.Sheets[sheetName];
  // Row 1 of this sheet is blank (formatting only) — the real header row is row 2.
  // Without `range: 1`, sheet_to_json treats the blank row 1 as headers and produces
  // useless "__EMPTY" column names with all data shifted down by one row.
  const rows = XLSX.utils.sheet_to_json(ws, { range: 1 });

  console.log('Total rows:', rows.length);
  console.log('Column names:', Object.keys(rows[0]));

  // Filter Art. 19
  const art19 = rows.filter(r =>
    r['Dokumenttyp']?.includes('Art 19') ||
    r['Dokumenttyp']?.includes('Eigengeschäfte')
  );
  console.log('Art. 19 rows:', art19.length);

  // Show last 10
  console.log('Recent 10:');
  art19.slice(0, 10).forEach(r => {
    console.log(
      r['Übermittlungsdatum'],
      '|', r['Organisation'],
      '|', r['Dokumenttitel']?.substring(0, 60)
    );
  });

  // Show unique companies
  const companies = [...new Set(art19.map(r => r['Organisation']))];
  console.log('\nUnique companies:', companies.length);
  console.log('Sample:', companies.slice(0, 20).join(', '));

  // Art. 19 rows in the last 30 days (dates are DD.MM.YYYY, HH:MM format)
  const parseAtDate = (s) => {
    const m = s && s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    return m ? new Date(`${m[3]}-${m[2]}-${m[1]}`) : null;
  };
  const now = new Date();
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const last30 = art19.filter(r => {
    const d = parseAtDate(r['Übermittlungsdatum']);
    return d && d >= cutoff;
  });
  console.log('\nArt. 19 rows in the last 30 days:', last30.length);

  // Oldest/newest row dates overall (to gauge how far back the 5000-row cap reaches)
  const dates = rows.map(r => parseAtDate(r['Übermittlungsdatum'])).filter(Boolean);
  const oldest = new Date(Math.min(...dates));
  const newest = new Date(Math.max(...dates));
  console.log('Overall date range in this export:', oldest.toISOString().slice(0,10), '→', newest.toISOString().slice(0,10));
}

testOeKB().catch(console.error);
