const fetch = require('node-fetch');

async function scrapeDK() {
  console.log('🇩🇰 Scraping Finanstilsynet Denmark...');
  
  try {
    // Finanstilsynet OAM
    const url = 'https://oam.finanstilsynet.dk/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched Finanstilsynet OAM');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('Finanstilsynet') || html.includes('Denmark') || html.includes('OAM')) {
      console.log('✅ Confirmed: This is Denmark\'s official financial regulator OAM');
      console.log('\nKeywords to filter: "tilbagekøbsprogram", "aktietilbagekøb", "share buyback"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeDK();