const fetch = require('node-fetch');

async function scrapePT() {
  console.log('🇵🇹 Scraping CMVM Portugal...');
  
  try {
    // CMVM - Portuguese securities regulator
    const url = 'https://web3.cmvm.pt/english/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched CMVM page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('CMVM') || html.includes('Portugal')) {
      console.log('✅ Confirmed: This is the official Portuguese securities regulator');
      console.log('\nKeywords to filter: "recompra de acções", "programa de recompra"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapePT();