import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripeClient } from '@/lib/billing/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PortalPayload = {
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
  const payload = (await req.json().catch(() => ({}))) as PortalPayload;

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: billingCustomer, error: customerErr } = await admin
    .from('billing_customers')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (customerErr || !billingCustomer?.stripe_customer_id) {
    return NextResponse.json({ error: 'Billing customer not found' }, { status: 404 });
  }

  const stripe = getStripeClient();
  const returnUrl = resolveReturnUrl(req, payload.returnUrl);
  const session = await stripe.billingPortal.sessions.create({
    customer: billingCustomer.stripe_customer_id,
    return_url: returnUrl,
  });

  return NextResponse.json({ url: session.url });
}
