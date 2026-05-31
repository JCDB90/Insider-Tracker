import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const VALID_PRICES = new Set([
  process.env.STRIPE_PRICE_ID_PRO_MONTHLY,
  process.env.STRIPE_PRICE_ID_PRO_ANNUAL,
  process.env.STRIPE_PRICE_ID_ELITE_MONTHLY,
  process.env.STRIPE_PRICE_ID_ELITE_ANNUAL,
].filter(Boolean));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { priceId, userId, userEmail, utms = {} } = req.body || {};

  if (!priceId || !userId) {
    return res.status(400).json({ error: 'Missing priceId or userId' });
  }

  if (VALID_PRICES.size > 0 && !VALID_PRICES.has(priceId)) {
    return res.status(400).json({ error: 'Invalid price ID' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      customer_email: userEmail || undefined,
      success_url: 'https://www.insidersalpha.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://www.insidersalpha.com/pricing',
      allow_promotion_codes: true,
      metadata: {
        utm_source:   utms.utm_source   || '',
        utm_medium:   utms.utm_medium   || '',
        utm_campaign: utms.utm_campaign || '',
        landing_page: utms._landing_page || '',
      },
      subscription_data: {
        metadata: { supabase_user_id: userId },
      },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[create-checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
}
