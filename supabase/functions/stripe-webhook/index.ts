// Stripe → Supabase: keeps public.subscriptions in sync so only paying members can use the app.
// Required secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically).
// Stripe events to send: checkout.session.completed, customer.subscription.created,
// customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// Always re-read the subscription from Stripe so out-of-order events cannot store a stale status.
async function syncSubscription(subscriptionId: string, extra: { userId?: string | null; email?: string | null } = {}) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = idOf(sub.customer as string | { id: string });

  let email = extra.email ?? null;
  if (!email && customerId) {
    const customer = await stripe.customers.retrieve(customerId);
    if (!("deleted" in customer && customer.deleted)) email = (customer as Stripe.Customer).email ?? null;
  }

  const item = sub.items?.data?.[0];
  // current_period_end moved from the subscription to its items in newer Stripe API versions
  const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end ??
    (item as unknown as { current_period_end?: number } | undefined)?.current_period_end ?? null;

  const row: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    stripe_customer_id: customerId,
    status: sub.status,
    price_id: item?.price?.id ?? null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    email: email ? email.toLowerCase() : null,
  };
  if (extra.userId && UUID_RE.test(extra.userId)) row.user_id = extra.userId;

  const { error } = await supabase.from("subscriptions").upsert(row, { onConflict: "stripe_subscription_id" });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  console.log(`synced ${sub.id} status=${sub.status} email=${row.email ?? "-"} user=${row.user_id ?? "-"}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret, undefined, cryptoProvider);
  } catch (err) {
    console.error("Signature verification failed:", (err as Error).message);
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subId = idOf(session.subscription as string | { id: string } | null);
        if (session.mode === "subscription" && subId) {
          await syncSubscription(subId, {
            userId: session.client_reference_id,
            email: session.customer_details?.email ?? session.customer_email ?? null,
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(sub.id);
        break;
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice & {
          subscription?: string | { id: string } | null;
          parent?: { subscription_details?: { subscription?: string | { id: string } } };
        };
        const subId = idOf(invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null);
        if (subId) await syncSubscription(subId);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error(`Handling ${event.type} failed:`, (err as Error).message);
    // 500 makes Stripe retry the event later
    return new Response("Webhook handler failed", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
