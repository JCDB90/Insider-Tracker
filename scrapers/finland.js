const fetch = require('node-fetch');

async function scrapeFI() {
  console.log('🇫🇮 Scraping FIN-FSA Finland...');
  
  try {
    const url = 'https://www.finanssivalvonta.fi/en/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched FIN-FSA page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('Finanssivalvonta') || html.includes('Finland')) {
      console.log('✅ Confirmed: Finnish financial regulator');
      console.log('\nKeywords: "osakehankintalohjelma", "share buyback"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeFI();