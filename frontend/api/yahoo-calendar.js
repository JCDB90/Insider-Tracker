import https from 'https';

export default function handler(req, res) {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const path = `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents,summaryDetail`;

  const proxyReq = https.get(
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
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, s-maxage=14400, stale-while-revalidate=28800'); // 4h cache
        res.setHeader('Content-Type', 'application/json');
        res.status(yRes.statusCode || 200).send(data);
      });
    }
  );

  proxyReq.on('error', (err) => res.status(500).json({ error: err.message }));
  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy();
    res.status(504).json({ error: 'Yahoo Finance timeout' });
  });
}
