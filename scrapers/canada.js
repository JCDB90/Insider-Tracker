const fetch = require('node-fetch');

async function scrapeCA() {
  console.log('🇨🇦 Scraping TMX Canada...');
  
  try {
    // TMX Group (Toronto Stock Exchange)
    const url = 'https://www.tmx.com/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched TMX page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('TMX') || html.includes('Toronto') || html.includes('Canada')) {
      console.log('✅ Confirmed: TMX Group (Toronto Stock Exchange)');
      console.log('\nKeywords: "normal course issuer bid" (NCIB), "share buyback"');
      console.log('Official source: SEDI (System for Electronic Disclosure by Insiders)');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeCA();