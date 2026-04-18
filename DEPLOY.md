# Foreign Affairs — Complete Deployment Guide
# form.isira.club · Cloudflare Pages + Workers + Google Sheets + Whop

==============================================================================
 OVERVIEW OF WHAT YOU'RE DEPLOYING
==============================================================================

  form.isira.club/             → index.html  (React multi-step forms)
  form.isira.club/thank-you    → thank-you.html (post-payment confirmation)

  fa-worker.[subdomain].workers.dev
    POST /submit               ← React app sends form data here
    POST /payment-confirm      ← thank-you.html sends payment confirmation
    POST /whop-webhook         ← Whop sends payment events here

  Google Sheets (2 tabs: Venues, Vendors + Activity Log)
    ← Apps Script receives from Worker and writes rows / updates status


==============================================================================
 STEP 1 — GOOGLE SHEETS SETUP
==============================================================================

1. Go to sheets.google.com → create a new blank spreadsheet.
   Name it: "Foreign Affairs — Partner Database"

2. Copy the Sheet ID from the URL:
   https://docs.google.com/spreadsheets/d/THIS_IS_YOUR_SHEET_ID/edit
                                           ▲─────────────────────
3. Go to script.google.com → click "New project"
   Name it: "FA Apps Script"

4. Delete everything in Code.gs, paste the entire contents of
   scripts/appsscript.gs

5. On line 32, replace:
   const SPREADSHEET_ID = 'YOUR_GOOGLE_SHEET_ID_HERE';
   with your actual Sheet ID from step 2.

6. Click Deploy → New Deployment
   - Type: Web App
   - Execute as: Me (your Google account)
   - Who has access: Anyone
   → Click Deploy → Authorize → Copy the Web App URL

   Save this URL — it looks like:
   https://script.google.com/macros/s/AKfycb.../exec
   This is your APPS_SCRIPT_URL.

7. Test it: open the URL in your browser. You should see:
   {"status":"ok","service":"Foreign Affairs Apps Script",...}


==============================================================================
 STEP 2 — CLOUDFLARE WORKER SETUP
==============================================================================

Prerequisites: Node.js installed, Cloudflare account

  npm install -g wrangler
  wrangler login

Deploy the worker:

  cd worker/
  wrangler deploy

Set secret environment variables:

  wrangler secret put APPS_SCRIPT_URL
  → Paste your Apps Script URL when prompted

  wrangler secret put WHOP_WEBHOOK_SECRET
  → Paste your Whop webhook secret (from Whop dashboard → Settings → Webhooks)

Your worker is now live at:
  https://fa-worker.[your-cf-subdomain].workers.dev

Test it:
  curl https://fa-worker.[your-cf-subdomain].workers.dev/health
  → Should return {"status":"ok",...}


==============================================================================
 STEP 3 — UPDATE CONFIG IN HTML FILES
==============================================================================

In pages/index.html, find the CONFIG block near the top:

  const CONFIG = {
    workerUrl: 'https://fa-worker.YOUR_SUBDOMAIN.workers.dev',
    whopLinks: {
      venue:         'https://whop.com/checkout/YOUR_VENUE_PLAN_ID/',
      vendorEarly:   'https://whop.com/checkout/YOUR_VENDOR_EARLY_BIRD_ID/',
      vendorStandard:'https://whop.com/checkout/YOUR_VENDOR_STANDARD_ID/',
    },
    ...
  };

Replace each placeholder with your real values.

In pages/thank-you.html, find:
  const WORKER_URL = 'https://fa-worker.YOUR_SUBDOMAIN.workers.dev';
Replace with your real Worker URL.


==============================================================================
 STEP 4 — WHOP SETUP
==============================================================================

Go to whop.com/dashboard

A. Create 3 Products / Plans:

   Plan 1: "Venue Partner" (Free — $0)
   Plan 2: "Vendor Early Bird" ($200)
   Plan 3: "Vendor Standard" ($500)

B. For each plan, set the Success Redirect URL to:
   (Whop will append its own params, your app reads them via URL params)
   Leave this blank OR set to: https://form.isira.club/thank-you.html
   → Whop appends: ?checkout_id=xxx&order_id=xxx automatically

C. Set up Webhook:
   Whop Dashboard → Settings → Webhooks → Add Endpoint
   URL: https://fa-worker.[your-subdomain].workers.dev/whop-webhook
   Events to subscribe:
     ✓ payment.completed
     ✓ membership.went_valid
     ✓ checkout.completed

   Copy the Signing Secret → paste into:
   wrangler secret put WHOP_WEBHOOK_SECRET

D. Copy each plan's checkout URL into index.html CONFIG.whopLinks:
   Whop Dashboard → Plan → Share → Copy checkout link


==============================================================================
 STEP 5 — CLOUDFLARE PAGES SETUP
==============================================================================

Option A — Cloudflare Dashboard (easiest):

  1. cloudflare.com/dashboard → Pages → Create application
  2. "Upload assets" (no Git required)
  3. Upload the entire pages/ folder (index.html + thank-you.html)
  4. Project name: foreign-affairs-portal
  5. After deploy, go to Custom Domains → Add domain: form.isira.club
     (Your DNS must point to Cloudflare — set CNAME to pages.dev address)

Option B — CLI deploy:

  npm install -g wrangler
  cd pages/
  wrangler pages deploy . --project-name=foreign-affairs-portal

For the /thank-you route to work without .html extension, create a
_redirects file in the pages/ folder:

  /thank-you    /thank-you.html    200

(This file is already set up — see pages/_redirects)


==============================================================================
 STEP 6 — DNS (if using custom domain)
==============================================================================

In Cloudflare DNS for isira.club:
  Type:    CNAME
  Name:    form
  Target:  foreign-affairs-portal.pages.dev
  Proxy:   ✓ (orange cloud — proxied)

SSL/TLS is automatic via Cloudflare.


==============================================================================
 DATA FLOW (end-to-end)
==============================================================================

User fills form → Clicks "Submit & Choose Plan"
  ↓
React app → POST /submit → Worker → Apps Script → Sheets (row added, status=pending)
  ↓
Payment modal appears with 3 Whop links
  ↓
User clicks Whop link → Redirected to Whop checkout
  ↓ (payment done)
Whop redirects → thank-you.html?id=FA-XXX&mode=vendor&checkout_id=xxx
  ↓
thank-you.html → POST /payment-confirm → Worker → Apps Script → Sheets (status=PAID ✓)
  ↓ (simultaneously)
Whop sends webhook → POST /whop-webhook → Worker → Apps Script → Sheets (redundant update)
  ↓
User sees success page with confetti + next steps


==============================================================================
 ENVIRONMENT VARIABLES REFERENCE
==============================================================================

Cloudflare Worker Secrets (wrangler secret put):
  APPS_SCRIPT_URL      → Your Google Apps Script web app deployment URL
  WHOP_WEBHOOK_SECRET  → From Whop Dashboard → Settings → Webhooks → Secret

Cloudflare Worker Vars (wrangler.toml or dashboard):
  ALLOWED_ORIGIN       → https://form.isira.club


==============================================================================
 FREE TIER LIMITS (all within free limits for this app)
==============================================================================

Cloudflare Pages:   Unlimited sites, 500 builds/month — FREE
Cloudflare Workers: 100,000 req/day, 10ms CPU — FREE
Google Apps Script: 6 min/execution, 20k reads/day — FREE
Whop:               No monthly fee (% per transaction only)
Google Sheets:      Unlimited rows (up to 10M cells) — FREE


==============================================================================
 SUPPORT & TROUBLESHOOTING
==============================================================================

Worker not writing to Sheets?
  → Check APPS_SCRIPT_URL is set: wrangler secret list
  → Open Apps Script → Executions tab to see errors
  → Make sure deployment is "Anyone" access

Whop webhook not firing?
  → Check Worker logs: wrangler tail
  → Verify WHOP_WEBHOOK_SECRET matches Whop dashboard
  → Test with: curl -X POST [worker]/health

Status not updating after payment?
  → The thank-you.html does a client-side POST to /payment-confirm
  → Check browser console on thank-you.html for errors
  → Verify the submissionId is passed in the URL correctly

Payment modal not showing correct Whop links?
  → Update CONFIG.whopLinks in index.html with real Whop checkout URLs
