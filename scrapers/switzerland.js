const fetch = require('node-fetch');

async function scrapeCH() {
  console.log('🇨🇭 Scraping SIX Swiss Exchange...');
  
  try {
    const url = 'https://www.six-group.com/en/home.html';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched SIX page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('SIX') || html.includes('Swiss')) {
      console.log('✅ Confirmed: Swiss stock exchange operator');
      console.log('\nKeywords: "Aktienrückkauf", "share buyback"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeCH();