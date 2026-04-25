import https from 'https';

function fetchSymbol(symbol, range, interval) {
  return new Promise((resolve) => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
    const req = https.get(
      {
        hostname: 'query1.finance.yahoo.com',
        path,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      (yRes) => {
        let data = '';
        yRes.on('data', (c) => (data += c));
        yRes.on('end', () => {
          if (yRes.statusCode !== 200) return resolve(null);
          try {
            const json = JSON.parse(data);
            // Check if there are actual price data points
            const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
            const hasData = closes.some(v => v != null && v > 0);
            resolve(hasData ? data : null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
  });
}

export default async function handler(req, res) {
  const { symbol, symbols, range = '1y', interval = '1d' } = req.query;

  // Accept either ?symbol=X or ?symbols=X,Y,Z (comma-separated fallback list)
  const candidates = symbols
    ? symbols.split(',').map(s => s.trim()).filter(Boolean)
    : symbol
    ? [symbol]
    : [];

  if (!candidates.length) return res.status(400).json({ error: 'symbol required' });

  for (const sym of candidates) {
    const data = await fetchSymbol(sym, range, interval);
    if (data) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Resolved-Symbol', sym);
      return res.status(200).send(data);
    }
  }

  // All candidates failed
  res.status(404).json({ error: 'No chart data found for: ' + candidates.join(', ') });
}
