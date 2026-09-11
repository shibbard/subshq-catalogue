# Subs HQ catalogue

**How to cancel things.** A public, machine-readable record of what each
subscription service costs, how you actually get out of it, what they'll try when
you attempt to, and what notice you have to give.

This is the data behind [Subs HQ](https://github.com/shibbard/subshq), but it is
useful on its own and deliberately not locked to it. Anyone can read the file.

```
https://shibbard.github.io/subshq-catalogue/catalogue.json
```

## Why this exists separately

A cancellation route that changed this morning shouldn't wait on an app-store
review. Keeping the data in its own repo means a correction is a pull request,
every change has an audit trail, and the fix reaches people the same day.

## The honest state of it

Most entries are **not verified**. They carry `"verified": null`, and any app
using this file is expected to say so plainly rather than presenting them as
fact.

- **Cancellation routes** are seeded from well-known, stable flows. A good
  starting point; not a guarantee.
- **Prices** are only present where someone has checked them against the
  service's own page, and every priced entry must carry `price_verified` and a
  `source` URL. The build refuses any that don't.

`price_verified` is separate from `verified` on purpose. Prices and cancellation
steps get checked at different times, and one field for both would overstate
whichever was checked less recently.

**Verifying entries is the real work here.** The code is a weekend; the data is
the point.

## Contributing

The most valuable contribution is checking one service you actually pay for and
correcting what's wrong.

1. Edit `data/seed.json`, or add a new file under `data/` — each file may hold a
   single entry or an array.
2. Set `verified` to today's date if you checked the cancellation steps against
   the service's own site.
3. Run `node build.mjs`. It validates everything and fails on bad data.
4. Open a pull request saying what you checked and how.

Please don't guess a price. A null price is honest; a wrong one is worse than
nothing, because someone will trust it.

## Entry shape

```jsonc
{
  "id": "netflix-uk",
  "name": "Netflix",
  "aliases": ["netflix.com"],
  "category": "streaming",
  "region": "GB",
  "domain": "netflix.com",
  "color": "#E50914",
  "plans": [
    { "id": "standard", "name": "Standard",
      "price": { "amount": 1399, "currency": "GBP", "cycle": "monthly" } }
  ],
  "price_verified": "2026-09-10",
  "source": "https://help.netflix.com/en/node/24926",
  "match": ["NETFLIX.COM", "NETFLIX"],   // bank statement descriptors
  "cancel": {
    "difficulty": 1,                      // 1 easy … 5 obstructive
    "url": "https://www.netflix.com/cancelplan",
    "channels": ["web"],                  // web | app | phone | email | post | chat
    "steps": ["…"],
    "notice_period_days": 0,
    "retention_tactics": ["…"],           // what they'll offer to keep you
    "gotchas": ["…"],
    "refund_policy": "none"
  },
  "verified": null                        // ISO date once a human has checked
}
```

Money is always an **integer in minor units** — 1399 is £13.99. Never a float.

## Icons

Brand marks are single-colour SVGs from [Simple Icons](https://simpleicons.org)
(CC0), committed under `icons/` and named after the entry — `netflix-uk.svg` for
`netflix-uk`. `node scripts/enrich-icons.mjs` matches entries to brands, writes
the SVGs and sets each entry's `icon` and `color`. The build copies them into
`dist/icons`, and fails if an `icon` isn't `<id>.svg` or has no file.

Apps should ship these glyphs rather than fetch them at runtime: an app
requesting netflix.com's icon while it's open would tell Netflix, or whoever
served the icon, that the user tracks a Netflix subscription.

## Licence

The data is CC0: use it for anything, no attribution needed. If you're building
something that helps people cancel subscriptions, that's a good outcome.

Service names and marks belong to their respective owners and are referenced
here to identify the services described.
