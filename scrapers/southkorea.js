const fetch = require('node-fetch');

async function scrapeKR() {
  console.log('🇰🇷 Scraping KRX South Korea...');
  
  try {
    // Korea Exchange
    const url = 'http://global.krx.co.kr/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched KRX page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('KRX') || html.includes('Korea')) {
      console.log('✅ Confirmed: Korea Exchange (KOSPI/KOSDAQ)');
      console.log('\nKeywords: "자사주 매입" (treasury stock purchase), "buyback"');
      console.log('Note: Samsung, Hyundai, LG - huge market!');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeKR();