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
  service's own page, and every price must carry its own `verified` date,
  `source` URL and `tax_included` basis. The build refuses any that don't.

A price's `verified` is separate from the entry's on purpose. Prices and
cancellation steps get checked at different times, and one field for both would
overstate whichever was checked less recently.

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
  "manage_url": "https://www.netflix.com/account", // where you see your plan and renewal date
  "plans": [
    { "id": "standard", "name": "Standard",
      "includes": [{ "entry": "…", "plan": "…" }], // other services this plan comes with
      "prices": [
        { "region": "GB", "amount": 1399, "currency": "GBP", "cycle": "monthly",
          "tax_included": true,            // true | false | null — see below
          "billed_via": "apple",           // optional: apple | google, when they bill instead
          "verified": "2026-09-10",
          "source": "https://www.netflix.com/signup/planform" }
      ] }
  ],
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

Prices live per plan and carry their own region, date and source, because the
UK price may be checked today and the US price a year later.

### `tax_included`

Required on every price, and one of three values:

| Value | Means |
| --- | --- |
| `true` | The page stated the figure includes VAT or sales tax |
| `false` | The page stated tax is added on top |
| `null` | The page did not say |

`null` is a finding, not a blank. Leaving the field off entirely is an error and
the build rejects it, because "nobody looked" and "the page was silent" are
different facts and an app has to treat them differently.

This matters more than it looks. UK consumer prices are quoted inclusive of VAT;
US prices never are; and a US vendor billing a UK customer may add 20% at
checkout that appears nowhere on the pricing page — Ideogram's $20.00 plan
charges a UK customer $24.00. An app that shows the headline figure as the
amount someone pays would be wrong by a fifth, with no way to tell.

### Cycles: record what is charged, when it is charged

An annual plan is `"cycle": "annual"` with the yearly amount — £180, not "£15 a
month". The monthly equivalent annualises to the same total, which is why it
slips through, but every date built on it is wrong: an app would show £15 due
each month instead of £180 once a year. The build rejects a monthly price whose
plan or note says annual, unless the note says it is genuinely "billed monthly".

### `billed_via`

Optional, `apple` or `google`, for a price charged through an app store rather
than by the service. The same plan can cost different amounts depending on who
bills: Fitbod's year is $95.99 on its site and £99.99 through the App Store.
Both are true, so both are recorded, and a plan may hold two prices for the
same region and cycle as long as the currency or biller differs.

### `includes`

What a plan comes with that is also sold on its own — Google AI Pro includes
YouTube Premium Lite; Apple One Premier includes iCloud+ 2 TB, Apple Music and
Apple TV. Each item names an `entry` id and, optionally, a `plan` id, and the
build fails if either doesn't exist. Apps use it to warn someone before they
track, and pay for, something they already have.

### `manage_url`

Where a subscriber can see their own plan, price and renewal date. Not the
cancel route, though often the same page. For anything billed through Apple it
is `https://apps.apple.com/account/subscriptions`. It is only ever a link the
user taps: never fetched.

## Logos

There aren't any. This data is public domain, and nobody can grant that for a
company's logo, so logos aren't part of it and the build rejects an `icon`
field. Apps bundle their own, named after the entry `id`, and shouldn't fetch
one at runtime: an app requesting netflix.com's logo while it's open would tell
Netflix, or whoever served it, that the user tracks a Netflix subscription.

`color` is a brand colour — a fact about the brand, for drawing a letter tile —
and is part of the data. `node scripts/enrich-colours.mjs` sets it from
[Simple Icons](https://simpleicons.org).

## Licence

The data is CC0: use it for anything, no attribution needed. If you're building
something that helps people cancel subscriptions, that's a good outcome.

Service names and marks belong to their respective owners and are referenced
here to identify the services described.
