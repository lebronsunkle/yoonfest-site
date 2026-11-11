// YOON Fest lodging checkout.
// Static pages are served from ./public. This Worker only handles /api/*.
// Stripe keys live in Cloudflare secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
// Inventory lives in one Durable Object so two people can't buy the last yurt at once.

import { DurableObject } from "cloudflare:workers";

const PRODUCTS = {
  yurt: { name: "YOON Fest 2027 - Yurt (festival weekend, sleeps 4)", amount: 180000, cap: 7 },
  cabin: { name: "YOON Fest 2027 - Pine Ridge Cabin (festival weekend, sleeps 4)", amount: 300000, cap: 1 },
};

// Stripe's shortest allowed Checkout lifetime is 30 minutes. The hold lasts a bit longer
// so a unit is never sold twice while someone is still on the Stripe page.
const SESSION_MINUTES = 30;
const HOLD_MS = (SESSION_MINUTES + 2) * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === "/api/inventory" && request.method === "GET") return inventory(env, url);
      if (url.pathname === "/api/checkout" && request.method === "POST") return checkout(request, env, url);
      if (url.pathname === "/api/release" && request.method === "POST") return release(request, env);
      if (url.pathname === "/api/stripe-webhook" && request.method === "POST") return webhook(request, env);
      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "server_error" }, 500);
    }
  },
};

// Live sales and test sales are counted separately, so test purchases never block real ones.
function isLive(env) {
  return String(env.STRIPE_SECRET_KEY || "").startsWith("sk_live_");
}

// With a test key, checkout is hidden from the public and only works at /lodging.html?test=1.
function checkoutOpen(env, url) {
  if (!env.STRIPE_SECRET_KEY) return false;
  return isLive(env) || url.searchParams.get("test") === "1";
}

function stock(env) {
  const name = isLive(env) ? "lodging-2027" : "lodging-2027-test";
  return env.INVENTORY.get(env.INVENTORY.idFromName(name));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function inventory(env, url) {
  const counts = await stock(env).counts(PRODUCTS);
  return json({ enabled: checkoutOpen(env, url), products: counts });
}

async function checkout(request, env, url) {
  if (!checkoutOpen(env, url)) return json({ error: "not_enabled" }, 503);
  const body = await request.json().catch(() => ({}));
  const key = body.product;
  const product = PRODUCTS[key];
  if (!product) return json({ error: "bad_product" }, 400);

  const hold = await stock(env).hold(key, product.cap, HOLD_MS);
  if (!hold) return json({ error: "sold_out" }, 409);

  const origin = url.origin;
  const t = isLive(env) ? "" : "&test=1";
  const params = {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(product.amount),
    "line_items[0][price_data][product_data][name]": product.name,
    success_url: `${origin}/lodging-thanks.html?session_id={CHECKOUT_SESSION_ID}${t}`,
    cancel_url: `${origin}/lodging.html?release=${hold}${t}`,
    expires_at: String(Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60),
    client_reference_id: hold,
    "metadata[hold]": hold,
    "metadata[product]": key,
    "payment_intent_data[metadata][hold]": hold,
    "payment_intent_data[metadata][product]": key,
    "phone_number_collection[enabled]": "true",
    "custom_fields[0][key]": "purchaser",
    "custom_fields[0][label][type]": "custom",
    "custom_fields[0][label][custom]": "Your full name",
    "custom_fields[0][type]": "text",
    "custom_fields[0][text][maximum_length]": "100",
    "custom_fields[1][key]": "guests",
    "custom_fields[1][label][type]": "custom",
    "custom_fields[1][label][custom]": "Other guests",
    "custom_fields[1][type]": "text",
    "custom_fields[1][optional]": "true",
    "custom_fields[1][text][maximum_length]": "255",
  };
  // No payment_method_types here on purpose: Stripe shows whatever is turned on in the
  // dashboard (card, Apple Pay, Google Pay, Affirm, Klarna).

  const res = await stripe(env, "POST", "/v1/checkout/sessions", params);
  if (!res.ok) {
    console.error("stripe create failed", res.status, await res.text());
    await stock(env).release(hold);
    return json({ error: "stripe_error" }, 502);
  }
  const session = await res.json();
  await stock(env).attach(hold, session.id);
  return json({ url: session.url });
}

async function release(request, env) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.hold !== "string" || body.hold.length > 64) return json({ ok: false }, 400);
  const sessionId = await stock(env).release(body.hold);
  if (sessionId && env.STRIPE_SECRET_KEY) {
    // Close the abandoned Stripe page so it can't be paid after the unit is back on sale.
    await stripe(env, "POST", `/v1/checkout/sessions/${sessionId}/expire`, {}).catch(() => {});
  }
  return json({ ok: true });
}

async function webhook(request, env) {
  const raw = await request.text();
  const ok = await verifyStripe(raw, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ error: "bad_signature" }, 400);
  const event = JSON.parse(raw);
  const s = event.data && event.data.object;
  const hold = s && s.metadata && s.metadata.hold;
  if (!hold) return json({ received: true });

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (s.payment_status === "paid") await stock(env).confirm(hold, s.metadata.product, s.id);
  } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    await stock(env).release(hold);
  }
  return json({ received: true });
}

function stripe(env, method, path, params) {
  const base = env.STRIPE_API_BASE || "https://api.stripe.com";
  return fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
}

async function verifyStripe(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2)));
  const t = parts.t;
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => timingSafeEqual(s, hex));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export class Inventory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS units (
      hold TEXT PRIMARY KEY, product TEXT NOT NULL, status TEXT NOT NULL,
      session TEXT, expires INTEGER, created INTEGER NOT NULL)`);
  }

  sweep() {
    this.sql.exec("DELETE FROM units WHERE status = 'held' AND expires < ?", Date.now());
  }

  taken(product) {
    return this.sql.exec("SELECT COUNT(*) AS n FROM units WHERE product = ?", product).one().n;
  }

  counts(products) {
    this.sweep();
    const out = {};
    for (const [key, p] of Object.entries(products)) {
      const sold = this.sql.exec("SELECT COUNT(*) AS n FROM units WHERE product = ? AND status = 'sold'", key).one().n;
      const left = Math.max(0, p.cap - this.taken(key));
      out[key] = { cap: p.cap, sold, left };
    }
    return out;
  }

  // Durable Object calls run one at a time, so check-then-insert is safe here.
  hold(product, cap, ms) {
    this.sweep();
    if (this.taken(product) >= cap) return null;
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO units (hold, product, status, expires, created) VALUES (?, ?, 'held', ?, ?)", id, product, Date.now() + ms, Date.now());
    return id;
  }

  attach(hold, session) {
    this.sql.exec("UPDATE units SET session = ? WHERE hold = ?", session, hold);
  }

  release(hold) {
    const row = this.sql.exec("SELECT session FROM units WHERE hold = ? AND status = 'held'", hold).toArray()[0];
    this.sql.exec("DELETE FROM units WHERE hold = ? AND status = 'held'", hold);
    return row ? row.session : null;
  }

  // A payment always counts, even if the hold had already lapsed.
  confirm(hold, product, session) {
    this.sql.exec(
      `INSERT INTO units (hold, product, status, session, expires, created) VALUES (?, ?, 'sold', ?, NULL, ?)
       ON CONFLICT(hold) DO UPDATE SET status = 'sold', session = excluded.session, expires = NULL`,
      hold, product, session, Date.now());
  }
}
