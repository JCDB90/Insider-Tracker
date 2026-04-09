const fetch = require('node-fetch');
const cheerio = require('cheerio');

async function scrapeNL() {
  console.log('🇳🇱 Scraping AFM Netherlands...');
  
  try {
    const url = 'https://www.afm.nl/en/sector/registers/meldingenregisters/openbaarmaking-voorwetenschap';
    const response = await fetch(url);
    const html = await response.text();
    
    console.log('✅ Successfully fetched AFM page');
    console.log('Page length:', html.length, 'characters');
    
    // For now, just confirm we can reach the official AFM source
    if (html.includes('Publication of inside information')) {
      console.log('✅ Confirmed: This is the official AFM inside information register');
      console.log('\nNext step: We need to parse the HTML to extract buyback filings');
      console.log('The data is there - we just need to extract it properly.');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeNL();