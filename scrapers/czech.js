const fetch = require('node-fetch');

async function scrapeCZ() {
  console.log('🇨🇿 Scraping CNB Czech Republic...');
  
  try {
    // Czech National Bank
    const url = 'https://www.cnb.cz/en/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched CNB page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('CNB') || html.includes('Czech')) {
      console.log('✅ Confirmed: This is Czech Republic\'s official central bank');
      console.log('\nKeywords to filter: "zpětný odkup akcií", "program zpětného odkupu"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeCZ();