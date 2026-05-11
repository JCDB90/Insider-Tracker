import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Disable Vercel's body parser — Stripe needs the raw body for signature verification
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Service role key bypasses RLS so the webhook can update any user's profile
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function planFromPriceId(priceId) {
  const elitePrices = [
    process.env.STRIPE_PRICE_ID_ELITE_MONTHLY,
    process.env.STRIPE_PRICE_ID_ELITE_ANNUAL,
  ];
  return elitePrices.includes(priceId) ? 'elite' : 'pro';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session   = event.data.object;
      const userId    = session.client_reference_id;
      const subId     = session.subscription;
      const custId    = session.customer;
      if (!userId) { return res.json({ received: true }); }

      const sub   = await stripe.subscriptions.retrieve(subId);
      const price = sub.items.data[0].price.id;
      const plan  = planFromPriceId(price);

      await supabase.from('user_profiles').update({
        plan,
        stripe_customer_id:      custId,
        stripe_subscription_id:  subId,
        subscription_status:     'active',
        updated_at:              new Date().toISOString(),
      }).eq('id', userId);

      console.log(`[stripe-webhook] activated ${plan} for user ${userId}`);
    }

    if (event.type === 'customer.subscription.updated') {
      const sub    = event.data.object;
      const userId = sub.metadata?.supabase_user_id;
      if (!userId) { return res.json({ received: true }); }

      const price  = sub.items.data[0].price.id;
      const plan   = planFromPriceId(price);
      const active = sub.status === 'active' || sub.status === 'trialing';

      await supabase.from('user_profiles').update({
        plan:                active ? plan : 'visitor',
        subscription_status: sub.status,
        updated_at:          new Date().toISOString(),
      }).eq('id', userId);
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub    = event.data.object;
      const userId = sub.metadata?.supabase_user_id;
      if (!userId) { return res.json({ received: true }); }

      await supabase.from('user_profiles').update({
        plan:                'visitor',
        subscription_status: 'cancelled',
        updated_at:          new Date().toISOString(),
      }).eq('id', userId);

      console.log(`[stripe-webhook] downgraded user ${userId} to visitor`);
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  res.json({ received: true });
}
