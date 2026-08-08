# SiteForge

Most small businesses are stuck with a website they cannot change: a brochure page built years
ago on WordPress, Wix, GoDaddy or Squarespace, where the phone number, the opening hours and the
service list are injected by JavaScript and locked behind a subscription. SiteForge takes the URL
of such a site, renders it in a headless browser so the JavaScript-injected content is actually
present, and turns it into a self-contained static site that a non-technical owner can edit from
an admin console and publish anywhere.

It is a TypeScript project with six runtime dependencies (`cheerio`, `pixelmatch`, `playwright`,
`pngjs`, `react`, `react-dom`) and no web framework: the admin server is raw `node:http`. Nothing
in the pipeline calls a language model.

> Note on language: the source comments and the bundled admin UI are written in Chinese. This
> README and the documents in `docs/` are in English.

## Tracks

The same capture front-end feeds two different back-ends, because "give the customer a new site"
and "reproduce the customer's existing site" are genuinely different products. The third entry
point below is the test harness for the clone track rather than a product.

| Track | What it does | Entry point | Output |
|---|---|---|---|
| **forge** | Render → heuristically extract content and brand tokens → render our own themeable React template → static HTML | `npm run forge -- <url>` | `sites/<slug>/` — `index.html`, `content.json`, `theme.json`, `capture.json`, `assets/` |
| **clone** | Render → serialize the post-JS DOM → localize every asset → freeze into a skeleton with editable slots | `npm run clone-site -- <url>` | `sites/<slug>/` — `index.html`, `skeleton.html`, `slots.json`, `site.json`, `assets/`, `reference.png` |
| **benchmark** | Batch-clone a corpus and score each clone against its own reference screenshot | `npm run clone -- <corpus\|url> <tag>` | `runs/<tag>/<slug>/` — `clone.png`, `diff.png`, plus `runs/<tag>/report.json` |

Both tracks share `src/browser.ts` (one user agent, one 1440×900 viewport, one scroll routine) and
`src/safe.ts` (slug/tag allowlists, SSRF checks).

Longer write-ups live in [`docs/ADMIN.md`](docs/ADMIN.md) for the admin API and operations,
[`docs/REVIEW-2026-07-18.md`](docs/REVIEW-2026-07-18.md) for the review described below, and
[`docs/ROADMAP.md`](docs/ROADMAP.md) for what is planned and explicitly not built.

### The 2026-07-18 pivot

The clone track came first, and its headline number, a 97.6% mean fidelity score across 60 sites,
turned out to be the most misleading thing in the project. A full internal review on 2026-07-18
concluded that the score measures reproduction fidelity of a single frozen desktop frame and is
blind to everything that decides whether a site is usable: dead links, forms that no longer submit
anywhere, mobile layout, SEO regressions. Two decisions followed. **Forge became the delivery
track** and got the admin console, lead capture and the SEO package (canonical, `sitemap.xml`,
`robots.txt`, absolute `og:image`). **The clone track was rebuilt** rather than kept as a demo:
it now freezes the captured DOM into `skeleton.html` with `data-sf-el` anchors, extracts every
editable string, image and link into `slots.json`, and re-renders through a pure function. A
capture gate sits in front of it, because a Cloudflare challenge page scored 1.0000 in round 5
(the same white screen on both sides) and would otherwise have gone out to a customer under their
own canonical URL.

## How it works

24 TypeScript/TSX files, 4,453 lines under `src/`, plus a 492-line admin UI that is a single HTML
file with one inline script and no build step.

**Capture.** `src/browser.ts` launches Chromium with a real Chrome user agent (a self-identifying
UA gets served a WAF challenge page instead of the site) and scrolls to the bottom to trigger lazy
loading. `src/render.ts` (200 lines) runs a single in-page evaluation that strips cookie and
consent overlays, ignores invisible elements, samples background, text and accent colours weighted
by area and alpha, and pairs each heading with the paragraph that follows it. `src/capture.ts`
(472 lines) is the clone-track equivalent: it downloads every stylesheet, font, image, background
image and favicon into `assets/`, rewrites the references, and takes the full-page `reference.png`
used for scoring. `src/crawl.ts` (175 lines) extends this to whole sites, following navigation
links and rewriting cross-page links to local relative paths.

**Extraction (forge).** `src/extract/brand.ts` (160 lines) turns the sampled palette into eight
CSS-variable colour tokens, detects dark-themed sites from the real body background rather than
from a large hero block, and enforces WCAG contrast (≥4.5 for body text, ≥3 for secondary) on
derived colours. `src/extract/content.ts` (83 lines) picks the brand name, tagline, about text and
up to eight services. `src/extract/contacts.ts` (63 lines) pulls phone, email, Canadian and US
addresses and multi-line opening hours out of the rendered text with anchored regular expressions.
This is deterministic on purpose. There are no model calls anywhere in the pipeline: heuristic
extraction is debuggable and stable between runs, and LLM refinement of copy is a roadmap item
rather than a feature.

**Slots (clone).** `src/slots/annotate.ts` (432 lines) freezes the captured DOM. It deliberately
does **not** wrap text in `<span>` elements, because mixed inline content is common enough that
wrapping breaks selectors like `p > a:first-child` and silently drops styling, so text slots are
addressed by child-node index instead (`e17#2`). Each slot carries an anchor (tag, filtered stable
classes, three-level ancestor signature, ordinal among same-signature elements, short text hash)
intended to re-match edits after a re-capture, plus a separator template so that `(604) 555-0188`
re-renders at identical character width and nothing reflows. `src/slots/render.ts` (394 lines) is
the inverse pure function: backfill, then a post-processing pipeline that rewrites links away from
the old domain, adopts forms onto the lead endpoint, triages remote iframes, removes uncloseable
modals, patches the `<head>` and injects a mobile nav built from `<details>` and CSS with no
JavaScript. Each step can be switched off on its own to isolate a regression.

**Output.** `src/site.tsx` is the forge template; `src/ssg.tsx` renders it with
`renderToStaticMarkup`, and `src/styles.ts` inlines all CSS with per-tenant values injected as CSS
variables. `src/seo.ts` builds the head: title, description, canonical, Open Graph, Twitter card,
`LocalBusiness` JSON-LD containing only fields that actually exist, and a Google Fonts link when
the extracted family is not a system font. Generated pages carry no executable client-side
JavaScript; the only `<script>` tag is the JSON-LD block.

**Scoring and orchestration.** `src/score.ts` (205 lines), `src/clone-loop.ts` (221 lines) and
`src/worker.ts` drive the benchmark. Every site runs in its own detached child process, so a crash
or hang kills one site rather than the batch, and a timeout kills the whole process group without
leaving orphan Chromium processes. `src/admin/server.ts` (1,091 lines) serves both tracks from one
console, dispatching on `site.json.track`: `clone` rebuilds through `renderSlots(skeleton, slots)`,
`forge` through `renderPage(content, theme)`. Both are pure functions over files already on disk,
so saving an edit rebuilds the published page without launching a browser.

## Measured quality

The benchmark corpus is 60 real independent small businesses in Metro Vancouver, chosen to spread
across platform families so the capture path is exercised against both server-rendered HTML and
JavaScript-injected content: 25 WordPress, 14 custom, 6 Wix, 4 Shopify, 4 GoDaddy, 3 Squarespace,
2 Weebly, 2 unknown. Composition and selection criteria are in
[`corpus/COMPOSITION.md`](corpus/COMPOSITION.md).

Each site is captured, localized, re-rendered from disk at 1440×900 and compared against its own
`reference.png`. The score is not naive pixel equality. `src/score.ts` computes:

- `pixelAccuracy`: strict per-pixel `pixelmatch`, zero tolerance for displacement. Reference only.
- `alignedAccuracy`: the reference is cut into 100px bands, each band searches ±50px vertically
  for the best greyscale-SAD offset, then compares at that offset with `pixelmatch`. Alignment may
  help but never hurt, because the band takes `min(diff at zero offset, diff at best offset)`, so
  a clean page cannot lose points to a noisy offset search. Content that merely shifted is not
  penalized; missing images, wrong colours and genuine misplacement still count in full.
- `heightCoverage`: `min(height) / max(height)`, which penalizes clones that miss part of the page.
- `score = alignedAccuracy × heightCoverage`.

Five rounds, each a full 60-site run:

| Round | Captured | Mean | Median | p10 |
|---|---|---|---|---|
| baseline | 59/60 | 89.9% | 98.3% | 72.6% |
| round 2 | 59/60 | 95.8% | 99.4% | 86.3% |
| round 3 | 59/60 | 96.4% | 99.2% | 90.2% |
| round 4 | 60/60 | 96.3% | 99.9% | 91.9% |
| round 5 | 60/60 | 97.6% | 99.9% | 94.1% |

p10 is the tenth percentile of the ascending score list, the worst-decile boundary, and it is the
number worth watching, since the mean hides the handful of sites that are actually broken. It
moved from 72.6% to 94.1% while the median barely moved: the wins came from widget freezing,
lazy-load fallbacks, band alignment, screenshot height guards and process-group timeouts, not from
sites that were already fine. Baseline and rounds 2–3 predate band alignment, and their score is
strict pixel accuracy times height coverage, so their means are not directly comparable with the
aligned metric used in rounds 4–5.

**None of the run artifacts are in this repository.** `runs/`, `proof/` and the corpus screenshots
are gitignored, being hundreds of megabytes of third-party page captures. The site list is not
published either, since these are third-party businesses that did not volunteer to be benchmark
subjects; `corpus/COMPOSITION.md` gives the composition and selection criteria, and the manifest
is available on request. What ships is the scorer (`src/score.ts`) and the batch runner
(`src/clone-loop.ts`), so the method is auditable and the numbers are reproducible against any
corpus file of the same shape. The figures above are read from the summary the runner prints.
Treat them as development-time measurements rather than as attested results.

The same caveat applies to measurements recorded as comments in the source: 2,696 absolute links
leaking back to the old domain, 61 forms of which 19 had no action and 17 posted visitor PII back
to the original host, JSON-LD surviving on 0 of 60 clones, canonical pointing at the old domain on
51 of 60, 21 of 60 mobile-unusable. These are development-time observations against the corpus
that motivated specific code, not committed benchmark output. The anchor hit rates in
`src/slots/types.ts` (99.89% for signature plus ordinal against roughly 52% for CSS paths) are of
the same kind, and the re-anchoring merge they were measured for is not implemented yet.
`scripts/mobile-check.mjs` exists because the desktop score says nothing about mobile: it
re-renders at 390×844 and fails a site on horizontal overflow or an unreachable nav.

## Admin server and security posture

One process, no framework, no database: the filesystem is the store (`sites/<slug>/*.json`). It
handles the site list, content and theme editing with live iframe preview, creating a site from a
URL as a queued background job, logo and hero replacement, a lead inbox, the batch quality
dashboard and an audit log. The parts worth stating plainly, all in `src/admin/server.ts`:

- **Binds `127.0.0.1` by default.** A console that can drive a renderer and rewrite published sites
  should not appear on a network interface because someone forgot a flag. Exposing it requires
  setting `SF_ADMIN_HOST` explicitly.
- **Bearer header only.** When `SF_ADMIN_TOKEN` is set, `/api/*` requires
  `Authorization: Bearer <token>`. A `?token=` query string is deliberately *not* accepted, because
  query strings end up in access logs, `Referer` headers and browser history. That costs nothing
  and removes an entire class of token leak.
- **The unauthenticated preview route serves an allowlist, not a denylist.** `/sites/**` and
  `/runs-files/**` are public because published pages are public, but `isPubliclyServeable()`
  permits only publishable web file extensions and rejects `.json`, `.jsonl` and any dot-prefixed
  path segment outright, which is what keeps `leads.jsonl` (names, phones, emails), `.audit.jsonl`
  and `.trash/` unreadable. An earlier version of this route did leak them; the review caught it.
- **Preview responses carry a precise CSP**: `script-src 'none'` on the top-level document so
  residual inline handlers in third-party DOM cannot run, while `frame-src` stays open, because a
  blanket `sandbox` also strips scripting from child iframes and turns the customer's Google Map or
  booking widget into an empty box.
- **SSRF checks on every URL that reaches the renderer** (`src/safe.ts`): http and https only, with
  loopback, private, link-local and cloud-metadata targets refused after `new URL()` hostname
  normalization, so decimal, hex and octal IP spellings are normalized before the check rather than
  around it. IPv6 literals are refused outright. This is a literal-address defence; DNS rebinding
  needs network isolation, which the code says plainly.
- **Path handling**: slugs and run tags are allowlist-validated before anything writes or deletes a
  directory, and static paths are decoded, allowlisted, normalized and prefix-checked.
- **Public lead endpoint**: honeypot field, a 5MB per-site cap on `leads.jsonl`, uploads validated
  by magic bytes against the declared MIME type, one render job at a time spawned detached so a
  timeout can `SIGKILL` the whole process group, and a capped in-memory job table.

## Getting started

```bash
npm install
npx playwright install chromium
npm run build                                  # tsc: src → dist, required before anything else

npm run forge -- https://example-business.ca   # forge track  → sites/<slug>/
npm run clone-site -- https://example-business.ca  # clone track → sites/<slug>/
npm run crawl -- https://example-business.ca mysite 6   # multi-page clone → runs/mysite/, up to 6 internal pages

npm run admin                                  # http://127.0.0.1:5179/
SF_ADMIN_TOKEN=$(openssl rand -hex 16) SF_ADMIN_HOST=0.0.0.0 npm run admin   # exposed
```

Benchmark runs take either a single URL or a corpus manifest, and the tag becomes `runs/<tag>/`:

```bash
npm run clone -- https://example-business.ca adhoc   # one site, captured and scored
npm run clone -- corpus/sites.json round6            # manifest: {"sites":[{"name":..,"url":..,"vertical":..,"platform":..}]}
SF_LIMIT=5 npm run clone -- corpus/sites.json smoke  # first 5 entries only
```

The 60-site benchmark manifest is not in this repository, for the reason given above; any JSON file
of that shape works.

Tests:

```bash
node test/unit.mjs             # extraction and sanitization units; needs npm run build, no network
bash scripts/smoke-admin.sh    # admin end-to-end; needs a working Chromium
node test/slots.mjs            # clone-track units; fixtures are the real clone output in
                               # runs/round5/, so it only runs after a batch tagged round5
```

Environment: `SF_ADMIN_PORT` (5179), `SF_ADMIN_HOST` (127.0.0.1), `SF_ADMIN_TOKEN`,
`SF_JOB_TIMEOUT` (240000ms), `SF_CONCURRENCY` (1), `SF_TIMEOUT` (240000ms), `SF_LIMIT`,
`SF_FREEZE` (`interval`), `SF_CHROME_CHANNEL`, and `SF_ALLOW_PRIVATE=1` to allow private-network
URLs in development.

## Limitations

- **Extraction is deterministic and heuristic by design.** It reads what is on the page. It does
  not write marketing copy, and it will not rescue a source site whose content is genuinely thin.
- **No confidence scoring yet.** A wrong phone number is worse than a blank one, and the pipeline
  currently renders whatever it extracted. Per-field confidence with a "do not render below
  threshold" gate, and a human confirmation card for name, address and phone, are the next P0 items.
- **Clone-track edits do not survive a re-capture.** Re-fetching re-runs the capture and rewrites
  `slots.json`. The anchor-based merge is designed but not built, and the per-slot `locked` flag is
  settable through the API but is not yet honoured on refetch.
- **Mobile is checked, not scored.** The benchmark is desktop-only and `mobile-check.mjs` is a
  pass/fail gate. Headless Chromium costs roughly 0.5–1GB per worker, so the batch runner defaults
  to concurrency 1, and volume work needs a dedicated render box.
- **Single-page output on the forge track.** `crawl.ts` can capture whole sites, but the forge
  template still produces one page.
- **Redistribution licensing is unresolved.** Third-party fonts and imagery pulled into cloned
  output raise a licensing question that is flagged in the roadmap and not yet answered.

Roadmap, in priority order: confidence gating and NAP confirmation, custom domain binding with 301
maps generated from the crawl, vertical-aware calls to action, mobile viewport scoring, an LLM
copy-refinement layer on top of the deterministic extraction, multi-tenant regeneration and deploy.

## Why this exists

The typical Metro Vancouver trade or clinic in this corpus pays an annual fee for a static brochure
page and an email form, on a platform they cannot leave without losing the site. The value they
actually receive is their name, their services, their phone number and their hours, findable on
Google, with a way to be contacted. That is a static file and a lead endpoint. SiteForge exists to
produce exactly that, from the site they already have, in one pass, and then to hand them an editor
simple enough that they never need to ask anyone to change their opening hours again.

MIT licensed.
