export default function handler(req, res) {
  const country = req.headers['x-vercel-ip-country'] ||
                  req.headers['cf-ipcountry'] ||
                  'EU';
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json({ country });
}
