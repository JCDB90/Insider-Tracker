// Disposable / placeholder email domains. Note: there is no equivalent list
// elsewhere in this codebase — signup goes through Supabase Auth directly with
// no domain filtering. Copy this list there too if that ever needs the same
// protection.
const BLOCKED_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net',
  'mailinator.com', 'maildrop.cc', 'guerrillamail.com', 'guerrillamail.info',
  'guerrillamail.biz', 'guerrillamail.de', 'guerrillamail.net', 'guerrillamail.org',
  '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'throwawaymail.com',
  'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com',
  'dispostable.com', 'fakeinbox.com', 'test.com', 'test.org',
]);

const MIN_MESSAGE_LENGTH = 10;

// Best-effort in-memory rate limit. Resets on cold start (serverless), but still
// blocks a scanner hammering a warm function instance within the window — enough
// friction for basic probes without needing a DB table + migration for this.
const RATE_LIMIT_MAX        = 3;
const RATE_LIMIT_WINDOW_MS  = 60 * 60 * 1000;
const submissionsByIp = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (submissionsByIp.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  submissionsByIp.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, subject, message, website } = req.body || {};

  // Honeypot: hidden field real users never see or fill. Reject silently with a
  // success-looking response so bots don't learn the submission was detected.
  if (website) {
    return res.status(200).json({ ok: true });
  }

  if (!email || !message) return res.status(400).json({ error: 'Email and message are required' });
  if (!subject) return res.status(400).json({ error: 'Please select a subject' });

  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain || BLOCKED_DOMAINS.has(domain)) {
    return res.status(400).json({ error: 'Please use a valid email address' });
  }

  if (message.trim().length < MIN_MESSAGE_LENGTH) {
    return res.status(400).json({ error: 'Please enter a longer message' });
  }

  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many messages sent — please try again later.' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'InsidersAlpha Contact <contact@insidersalpha.com>',
        to: ['jcdeboer@yahoo.com'],
        reply_to: email,
        subject: `[InsidersAlpha] ${subject || 'Contact form'} — ${email}`,
        html: `<p><strong>From:</strong> ${email}</p>
               <p><strong>Subject:</strong> ${subject || '—'}</p>
               <hr>
               <p>${message.replace(/\n/g, '<br>')}</p>`,
      }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error('[contact]', r.status, err);
      return res.status(500).json({ error: 'Failed to send — please email hello@insidersalpha.com directly.' });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[contact]', err.message);
    res.status(500).json({ error: 'Server error — please email hello@insidersalpha.com directly.' });
  }
}
