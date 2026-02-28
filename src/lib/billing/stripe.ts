import 'server-only';

import Stripe from 'stripe';

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('Missing STRIPE_SECRET_KEY');
  }
  // `stripe`'s TS types only allow the library "latest" API version.
  // We keep our chosen API version configurable for runtime behavior.
  const apiVersion = (process.env.STRIPE_API_VERSION || '2024-10-01') as Stripe.LatestApiVersion;
  stripeClient = new Stripe(key, {
    apiVersion,
  });
  return stripeClient;
}
