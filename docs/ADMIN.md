# SiteForge Admin Console

A single-process operations console for the sites SiteForge generates: site list, content and theme
editing that re-renders on save, "create from a URL" jobs, a lead inbox, a batch-quality dashboard,
and an action audit log.

Two decisions shape the rest of the design.

**The filesystem is the database.** Every site is a directory under `sites/<slug>/` and its state is
plain JSON. A forge site holds `content.json`, `theme.json` and `capture.json`; a clone site holds
`skeleton.html`, `slots.json` and the capture's `meta.json`; either may carry a `site.json` with the
publishing metadata. Alongside them sit `assets/` and the built `index.html`. There is no database
and no migration step, so `cat`, `grep`, `git diff` and `rsync` all work directly on the live state.

**The console adds no dependency of its own.** The HTTP layer is `node:http`: no framework, no
router, no body parser. The render path calls the same functions the CLI calls (`renderPage` for the
forge track, `renderSlots` for the clone track) and so inherits their existing dependencies, React
for forge and cheerio for clone. An edit saved in the console produces the same output as a CLI
build.

Source: [`src/admin/server.ts`](../src/admin/server.ts), 1,091 lines. UI:
[`admin-ui/index.html`](../admin-ui/index.html), a single file with one inline `<script>` and no
external assets.

> The bundled UI is written in Chinese. The HTTP API, the source and this document are in English;
> the screen names used below are translations of the tab labels you will actually see.

## Quick start

```bash
npm run build
npm run admin                       # listens on 127.0.0.1:5179 by default
# open http://127.0.0.1:5179/
```

`npm run admin` runs `dist/admin/server.js`, so it needs a build first. The server reads
`admin-ui/index.html` from the project root at request time and returns HTTP 500 if it is missing.

The default bind address is loopback only. To reach the console from another machine you have to opt
in, and you should set a token at the same time:

```bash
SF_ADMIN_HOST=0.0.0.0 SF_ADMIN_TOKEN=$(openssl rand -hex 16) npm run admin
```

With `SF_ADMIN_TOKEN` set, the UI's first API call comes back `401`; it then prompts for the token
and stores it in `localStorage`. Without a token the console runs unauthenticated and prints a
startup warning.

## Two render tracks

`site.json` records a `track`, and it decides which renderer rebuilds the page. When `site.json` is
absent the server defaults to `forge` — the forge CLI does not write one, so a site built with
`npm run forge` has no `site.json` until its first save from the console.

| Track | Editing surface | Rebuild path |
|---|---|---|
| `forge` | `content.json` + `theme.json`: structured fields and a brand palette, rendered through SiteForge's own template | `renderPage(content, theme)` |
| `clone` | `slots.json`: the captured page skeleton is frozen and only annotated slots (text, links, images, head fields) are editable | `renderSlots(skeleton, slots)` |

Neither rebuild launches a browser or touches the network. Both read local files and write
`index.html`, which is why the rest of the console — leads, meta, assets, audit, deletion — behaves
identically on the two tracks.

`track` is close to immutable, but not quite. `sanitizeMeta` keeps an existing `clone` value whatever
the request body says, so a clone site can never be turned into a forge site. A forge site, however,
*will* be switched to `clone` if a `PUT .../meta` body contains `"track": "clone"`, and it is then
unrenderable because it has no `skeleton.html`. Do not send `track` in a meta update.

**Scope note.** The bundled UI implements the forge editing surface only: content, theme,
SEO/publish, leads, advanced. Clone sites are fully served by the HTTP API (`GET|PUT /slots`,
`GET /assets`) but have no screen of their own, and opening one in the UI editor fails outright,
because the editor reads `content.brandName` from a payload a clone site does not have. On top of
that, `POST /api/sites` defaults to `track: "clone"` and the UI's own "create site" button does not
send a `track`, so the button produces exactly the kind of site the UI cannot then open. Call the API
with `"track": "forge"` to get an editable one. This is a known gap, not a hidden feature.

## What the console does

| Screen | What it does |
|---|---|
| Sites | Grid of all sites, each with a five-swatch strip of the palette (`primary`, `primaryDark`, `bg`, `surface`, `text`), a badge showing the total lead count, and the `index.html` mtime as the last build time. Paste a customer URL to create a site; that runs as an async job on a single-concurrency queue, and the job table polls every 2.5 s with the job log one click away. |
| Site → Content | Brand name, tagline, about text, add/edit/remove service cards, contact block. Logo and hero upload (PNG / JPEG / WebP / GIF, 8 MB max). |
| Site → Brand theme | All eight palette roles, each with a color picker and a hex field. Accent and background colors harvested during capture are offered as swatches; clicking an accent sets `primary`, darkens it 16% for `primaryDark`, and picks black or white for `onPrimary` by luminance. Heading and body font families. |
| Site → SEO / Publish | Production `baseUrl`, lead-form toggle, operator notes. SEO self-check of the current `index.html`: visible text length, `<h1>`, `meta description`, JSON-LD, `og:image`, `canonical` and the page title. |
| Site → Leads | Inbox, newest first. Rows newer than the `leadsSeenAt` watermark are bolded and tagged; one button marks everything read. |
| Site → Advanced | Re-fetch the source site, behind a confirmation that says it will overwrite your edits, and delete the site, which requires typing the slug back. |
| Batch quality | Aggregates `runs/*/report.json`: mean, median and p10 fidelity score per batch. The drilldown lists sites in ascending score order (score = aligned pixel accuracy × height coverage), which is the manual-fix queue, and links to the cloned page and its `diff.png`. |
| Audit | The last 200 entries of `sites/.audit.jsonl`. |

`sites/` and `runs/` are both gitignored: they hold generated output and captured customer data. A
fresh clone of this repo therefore starts with an empty console, and the batch-quality screen stays
empty until you produce a run locally with `npm run clone`.

Every save rebuilds `index.html` through the track's render function before responding, and the
preview iframe reloads against the real generated file.

Deleting a site is a `rename` into `sites/.trash/<slug>-<epoch-ms>/`, never an unlink, so recovery is
a `mv`.

## Publishing metadata

`PUT /api/sites/:slug/meta` writes `site.json` and rebuilds. The fields that matter operationally:

- **`baseUrl`** — the production origin. Only when it is set does the rebuild emit `sitemap.xml` and
  `robots.txt` next to `index.html`, and only then do `canonical` and `og:url` appear at all.
- **`formEnabled`** — puts the lead form on the generated page. The tracks do this differently: forge
  renders a new `<form class="sf-form">`, while clone re-points the customer's own forms at the lead
  endpoint, adding the honeypot field and dropping search forms. A cloned page that had no form of
  its own gains none.
- **`indexable`** — defaults to `false`, deliberately. While the customer's original site is still
  live, a near-identical copy competes with it for the same queries. Two separate things follow from
  the flag, with different scopes: `robots.txt` becomes a blanket `Disallow: /`, but only when
  `baseUrl` is set, since otherwise no `robots.txt` is written at all; and the clone renderer adds
  `<meta name="robots" content="noindex,nofollow">`. The forge template emits no robots meta tag, so
  a forge site with no `baseUrl` carries no indexing signal either way. Turn `indexable` on only once
  the customer has signed and the old site is 301-redirected to the new domain. The UI does not
  expose this field; set it through the API.
- **`notes`** and **`leadsSeenAt`** — operator notes and the "read up to here" watermark for the
  inbox.

`sanitizeMeta` rewrites `site.json` from these fields alone, so any extra keys an earlier writer left
there — the clone CLI stores `sourceUrl` and `finalUrl` — are dropped on the first meta save.

## Lead form

- Endpoint: `POST /api/leads/<slug>`. Public, unauthenticated, `Access-Control-Allow-Origin: *`,
  accepts `application/x-www-form-urlencoded` or `application/json`. `OPTIONS` returns 204.
- Fields: `name`, `phone`, `email`, `message`. A hidden `_hp` honeypot discards the submission and
  returns a fake `200` when non-empty. All four fields empty returns `400`; a body over 10 KB returns
  `413`.
- Storage: one JSON line per lead appended to `sites/<slug>/leads.jsonl`, with a timestamp and a
  truncated User-Agent.
- A plain browser form POST gets a small HTML thank-you page back; a JSON request gets `{ok:true}`.
- The form's `action` is `${SF_PUBLIC_ORIGIN}/api/leads/<slug>`. Set `SF_PUBLIC_ORIGIN` when the
  generated site is served from a different host than the admin server; with it unset the action is a
  same-origin relative path.

## HTTP API

```
GET    /api/health                              { ok, sites, tokenRequired }
GET    /api/sites                               list (both tracks) + jobRunning flag
POST   /api/sites          {url, slug?, track?} create — async job, 202 + job id
                                                track defaults to "clone"
GET    /api/sites/:slug                         detail: content/theme (forge) or slot summary
                                                (clone), plus meta, SEO self-check, lead count
PUT    /api/sites/:slug/content                 forge only — validate, save, rebuild
PUT    /api/sites/:slug/theme                   forge only — validate, save, rebuild
PUT    /api/sites/:slug/meta                    baseUrl / formEnabled / indexable / notes /
                                                leadsSeenAt — saves and rebuilds
GET    /api/sites/:slug/slots                   clone only — full slot table
PUT    /api/sites/:slug/slots  {edits, lock?, unlock?}
                                                clone only — apply {slotId: value} edits, rebuild
GET    /api/sites/:slug/assets                  captured image inventory with size + reference count
POST   /api/sites/:slug/asset  {dataUrl, kind|target}
                                                upload: kind=logo|hero, or target=assets/<hash>.<ext>
                                                to overwrite an existing asset in place
POST   /api/sites/:slug/rebuild                 re-render only
POST   /api/sites/:slug/refetch                 re-capture the source site — async job
DELETE /api/sites/:slug                         move to sites/.trash/
GET    /api/sites/:slug/leads                   lead list, newest first
POST   /api/leads/:slug                         (public) submit a lead
GET    /api/jobs                                last 50 jobs, without log bodies
GET    /api/jobs/:id                            single job including its log
GET    /api/runs                                batch summaries from runs/*/report.json
GET    /api/runs/:tag                           one batch's full report
GET    /api/audit                               last 200 audit entries
static /sites/**  /runs-files/**                preview (see the static-route rules below)
```

Worth knowing before you script against this:

- Everything under `/api/*` requires `Authorization: Bearer <SF_ADMIN_TOKEN>` when a token is set,
  except `POST /api/leads/:slug`, which is public by design because published sites post to it.
- Edit endpoints return `{ok:true}` on success and `{error:"..."}` with a `4xx`/`5xx` status
  otherwise. A rebuild failure after a successful save surfaces as `500` with the render error, so
  the response status does not tell you whether the file on disk changed.
- Asset overwrite-in-place is the general answer to image editing on the clone track. Capture stores
  every asset as `assets/<sha1>.<ext>`, so writing new bytes to the same filename takes effect
  whether the image is referenced from `img@src`, an inline `style`, or a `url()` inside a
  stylesheet. No DOM analysis is needed.
- Slot edits are capped at 2,000 characters for `text` slots and 500 for everything else (`link`,
  `image`, `head`), the request body at 4 MB, and `link`/`image` slots reject `javascript:`,
  `vbscript:`, `file:`, `about:` and `blob:` values. `lock` / `unlock` mark slots that a later
  re-fetch must not overwrite.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SF_ADMIN_PORT` | `5179` | Listening port. A non-numeric or non-positive value warns and falls back to the default rather than degrading to a random port or `NaN`. |
| `SF_ADMIN_HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` only together with `SF_ADMIN_TOKEN`. |
| `SF_ADMIN_TOKEN` | *(empty — no auth)* | Bearer token for `/api/*`. Mandatory whenever the console is reachable off-box. |
| `SF_PUBLIC_ORIGIN` | *(empty — relative URL)* | Public origin of this admin server, used to build the lead form's `action` in generated sites. |
| `SF_JOB_TIMEOUT` | `240000` | Hard timeout in ms for a create/re-fetch job. On expiry the whole process group is SIGKILLed. |
| `SF_ALLOW_PRIVATE` | *(off)* | `=1` allows private and loopback source URLs, disabling the SSRF check entirely. Development and testing only. |
| `SF_CHROME_CHANNEL` | *(empty)* | `=chromium` uses full Chromium's new headless mode instead of `headless-shell` — needed on hosts missing the `headless-shell` system libraries. |

## Security design

The console can drive a browser renderer and read and write every generated site, so it is treated as
a privileged surface.

- **Loopback by default.** `SF_ADMIN_HOST` defaults to `127.0.0.1`; exposing it on a network interface
  takes an explicit opt-in, and the startup banner warns if no token is set.
- **Bearer header only.** Authentication reads `Authorization: Bearer …` and deliberately does not
  accept a `?token=` query parameter, which would leak the token into access logs, `Referer` headers
  and browser history. The comparison is a length check followed by plain string equality: it is not
  constant-time, and failed attempts are neither counted nor throttled. The token gates access; it is
  not hardened against a determined online attack, so put the console behind a reverse proxy or a VPN
  if it has to be reachable.
- **Tiered preview routes.** `/sites/**` and `/runs-files/**` are unauthenticated on purpose, since
  generated sites are meant to be publicly viewable, so they serve only publishable web files: HTML,
  CSS, JS, images, fonts, XML and TXT. Operational sidecars are hard-404'd by extension and by path
  segment — any `.json` or `.jsonl`, and any segment starting with `.`, which covers `content.json`,
  `theme.json`, `site.json`, `capture.json`, `slots.json`, `leads.jsonl`, `.audit.jsonl` and
  `.trash/`. This closes the one HIGH finding of the admin server's own security re-review: lead PII
  readable through an unauthenticated static route.
- **Path traversal, defence in depth.** Slugs must match `^[a-z0-9][a-z0-9-]{0,63}$` and batch tags
  `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`. The static handler runs `decodeURIComponent` first, then the
  publishable-file allowlist, then `normalize()` plus a prefix check against the served root, so a
  percent-encoded `..` is rejected after decoding rather than before.
- **SSRF floor on every outbound fetch.** Create and re-fetch accept `http` and `https` only, and
  reject `localhost`, `0.0.0.0`, `*.local`, `*.internal` and the `10/8`, `127/8`, `172.16/12`,
  `192.168/16`, `169.254/16` and `0/8` IPv4 ranges; cloud metadata at `169.254.169.254` falls under
  the link-local rule. The check itself matches dotted-quad literals, but it runs on a `new URL()`
  hostname, and WHATWG parsing normalises `2130706433`, `0x7f000001` and `017700000001` to
  `127.0.0.1` before the check sees them, so those encodings are caught too. IPv6 literals are
  refused outright. The clone track's Node-side asset re-fetch goes through the same function.
  The caveat stated in the source stands: this is literal-value protection, and DNS rebinding needs
  network isolation upstream. Subresources the headless browser itself loads are not covered.
- **Preview CSP.** Preview responses carry
  `script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self' https:; frame-src https: data:`.
  An earlier version used `sandbox allow-forms allow-same-origin`, but `sandbox` strips scripting from
  child iframes too, which blanked out the Google Maps, YouTube and booking widgets embedded in
  customer sites. The current policy kills scripting in the top-level document — the clone step
  already strips `<script>`, and this also neutralises leftover inline handlers — while letting
  third-party iframes render under their own origin and CSP.
- **Upload validation.** Only raster `data:` URLs are accepted; SVG is refused outright as an
  active-content format. The declared MIME must match the actual magic bytes (PNG signature, JPEG
  `FF D8 FF`, `GIF`, `RIFF`/`WEBP`), and two size limits apply: 64 B to 8 MB for the decoded image and
  12 MB for the JSON body. For a `kind=logo|hero` upload the destination path is built server-side and
  never comes from the request. For an overwrite the `target` must match
  `assets/<hex-hash>.<image-ext>`, must not contain `..`, and must already exist. The `logo` and `hero`
  fields of `content.json` are separately constrained to the same `assets/` image-extension pattern.
- **Public lead endpoint hardening.** Honeypot field, a 10 KB request-body cap, and a 5,000,000-byte
  ceiling per site on `leads.jsonl` after which submissions return `429`, which bounds a disk-fill
  attack to roughly 5 MB per site. Per-IP rate limiting belongs on a reverse proxy in front and is not
  implemented here.
- **Server-side validation of every writable field.** Lengths, formats, `#rrggbb` colors, and a
  character allowlist for font strings. The last one matters because font family names are
  interpolated into a `<style>` block, and an unsanitised `</style>` would be an injection point.
- **Render jobs are contained.** One at a time, because the target deployment is a 1.9 GB box that
  cannot hold two Chromium instances (see `REVIEW-2026-07-18.md` findings 8 and 9). Jobs are spawned
  `detached`, so a timeout can SIGKILL the entire process group and leave no orphaned Chromium
  processes. The in-memory job table is capped at 100 entries with 64 KB of log each, evicting
  finished jobs first, so a long-running server does not grow without bound.

> These measures were introduced and verified during an internal adversarial review of the codebase.
> The findings and fixes are written up in [REVIEW-2026-07-18.md](REVIEW-2026-07-18.md); the admin
> server's own re-review is section 6. It was an internal exercise, not a third-party audit.

## Tests

```bash
npm run build && bash scripts/smoke-admin.sh
```

The smoke script stands up a fixture source site and an admin server on dedicated ports (5398 and
5399 by default, overridable via `SF_SMOKE_PORT_FIX` / `SF_SMOKE_PORT_ADMIN`), then walks the main
paths: the unit tests, health, a content edit followed by a rebuild and an assertion that the change
reached `index.html`, rejection of an invalid theme, a form-encoded lead submission, honeypot
filtering of a JSON submission, form injection, path traversal both raw and percent-encoded, sidecar
leakage, a forged-magic-byte upload, a malicious slug, and two end-to-end paths — forge and clone —
that create a site from the fixture URL, edit it and delete it. It prints a pass/fail tally and exits
non-zero on any failure. It writes into the real `sites/` directory and removes its own fixtures on
exit.

Three things to expect when you run it:

- The two end-to-end blocks need a working Chromium. If the render job does not reach `done`, the
  script prints a warning and skips those assertions instead of failing the run, so a green tally on a
  host without Chromium covers less than it looks like.
- One assertion is stale. It still greps the preview response for
  `content-security-policy: sandbox`, which the CSP change described above replaced, and so reports a
  failure even though the header is present and stricter than before.
- The script sets `SF_ALLOW_PRIVATE=1` so it can capture its own local fixture, which by definition
  disables the SSRF check, so it deliberately asserts nothing about SSRF. That path has to be
  exercised separately by calling `urlAllowed()` in an environment without `SF_ALLOW_PRIVATE`. It is
  not part of the automated suite today.

The unit tests the script invokes (`test/unit.mjs`, 12 assertions) cover the extraction and theming
layer: brand-name parsing, contact and address disambiguation, font-string XSS sanitisation, and the
contrast floor on derived text colors. They do not cover the admin server itself.

There is a second suite, `test/slots.mjs`, for the clone-track slot pipeline. The smoke script does
not run it, and it cannot run on a fresh clone of this repo: its fixtures are real capture output
under `runs/round5`, which is gitignored. Produce a batch locally first.
