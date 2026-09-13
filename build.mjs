#!/usr/bin/env node
// Builds data/*.json into dist/catalogue.json, the feed the app fetches.
//
// Each file in data/ may hold a single entry or an array of entries, so the
// seed can start as one file and be split per-service later without changing
// this script.
//
// Deliberately has no dependencies: it runs with plain node.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, 'data');
const OUT_DIR = path.join(here, 'dist');
const OUT = path.join(OUT_DIR, 'catalogue.json');

const SCHEMA = 1;

/**
 * The highest version any shipped app has already cached. The feed must never
 * publish below this, or a client falling back to the version comparison would
 * treat its stale copy as newer and stop updating.
 */
const MIN_VERSION = 15;
const HEX = /^#[0-9A-Fa-f]{6}$/;

const VALID_CATEGORIES = new Set([
  'streaming', 'music', 'software', 'ai', 'gaming', 'fitness', 'news',
  'utilities', 'mobile', 'insurance', 'finance', 'food', 'shopping',
  'storage', 'education', 'other',
]);
const VALID_CHANNELS = new Set(['web', 'app', 'phone', 'email', 'post', 'chat']);
const VALID_CYCLES = new Set(['weekly', 'monthly', 'quarterly', 'biannual', 'annual', 'custom']);
// Who takes the money when it isn't the service itself. Matches the app's
// `billedVia`; an absent field means the service bills you directly.
const VALID_BILLERS = new Set(['apple', 'google']);

/** Two entries with this key are the same service, whatever their ids. */
function nameKey(name) {
  return name.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Checks that need the whole catalogue rather than one entry at a time.
 *
 * Duplicate names: the Wikipedia import deduplicated on id and domain only, so
 * a stub "Amazon Prime" on amazon.com sat beside the priced "Amazon Prime" on
 * amazon.co.uk. Searching showed both, and a first-run screen of services to
 * tap would show both side by side. Five such pairs had accumulated.
 *
 * Includes: a bundle pointing at an entry or plan that doesn't exist would
 * silently stop warning anyone about paying twice.
 */
function validateCatalogue(entries) {
  const byName = new Map();
  for (const entry of entries) {
    if (typeof entry.name !== 'string') continue;
    const key = nameKey(entry.name);
    if (byName.has(key)) {
      errors.push(`${entry.id}: same service as ${byName.get(key)} — merge them rather than keeping two`);
    } else {
      byName.set(key, entry.id);
    }
  }

  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const entry of entries) {
    // Where someone can see what they pay and when it renews. Linked, never
    // fetched, so it costs nothing in privacy.
    if (entry.manage_url !== undefined) {
      check(entry.id, typeof entry.manage_url === 'string' && entry.manage_url.startsWith('https://'),
        'manage_url must be an https URL');
    }
    for (const plan of entry.plans ?? []) {
      for (const inc of plan.includes ?? []) {
        const target = byId.get(inc.entry);
        check(`${entry.id}/${plan.id}`, Boolean(target), `includes unknown entry "${inc.entry}"`);
        if (target && inc.plan !== undefined) {
          check(`${entry.id}/${plan.id}`, (target.plans ?? []).some((p) => p.id === inc.plan),
            `includes unknown plan "${inc.entry}/${inc.plan}"`);
        }
      }
    }
  }
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warnings = [];

function check(id, condition, message) {
  if (!condition) errors.push(`${id}: ${message}`);
}

function validate(entry, seenIds) {
  const id = entry.id ?? '(missing id)';

  check(id, typeof entry.id === 'string' && entry.id.length > 0, 'id is required');
  check(id, !seenIds.has(entry.id), 'duplicate id');
  seenIds.add(entry.id);

  check(id, typeof entry.name === 'string' && entry.name.length > 0, 'name is required');
  check(id, VALID_CATEGORIES.has(entry.category), `category "${entry.category}" is not in the fixed list`);
  // Region is optional: a service with no cancellation steps yet has no
  // region-specific claim to make, and asserting one would be invention.
  if (entry.region !== undefined) {
    check(id, /^[A-Z]{2}$/.test(entry.region), 'region must be an ISO alpha-2 code');
  }
  check(id, typeof entry.domain === 'string' && entry.domain.includes('.'), 'domain is required');

  // `match` is generated from the name when absent — see normaliseEntry.
  if (entry.match !== undefined) {
    check(id, Array.isArray(entry.match) && entry.match.length > 0, 'match must not be an empty array');
  }

  // Price is optional but must be honest when present. PRD §8.1: minor units.
  if (entry.price !== null && entry.price !== undefined) {
    check(id, Number.isInteger(entry.price.amount), 'price.amount must be an integer in minor units');
    check(id, typeof entry.price.currency === 'string', 'price.currency is required');
    check(id, VALID_CYCLES.has(entry.price.cycle), 'price.cycle is not a valid cycle');
  }

  // A stub — an entry with no cancel block — is a legitimate state. It gets a
  // service into search with its name so a subscription can be added,
  // while being honest that nobody has worked out how to leave it yet. The app
  // shows those differently from a service that is missing entirely.
  const c = entry.cancel;
  if (c) {
    check(id, Number.isInteger(c.difficulty) && c.difficulty >= 1 && c.difficulty <= 5, 'cancel.difficulty must be 1-5');
    check(id, Array.isArray(c.channels) && c.channels.length > 0, 'cancel.channels is required');
    for (const ch of c.channels ?? []) {
      check(id, VALID_CHANNELS.has(ch), `cancel.channels contains unknown channel "${ch}"`);
    }
    check(id, Array.isArray(c.steps) && c.steps.length > 0, 'cancel.steps is required');
    check(id, Number.isInteger(c.notice_period_days), 'cancel.notice_period_days must be an integer');
    if (c.channels?.includes('web')) {
      check(id, typeof c.url === 'string' && c.url.startsWith('https://'), 'a web channel needs an https cancel.url');
    }
    if (c.channels?.includes('phone')) {
      check(id, typeof c.phone === 'string', 'a phone channel needs cancel.phone');
    }
  }

  // verified: null is legitimate and means "not checked against source".
  // It is not an error, but the UI must surface it, so warn loudly at build time.
  if (entry.verified === null || entry.verified === undefined) {
    if (c) warnings.push(`${id}: unverified — the app will label this entry as unchecked`);
  } else {
    check(id, ISO_DATE.test(entry.verified), 'verified must be an ISO date or null');
  }

  if (entry.color !== undefined) {
    check(id, HEX.test(entry.color), 'color must be a 6-digit hex like "#E50914"');
  }

  // No logos. This data is public domain, and nobody can grant that for a
  // company's logo, so apps bundle their own, named after the entry id.
  check(id, entry.icon === undefined,
    'icon is not part of this public data: apps bundle their own logos, named after the entry id');

  if (entry.plans !== undefined) {
    check(id, Array.isArray(entry.plans) && entry.plans.length > 0, 'plans must be a non-empty array');
    const planIds = new Set();
    for (const plan of entry.plans ?? []) {
      const label = `${id}/${plan.id ?? '(no id)'}`;
      check(label, typeof plan.id === 'string' && plan.id.length > 0, 'plan needs an id');
      check(label, !planIds.has(plan.id), 'duplicate plan id');
      planIds.add(plan.id);
      check(label, typeof plan.name === 'string' && plan.name.length > 0, 'plan needs a name');

      // Prices carry their own region, date and source. A price nobody can
      // trace back to the page it came from is an assertion, not a fact, and
      // the whole point of this file is that its claims are checkable.
      if (plan.includes !== undefined) {
        check(label, Array.isArray(plan.includes) && plan.includes.length > 0, 'includes must be a non-empty array');
        for (const inc of plan.includes ?? []) {
          check(label, typeof inc.entry === 'string', 'each includes item needs an entry id');
        }
      }

      // Two rows may share a region and cycle when they differ in currency or in
      // who bills: Fitbod sells a year at $95.99 on its site and £99.99 through
      // the App Store, and both are true.
      const seenRegions = new Set();
      for (const price of plan.prices ?? []) {
        const pl = `${label}/${price.region ?? '(no region)'}`;
        const key = `${price.region}:${price.currency}:${price.cycle}:${price.billed_via ?? 'direct'}`;
        check(pl, /^[A-Z]{2}$/.test(price.region ?? ''), 'price.region must be an ISO alpha-2 code');
        check(pl, !seenRegions.has(key), 'duplicate region, currency, cycle and biller for this plan');
        seenRegions.add(key);
        if (price.billed_via !== undefined) {
          check(pl, VALID_BILLERS.has(price.billed_via), `billed_via must be one of ${[...VALID_BILLERS].join(', ')}`);
        }

        // An annual plan recorded at its monthly equivalent annualises to the
        // right figure, which is why it went unnoticed, but every date built on
        // it is wrong: the app shows £15 due each month instead of £180 once a
        // year. Record what is charged, when it is charged. The one legitimate
        // exception is a yearly contract that really is billed each month.
        const describesYear = /annual|yearly|per year|\/year/i.test(`${plan.name} ${price.note ?? ''}`);
        if (price.cycle === 'monthly' && describesYear) {
          check(pl, /billed monthly/i.test(price.note ?? ''),
            'looks like an annual plan stored as a monthly amount. Use cycle "annual" with the amount charged, or say "billed monthly" in the note if that is genuinely how it is charged');
        }
        check(pl, Number.isInteger(price.amount), 'price.amount must be an integer in minor units');
        check(pl, typeof price.currency === 'string' && /^[A-Z]{3}$/.test(price.currency), 'price.currency must be ISO 4217');
        check(pl, VALID_CYCLES.has(price.cycle), 'price.cycle is not a valid cycle');
        check(pl, ISO_DATE.test(price.verified ?? ''), 'a price needs the date it was checked');
        check(pl, typeof price.source === 'string' && price.source.startsWith('http'), 'a price needs the URL it was read from');

        // Whether a figure includes VAT is not cosmetic: it decides whether an
        // app can offer the number as-is or has to ask what the user was
        // actually charged. UK consumer prices are quoted inclusive, US ones
        // never are, and a US vendor billing a UK customer may add VAT at
        // checkout without it appearing anywhere on the pricing page.
        //
        // `null` is the honest value when the page did not say, and is
        // deliberately distinct from the field being left off — the first is a
        // finding, the second is an oversight.
        check(pl, 'tax_included' in price,
          'a price must state tax_included: true, false, or null when the page did not say');
        check(pl, price.tax_included === true || price.tax_included === false || price.tax_included === null,
          'tax_included must be true, false or null');
      }
    }
  }

  if (entry.rights) {
    check(id, typeof entry.rights.source === 'string' && entry.rights.source.startsWith('http'),
      'rights.source must link to the source; never state rights without one');
  }
}

/**
 * A monotonic version for the published feed: the repository's commit count.
 *
 * This used to be read back out of the last `dist/catalogue.json` and
 * incremented. `dist/` is gitignored, so CI never had a previous build and
 * every publish shipped version 1 — the counter had been dead since the day it
 * was written, and the comment claiming "CI bumps it on merge" described
 * something that could not happen.
 *
 * It mattered less than it looks because consumers compare `generated` first.
 * But that left one missing field between a stale cache and a feed that never
 * updates again: a v1 publish loses the fallback comparison to any cache with
 * a higher number, permanently. The commit count cannot regress on a branch,
 * needs no state carried between builds, and survives the clean checkout that
 * broke the old scheme.
 *
 * CI must check out full history for this — see .github/workflows/publish.yml.
 * A shallow clone reports 1 and would reintroduce the original bug, so a
 * suspiciously low count is treated as a failure rather than published.
 */
function catalogueVersion() {
  let count;
  try {
    count = Number(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: here,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    // No git: a tarball or an unpacked release. Nothing here can be trusted to
    // be monotonic, so say so rather than invent a number that might go
    // backwards for whoever is already running an older copy.
    console.error('');
    console.error('Cannot read the git history, so the feed version cannot be');
    console.error('determined. Build from a git checkout.');
    console.error('');
    process.exit(1);
  }

  if (!Number.isInteger(count) || count < MIN_VERSION) {
    console.error('');
    console.error(`Refusing to publish version ${count}: that is below the`);
    console.error(`${MIN_VERSION} already shipped, so an app holding a newer`);
    console.error('cached copy would ignore this feed if it ever fell back to');
    console.error('comparing version numbers.');
    console.error('');
    console.error('This is almost always a shallow clone. CI needs:');
    console.error('');
    console.error('  - uses: actions/checkout@v4');
    console.error('    with:');
    console.error('      fetch-depth: 0');
    console.error('');
    process.exit(1);
  }

  return count;
}

/**
 * Fills in what can be derived rather than demanding it be typed. A bank
 * descriptor is almost always the service name in capitals, so that is the
 * default; anything unusual still has to be listed explicitly.
 */
function normaliseEntry(entry) {
  if (!entry.match && typeof entry.name === 'string') {
    entry.match = [entry.name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim()];
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.json')).sort();
  const entries = [];

  for (const file of files) {
    const raw = await readFile(path.join(DATA_DIR, file), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push(`${file}: not valid JSON — ${err.message}`);
      continue;
    }
    entries.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }

  for (const entry of entries) normaliseEntry(entry);

  const seenIds = new Set();
  for (const entry of entries) validate(entry, seenIds);
  validateCatalogue(entries);

  if (errors.length > 0) {
    console.error(`\nCatalogue build failed with ${errors.length} error(s):\n`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error('\nA malformed entry must fail the build, not ship.\n');
    process.exit(1);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const version = catalogueVersion();

  const catalogue = {
    schema: SCHEMA,
    version,
    // Required, and the field consumers compare first. A feed without it falls
    // back to `version`, which is why that number has to be trustworthy too.
    generated: new Date().toISOString(),
    entries,
  };

  await writeFile(OUT, JSON.stringify(catalogue, null, 2) + '\n', 'utf8');

  const stubs = entries.filter((e) => !e.cancel).length;
  const withSteps = entries.length - stubs;
  // Only an entry that HAS cancellation steps can meaningfully be unverified;
  // a stub has nothing to verify yet.
  const unverified = entries.filter((e) => e.cancel && !e.verified).length;
  console.log(`\nBuilt ${entries.length} entries → dist/catalogue.json (v${version})`);
  if (warnings.length > 0) {
    console.log(`\n${unverified} of ${entries.length} entries are unverified:`);
    for (const w of warnings.slice(0, 5)) console.log(`  ! ${w}`);
    if (warnings.length > 5) console.log(`  ! …and ${warnings.length - 5} more`);
    console.log('\nVerifying these against source is the real work of this product.\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
