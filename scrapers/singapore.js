const fetch = require('node-fetch');

async function scrapeSG() {
  console.log('🇸🇬 Scraping SGX Singapore...');
  
  try {
    const url = 'https://www.sgx.com/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched SGX page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('SGX') || html.includes('Singapore')) {
      console.log('✅ Confirmed: Singapore Exchange');
      console.log('\nKeywords: "share buyback mandate", "share purchase mandate"');
      console.log('Official source: SGXNet announcements');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeSG();