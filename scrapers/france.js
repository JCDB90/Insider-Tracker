const fetch = require('node-fetch');

async function scrapeFR() {
  console.log('🇫🇷 Scraping AMF France...');
  
  try {
    // AMF - Autorité des marchés financiers
    const url = 'https://www.amf-france.org/en';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched AMF page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('AMF') || html.includes('France')) {
      console.log('✅ Confirmed: This is France\'s official securities regulator');
      console.log('\nKeywords to filter: "rachat d\'actions", "programme de rachat"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeFR();