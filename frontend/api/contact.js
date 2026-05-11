export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, subject, message } = req.body || {};
  if (!email || !message) return res.status(400).json({ error: 'Email and message are required' });

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
