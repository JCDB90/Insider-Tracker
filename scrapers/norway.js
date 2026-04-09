const fetch = require('node-fetch');

async function scrapeNorway() {
  console.log('Scraping Oslo Bors...');
  
  try {
    // Try the public API endpoint
    const url = 'https://newsweb.oslobors.no/api/messages/search';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        markets: ['XOSL'],
        messageTypes: [],
        fromDate: '2025-01-01',
        toDate: new Date().toISOString().split('T')[0],
        size: 100
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    const buybacks = [];
    
    const messages = data.items || data.messages || [];
    
    for (const msg of messages) {
      const title = (msg.title || msg.messageTitle || '').toLowerCase();
      
      if (title.includes('tilbakekjøp') || 
          title.includes('buyback') ||
          title.includes('repurchase')) {
        
        buybacks.push({
          ticker: msg.ticker || msg.issuerTicker,
          company: msg.issuerName,
          date: (msg.publishedDate || msg.publishedTime || '').split('T')[0],
          title: msg.title || msg.messageTitle,
        });
      }
    }
    
    console.log(`Found ${buybacks.length} buybacks`);
    if (buybacks.length > 0) {
      console.log(JSON.stringify(buybacks, null, 2));
    } else {
      console.log('No buyback announcements found in the date range.');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    console.log('\nNote: Oslo Bors API may have changed. You can manually check: https://newsweb.oslobors.no/');
  }
}

scrapeNorway();