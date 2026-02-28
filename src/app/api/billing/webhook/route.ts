import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripeClient } from '@/lib/billing/stripe';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type BillingSku = {
  stripe_price_id: string;
  kind: 'subscription_monthly' | 'topup_pack';
  credits_base: number | string;
  credits_multiplier?: number | string | null;
};

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toIso(ts?: number | null): string | null {
  if (!ts || !Number.isFinite(ts)) return null;
  return new Date(ts * 1000).toISOString();
}

async function fetchSku(admin: ReturnType<typeof createAdminClient>, priceId: string) {
  const { data, error } = await admin
    .from('billing_skus')
    .select('stripe_price_id, kind, credits_base, credits_multiplier')
    .eq('stripe_price_id', priceId)
    .maybeSingle();
  if (error) throw error;
  return data as BillingSku | null;
}

async function findUserIdByCustomer(
  admin: ReturnType<typeof createAdminClient>,
  customerId: string
) {
  const { data, error } = await admin
    .from('billing_customers')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

async function grantCredits(
  admin: ReturnType<typeof createAdminClient>,
  params: {
    userId: string;
    sku: BillingSku;
    eventId: string;
    invoiceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const base = parseNumber(params.sku.credits_base) ?? 0;
  const multiplierRaw = parseNumber(params.sku.credits_multiplier);
  const multiplier =
    params.sku.kind === 'subscription_monthly'
      ? 2
      : (multiplierRaw ?? 1);
  const credits = Math.round(base * multiplier);
  if (!credits || credits <= 0) return;

  const { error } = await admin.rpc('grant_credits', {
    p_user_id: params.userId,
    p_amount: credits,
    p_source: params.sku.kind,
    p_metadata: {
      price_id: params.sku.stripe_price_id,
      credits_base: base,
      credits_multiplier: multiplier,
      ...params.metadata,
    },
    p_stripe_event_id: params.eventId,
    p_stripe_invoice_id: params.invoiceId ?? null,
  });

  if (error && error.code !== '23505') {
    throw error;
  }
}

export async function POST(req: NextRequest) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: 'Stripe is not configured yet.' },
      { status: 503 }
    );
  }
  const stripe = getStripeClient();
  const signature = req.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: 'Webhook misconfigured' }, { status: 400 });
  }

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature';
    return new NextResponse(`Webhook Error: ${message}`, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== 'payment') break;
        const customerId =
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id;
        const priceId = session.metadata?.price_id;
        if (!customerId || !priceId) break;

        const userId = await findUserIdByCustomer(admin, customerId);
        if (!userId) break;

        const sku = await fetchSku(admin, priceId);
        if (!sku) break;

        await grantCredits(admin, {
          userId,
          sku,
          eventId: event.id,
          metadata: {
            checkout_session_id: session.id,
            payment_intent: session.payment_intent ?? null,
          },
        });
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === 'string'
            ? invoice.customer
            : invoice.customer?.id;
        const invoiceLines = (invoice.lines?.data ?? []) as Array<
          Stripe.InvoiceLineItem & {
            price?: Stripe.Price | null;
            plan?: { id?: string | null } | null;
          }
        >;
        const invoiceLine =
          invoiceLines.find((line) => Boolean(line.price?.recurring ?? line.plan)) ??
          invoiceLines[0] ??
          null;
        const priceId = invoiceLine?.price?.id ?? invoiceLine?.plan?.id ?? null;
        if (!customerId || !priceId) break;

        const userId = await findUserIdByCustomer(admin, customerId);
        if (!userId) break;

        const sku = await fetchSku(admin, priceId);
        if (!sku) break;

        const invoiceSubscription = invoice.parent?.subscription_details?.subscription;
        const subscriptionId =
          typeof invoiceSubscription === "string"
            ? invoiceSubscription
            : invoiceSubscription?.id ?? null;

        await grantCredits(admin, {
          userId,
          sku,
          eventId: event.id,
          invoiceId: invoice.id,
          metadata: {
            invoice_id: invoice.id,
            subscription_id: subscriptionId,
            billing_reason: invoice.billing_reason ?? null,
          },
        });
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id;
        if (!customerId) break;
        const userId = await findUserIdByCustomer(admin, customerId);
        if (!userId) break;

        const subscriptionItems = subscription.items?.data ?? [];
        let currentPeriodStart: number | null = null;
        let currentPeriodEnd: number | null = null;
        for (const item of subscriptionItems) {
          currentPeriodStart =
            currentPeriodStart === null
              ? item.current_period_start
              : Math.min(currentPeriodStart, item.current_period_start);
          currentPeriodEnd =
            currentPeriodEnd === null
              ? item.current_period_end
              : Math.max(currentPeriodEnd, item.current_period_end);
        }

        const payload = {
          user_id: userId,
          stripe_subscription_id: subscription.id,
          status: subscription.status,
          current_period_start: toIso(currentPeriodStart),
          current_period_end: toIso(currentPeriodEnd),
          cancel_at_period_end: subscription.cancel_at_period_end ?? false,
          canceled_at: toIso(subscription.canceled_at),
        };

        const { error } = await admin
          .from('billing_subscriptions')
          .upsert(payload, { onConflict: 'stripe_subscription_id' });
        if (error) throw error;
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error('Stripe webhook handler failed:', error);
    return NextResponse.json({ error: 'Webhook handling failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
