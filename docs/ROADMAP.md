# SiteForge Roadmap

This roadmap consolidates the 81 unique findings from the full internal review of 2026-07-18 and the
56 proposals produced by a four-perspective product panel (small-business owner, operator, admin
architect, competitive analysis).

**P0 means: without it, the product cannot be delivered to a real paying customer.** The last round
closed out the P0 items for the admin console and the delivery loop; those are listed under "Shipped"
below. Everything under P0, P1 and P2 is ranked but **not yet built** — those sections describe
planned work, not shipped features.

---

## Shipped (current round)

**Admin console** (`npm run admin` → `src/admin/server.ts` + `admin-ui/`)

- Site list with brand color swatch, lead count and build time.
- One-click site creation from a customer URL: a background job queue that runs one job at a time,
  a job log the console polls while the job runs, and SSRF validation (`src/safe.ts:urlAllowed`) on
  both URL entry points of the console ("create site" and "re-capture").
- Content editing (brand name, tagline, about, add/edit/remove services, phone, email, address,
  opening hours) with a live `iframe` preview. Saving rebuilds the site from local files only, so
  the preview updates immediately.
- Brand theme editing: an eight-color palette (`primary`, `primaryDark`, `onPrimary`, `bg`,
  `surface`, `text`, `textMuted`, `border`, see `src/types.ts`) plus heading/body fonts. Clicking one
  of the accent colors extracted from the captured site sets it as the primary and derives the darker
  shade and the on-primary text color from it.
- SEO and publishing page: canonical domain (`baseUrl`), contact-form toggle, and a self-check of the
  generated `index.html` (`<h1>`, meta description, JSON-LD, `og:image`, canonical).
- Logo and hero image upload/replace.
- Lead inbox with a honeypot spam trap (`_hp`) and unread markers (a per-site "seen" watermark).
- Batch quality dashboard that renders the run reports produced by the clone loop, with sites sorted
  by score ascending so the worst ones form a manual-rescue queue.
- Audit log of write operations, soft delete with a recycle bin, and Bearer-token auth on `/api/*`.
  Auth is opt-in: it activates when `SF_ADMIN_TOKEN` is set, and the public lead-submission endpoint
  is deliberately exempt because published sites post to it. The server binds to `127.0.0.1` unless
  `SF_ADMIN_HOST` says otherwise, and warns at startup when no token is set.

**Delivery loop and extraction fixes** (fix list in [REVIEW-2026-07-18.md](REVIEW-2026-07-18.md))

- The 2 critical findings (SSRF against the renderer; a path traversal that reached an `rm -rf` on an
  attacker-controlled directory) and all 12 high findings are fixed, each covered by a unit test or
  an end-to-end assertion.
- SEO essentials: `sitemap.xml`, `robots.txt`, canonical/`og:url`, absolute `og:image`; Google Fonts
  injection for non-system brand fonts; a working lead form; a mobile hamburger menu (pure CSS, no
  JavaScript).
- Extraction fixes for brand name, address, opening hours, service-card descriptions and color
  contrast.

---

## P0 — Required before customer delivery (next batch)

| Item | Why it matters | How it would be built | Size |
|---|---|---|---|
| **CI smoke test** | Tests exist (`test/unit.mjs`, `scripts/smoke-admin.sh`) but nothing runs them automatically, and nothing covers the forge track end to end. The only batch-level quality signal is the clone score, which does not touch the forge track at all, so a batch report cannot be tied to a known-good build. | CI job that forges 5 sites (generation succeeds, key fields non-empty, HTML validates) plus `node test/unit.mjs`. | S |
| **NAP confirmation card** | A wrong phone number or wrong opening hours means the customer walks away on the spot and does not come back. | After a forge run, emit a review card: every field next to the source-page snippet it came from, plus a confidence value. Low-confidence fields are flagged rather than silently filled, and the admin console gains an explicit "confirm" step. | M |
| **Extraction confidence scores + suppress low-confidence blocks** | A junk service card or a wrong brand name damages trust more than an empty section does. | Attach a confidence score to each extracted field; below a threshold, do not render that block at all. Gate publishing on a pre-flight self-check. | M |
| **Custom domain binding + 301s from old URLs** | "The address Google already knows still reaches the new site" is the floor for customer retention. | `baseUrl` is already in place. Use the full-site URL inventory from `src/crawl.ts` to generate a 301 map (`_redirects` / nginx `map`) and submit a fresh sitemap. | M |
| **Vertical-aware CTAs and sections** | A generic "Get a Free Quote" makes no sense for a restaurant or a clinic. | Map the `vertical` field already present in the corpus manifest to the right call to action: restaurants → view menu / book a table; clinics and salons → book an appointment; auto repair and landscaping → call plus request a quote. | S |

---

## P1 — Retention and operational efficiency

Except where a partial starting point is named, nothing in this section is built yet.

**Batch pipeline**

- A review gallery for each batch (`runs/<tag>/index.html`: per-site score and diff thumbnail, whole
  batch scannable on one screen).
- A quality gate: a `status` field per site in `report.json` (passing / needs rescue), plus a
  regression comparison between round N and round N-1 that highlights sites whose score dropped.
- Batch observability: `startedAt`, duration, peak RSS, and logs written to disk.
- Versioned output with publish and rollback (`sites/<slug>/releases/<ts>/` behind a `current`
  symlink).
- Tokenized customer preview links with a structured feedback overlay on the preview page.

**Value for the small business**

- Preserve the booking, ordering and online-store links from the old site (a list of known SaaS
  domains plus button-text heuristics).
- Google reviews and a map / service-area block, baked in statically and refreshed periodically.
- Five-minute self-service editing on a phone (change the phone number, the hours, the storefront
  photo).
- A monthly value report: `tel:` taps, form submissions and CTA clicks via cookie-less analytics,
  alongside Search Console data.

**Robustness of the clone track** (blind spots in the current scoring system; see the review)

- Mobile is not part of the score. `scripts/mobile-check.mjs` is a starting point: it renders a
  built site at 390x844 and fails it on horizontal overflow or unreachable navigation. But it is a
  standalone script, not a second capture-and-score pass wired into the batch report.
- For single-page clones, rewrite `<a>` and `<form>` targets (today they can produce dead links and
  non-functional forms), resolve `<base>`, and handle conditional `@media` / `@layer` styles.
- A retention policy for `runs/` (it only ever grows and will fill the disk) and resume-after-crash.
- Stale-content detection (closed-for-business wording, expired years, dead forms) routed into the
  confirmation card as a must-handle item.

**Deeper security hardening**

- Network isolation for the rendering machine. It is a more fundamental mitigation for SSRF than URL
  filtering alone, and it also covers the asset fan-out during localisation, which the current choke
  point does not fully close.
- Sanitising the third-party DOM that the clone track writes to disk: inline event handlers,
  `iframe`, `javascript:` URLs.
- Licensing terms for redistributing fonts and stock imagery pulled in by a clone.

---

## P2 — Differentiation and scale

Nothing in this section exists in the code today.

- **An LLM content-refinement layer**: rewrite `tagline`, `about` and `services[].description` from
  the extracted original text plus the vertical and the city. Extraction today is deliberately
  deterministic and heuristic, with no model calls anywhere in the codebase (see the note in
  `src/extract/content.ts`). This milestone is where a model would first be introduced, as an
  optional pass over already-extracted content.
- **Multi-tenant registry with one-command regenerate/deploy**: `tenants.json`, `regenerate` and
  `deploy` commands, and Caddy on-demand TLS.
- Multi-page information architecture (splitting Home / Services / About / Contact), reusing the
  existing crawl capability.
- Automated SSL for custom domains, and a white-label admin console for agencies.
- Self-hosted inlined fonts to replace the external Google Fonts link (privacy, offline builds), and
  multi-size favicon generation.

---

## Strategic note: two tracks, one product

The most important conclusion of the review is a product one: **forge and clone are two different
products, and the clone track's headline score overstates how usable its output actually is.**

That headline number, a 97.6% mean score over the 60-site corpus, comes from a local batch run. Its
logs, screenshots and reports are not committed to this repository, because `runs/`, `proof/` and
`corpus/*.png` are gitignored. What is committed is the scorer (`src/score.ts`), the batch driver
(`src/clone-loop.ts`) and the corpus manifest, so the run is reproducible rather than attested.

More importantly, the metric only measures how faithfully a frozen desktop frame was reproduced. It
is blind to lost interactivity, broken forms, dead links, mobile layout and SEO regressions.

The resulting direction:

1. **Forge is the delivery track.** It produces a clean, editable, SEO-complete site that can collect
   leads. That is the thing worth charging a monthly fee for, and the admin loop shipped this round
   is what makes it deliverable.
2. **Clone is demoted to an acquisition and reference tool.** It is useful for "old site vs. new
   site" comparison pages in a demo-first sales motion, and as a pixel-level reference when
   extraction fails. It is not meant to be shipped to a customer as-is, because of the dead-link,
   form and JS-widget problems above.
3. **Scoring.** The clone score stays an internal reference only. The real delivery gate is a
   usability dimension that does not exist yet: interactions still alive, forms still submittable,
   mobile layout intact, SEO not regressed.

A first step in that direction is in the code. `src/clone/gate.ts` rejects captures that are
bot-challenge or error pages, which previously scored near-perfectly because the clone and the
reference were the same blank screen. It runs on the single-site path (`src/clone-site.ts`, which is
what the admin console invokes); wiring it into the batch loop is still outstanding.
