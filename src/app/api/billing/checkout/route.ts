import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripeClient } from '@/lib/billing/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CheckoutPayload = {
  priceId?: string;
  returnUrl?: string;
};

function getPublicOrigin(req: NextRequest): string {
  const url = new URL(req.url);
  const host =
    req.headers.get('x-forwarded-host') ??
    req.headers.get('host') ??
    url.host;
  const proto =
    req.headers.get('x-forwarded-proto') ??
    url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

function resolveReturnUrl(req: NextRequest, returnUrl?: string): string {
  const publicOrigin = getPublicOrigin(req);
  const origin = req.headers.get('origin') ?? publicOrigin;
  if (!returnUrl) return origin;
  try {
    const resolved = new URL(returnUrl, origin);
    return resolved.origin === origin ? resolved.toString() : origin;
  } catch {
    return origin;
  }
}

export async function POST(req: NextRequest) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { error: 'Stripe is not configured yet.' },
      { status: 503 }
    );
  }
  const payload = (await req.json().catch(() => ({}))) as CheckoutPayload;
  const priceId = typeof payload.priceId === 'string' ? payload.priceId.trim() : '';
  if (!priceId) {
    return NextResponse.json({ error: 'Missing priceId' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: sku, error: skuErr } = await admin
    .from('billing_skus')
    .select('stripe_price_id, kind')
    .eq('stripe_price_id', priceId)
    .maybeSingle();

  if (skuErr || !sku) {
    return NextResponse.json({ error: 'Invalid priceId' }, { status: 400 });
  }

  const { data: existingCustomer, error: customerErr } = await admin
    .from('billing_customers')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (customerErr) {
    return NextResponse.json({ error: 'Failed to load billing customer' }, { status: 500 });
  }

  const stripe = getStripeClient();
  let customerId = existingCustomer?.stripe_customer_id ?? '';
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { user_id: user.id },
    });
    customerId = customer.id;
    const { error: insertErr } = await admin
      .from('billing_customers')
      .upsert({ user_id: user.id, stripe_customer_id: customerId });
    if (insertErr) {
      return NextResponse.json({ error: 'Failed to store billing customer' }, { status: 500 });
    }
  }

  const returnUrl = resolveReturnUrl(req, payload.returnUrl);
  const successUrl = `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}checkout=success`;
  const cancelUrl = `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}checkout=cancel`;

  const isSubscription = sku.kind === 'subscription_monthly';
  const session = await stripe.checkout.sessions.create({
    mode: isSubscription ? 'subscription' : 'payment',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: user.id,
    metadata: {
      user_id: user.id,
      price_id: priceId,
      kind: sku.kind,
    },
    ...(isSubscription
      ? {}
      : {
          payment_intent_data: {
            metadata: {
              user_id: user.id,
              price_id: priceId,
              kind: sku.kind,
            },
          },
        }),
  });

  return NextResponse.json({ id: session.id, url: session.url });
}
