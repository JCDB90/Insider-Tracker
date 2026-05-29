import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const anonSb  = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt');
const adminSb = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Verify caller JWT
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const { data: { user }, error: authErr } = await anonSb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  // Look up their Stripe customer ID server-side — never trust client-supplied IDs
  const { data: profile } = await adminSb
    .from('user_profiles')
    .select('stripe_customer_id, plan')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.stripe_customer_id) {
    return res.status(400).json({ error: 'No Stripe customer found for this account' });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: 'https://www.insidersalpha.com',
  });

  res.json({ url: session.url });
}
