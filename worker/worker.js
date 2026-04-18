/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  FOREIGN AFFAIRS — CLOUDFLARE WORKER                 ║
 * ║  Handles:                                            ║
 * ║    POST /submit          ← form data from React app  ║
 * ║    POST /payment-confirm ← from thank-you.html       ║
 * ║    POST /whop-webhook    ← from Whop dashboard       ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * ENVIRONMENT VARIABLES (set in Cloudflare dashboard):
 *   APPS_SCRIPT_URL   → Your Google Apps Script web app URL
 *   WHOP_WEBHOOK_SECRET → From Whop dashboard (for signature verification)
 *   ALLOWED_ORIGIN    → https://form.isira.club
 */

const ALLOWED_ORIGIN = 'https://form.isira.club';

// ── CORS headers ──────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = [ALLOWED_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:5500'];
  const o = allowed.includes(origin) ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ── Forward to Google Apps Script ────────────────────────────────────────────
async function sendToSheets(env, payload) {
  if (!env.APPS_SCRIPT_URL) {
    console.warn('APPS_SCRIPT_URL not set — skipping Sheets write');
    return { ok: false, reason: 'no_url' };
  }
  try {
    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  } catch (e) {
    console.error('Sheets write failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ── Whop signature verification ───────────────────────────────────────────────
async function verifyWhopSignature(request, secret) {
  if (!secret) return true; // skip in dev
  const sig   = request.headers.get('whop-signature') || request.headers.get('x-whop-signature') || '';
  const body  = await request.clone().text();
  const key   = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBuf = hexToBuffer(sig.replace('sha256=', ''));
  const bodyBuf = new TextEncoder().encode(body);
  return await crypto.subtle.verify('HMAC', key, sigBuf, bodyBuf);
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

// ── Sanitize payload (remove blanks for Sheets) ───────────────────────────────
function sanitize(obj) {
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) { clean[k] = ''; continue; }
    if (typeof v === 'boolean') { clean[k] = v ? 'Yes' : 'No'; continue; }
    if (Array.isArray(v)) { clean[k] = v.join(', '); continue; }
    if (typeof v === 'object') { clean[k] = JSON.stringify(v); continue; }
    clean[k] = String(v);
  }
  return clean;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || ALLOWED_ORIGIN;
    const url    = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── POST /submit — initial form data from React app ──────────────────────
    if (request.method === 'POST' && url.pathname === '/submit') {
      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Invalid JSON' }, 400, origin); }

      const sheetsPayload = {
        action: 'submit',
        ...sanitize(body),
        // Ensure these critical fields always exist
        submissionId:  body.submissionId  || `FA-${Date.now()}`,
        type:          body.type          || 'unknown',
        submittedAt:   body.submittedAt   || new Date().toISOString(),
        paymentStatus: 'pending',
        planPaid:      '',
        whopTransactionId: '',
        paidAt:        '',
      };

      ctx.waitUntil(sendToSheets(env, sheetsPayload));
      return jsonResponse({ ok: true, submissionId: sheetsPayload.submissionId }, 200, origin);
    }

    // ── POST /payment-confirm — from thank-you.html after Whop redirect ──────
    if (request.method === 'POST' && url.pathname === '/payment-confirm') {
      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Invalid JSON' }, 400, origin); }

      const { submissionId, whopTransactionId, plan, mode, paidAt, paymentStatus } = body;
      if (!submissionId) return jsonResponse({ error: 'submissionId required' }, 400, origin);

      const sheetsPayload = {
        action: 'payment_confirm',
        submissionId,
        paymentStatus: paymentStatus || 'paid',
        planPaid:      plan || '',
        whopTransactionId: whopTransactionId || '',
        paidAt:        paidAt || new Date().toISOString(),
        mode:          mode  || '',
      };

      ctx.waitUntil(sendToSheets(env, sheetsPayload));
      return jsonResponse({ ok: true }, 200, origin);
    }

    // ── POST /whop-webhook — direct Whop payment webhook ─────────────────────
    if (request.method === 'POST' && url.pathname === '/whop-webhook') {
      // Verify signature
      const verified = await verifyWhopSignature(request, env.WHOP_WEBHOOK_SECRET);
      if (!verified) return jsonResponse({ error: 'Invalid signature' }, 401, origin);

      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Invalid JSON' }, 400, origin); }

      // Whop sends different event types — handle payment success
      const event = body.event || body.type || '';
      if (!['payment.completed', 'membership.went_valid', 'checkout.completed'].includes(event)) {
        return jsonResponse({ ok: true, skipped: true, event }, 200, origin);
      }

      // Extract metadata Whop passes back (set via redirect URL params)
      const metadata   = body.data?.metadata || body.metadata || {};
      const submissionId = metadata.submission_id || body.data?.custom_fields?.submission_id || '';
      const plan       = body.data?.plan?.name || body.data?.product?.name || metadata.plan || '';
      const txId       = body.data?.id || body.id || '';
      const email      = body.data?.user?.email || body.data?.customer?.email || '';
      const amount     = body.data?.amount_total || body.data?.total || 0;

      if (submissionId) {
        const sheetsPayload = {
          action: 'whop_webhook',
          submissionId,
          paymentStatus: 'paid',
          planPaid:      plan,
          whopTransactionId: txId,
          paidAt:        new Date().toISOString(),
          whopEmail:     email,
          amountPaid:    String(amount / 100), // Whop sends cents
          rawEvent:      event,
        };
        ctx.waitUntil(sendToSheets(env, sheetsPayload));
      }

      return jsonResponse({ ok: true, received: event }, 200, origin);
    }

    // ── GET /health ───────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', ts: new Date().toISOString() }, 200, origin);
    }

    return jsonResponse({ error: 'Not found' }, 404, origin);
  },
};
