# Benchmark corpus composition

The fidelity benchmark runs against 60 real small-business websites in Metro Vancouver.
The site list itself is not published — these are third-party businesses that did not
volunteer to be benchmark subjects. The composition and selection criteria are below, and
the full list is available on request.

## Selection criteria
- Independently owned small business in Metro Vancouver, not a franchise or chain.
- A live, reachable site with real content (services, contact details, hours) rather than a
  parked domain or a single splash image.
- Deliberately spread across CMS/platform families, so the capture path is exercised against
  both server-rendered HTML and JavaScript-injected content.

## Platform distribution (n = 60)

| Platform | Sites |
|---|---|
| wordpress | 25 |
| custom | 14 |
| wix | 6 |
| shopify | 4 |
| godaddy | 4 |
| squarespace | 3 |
| unknown | 2 |
| weebly | 2 |

## Vertical distribution

| Vertical | Sites |
|---|---|
| landscaping / lawn | 6 |
| tire / wheels | 6 |
| auto repair | 6 |
| auto glass | 6 |
| dental | 6 |
| barber / salon | 6 |
| restaurant / cafe | 6 |
| plumbing / HVAC | 6 |
| physiotherapy | 3 |
| chiropractic | 3 |
| bakery | 3 |
| florist | 3 |

Generated 2026-07-18.

## Corpus file format

The batch runner reads only `sites[].url`; `vertical` and `platform` are documentation. See
`corpus/example.json` for the shape, and supply your own targets:

```bash
npm run clone -- corpus/example.json round1
```
