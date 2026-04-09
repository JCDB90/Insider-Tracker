const fetch = require('node-fetch');

async function scrapeLU() {
  console.log('🇱🇺 Scraping CSSF Luxembourg...');
  
  try {
    const url = 'https://www.cssf.lu/en/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched CSSF page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('CSSF') || html.includes('Luxembourg')) {
      console.log('✅ Confirmed: Luxembourg financial regulator');
      console.log('\nKeywords: "share buyback", "rachat d\'actions"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeLU();