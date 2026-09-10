#!/usr/bin/env node
// Builds data/*.json into dist/catalogue.json, the feed the app fetches.
//
// Each file in data/ may hold a single entry or an array of entries, so the
// seed can start as one file and be split per-service later without changing
// this script.
//
// Deliberately has no dependencies: it runs with plain node.

import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, 'data');
const OUT_DIR = path.join(here, 'dist');
const ICON_SRC = path.join(here, 'icons');
const OUT = path.join(OUT_DIR, 'catalogue.json');
const ICON_DIR = path.join(OUT_DIR, 'icons');

const SCHEMA = 1;
const FETCH_ICONS = process.argv.includes('--icons');
const HEX = /^#[0-9A-Fa-f]{6}$/;

const VALID_CATEGORIES = new Set([
  'streaming', 'music', 'software', 'ai', 'gaming', 'fitness', 'news',
  'utilities', 'mobile', 'insurance', 'finance', 'food', 'shopping',
  'storage', 'education', 'other',
]);
const VALID_CHANNELS = new Set(['web', 'app', 'phone', 'email', 'post', 'chat']);
const VALID_CYCLES = new Set(['weekly', 'monthly', 'quarterly', 'biannual', 'annual', 'custom']);
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
  // service into search with its name and icon so a subscription can be added,
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

  if (entry.plans !== undefined) {
    check(id, Array.isArray(entry.plans) && entry.plans.length > 0, 'plans must be a non-empty array');
    const planIds = new Set();
    for (const plan of entry.plans ?? []) {
      const label = `${id}/${plan.id ?? '(no id)'}`;
      check(label, typeof plan.id === 'string' && plan.id.length > 0, 'plan needs an id');
      check(label, !planIds.has(plan.id), 'duplicate plan id');
      planIds.add(plan.id);
      check(label, typeof plan.name === 'string' && plan.name.length > 0, 'plan needs a name');
      if (plan.price !== null && plan.price !== undefined) {
        check(label, Number.isInteger(plan.price.amount), 'plan price.amount must be an integer in minor units');
        check(label, typeof plan.price.currency === 'string', 'plan price.currency is required');
        check(label, VALID_CYCLES.has(plan.price.cycle), 'plan price.cycle is not a valid cycle');
      }
    }

    // A price without a checked date and a source is an assertion nobody can
    // audit. The whole point of this file is that its claims are traceable.
    const priced = (entry.plans ?? []).some((p) => p.price);
    if (priced) {
      check(id, ISO_DATE.test(entry.price_verified ?? ''), 'entries with prices need price_verified as an ISO date');
      check(id, typeof entry.source === 'string' && entry.source.startsWith('http'),
        'entries with prices need a source URL');
    }
  }

  if (entry.rights) {
    check(id, typeof entry.rights.source === 'string' && entry.rights.source.startsWith('http'),
      'rights.source must link to the source; never state rights without one');
  }
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

// --- icons -----------------------------------------------------------------
//
// Fetched at BUILD time only, from each service's own domain, and written into
// public/icons. Never at runtime: a request for netflix.com's favicon while the
// app is open would tell Netflix (or whichever proxy served it) that this user
// tracks a Netflix subscription. That is precisely the leak the whole design
// exists to avoid, and no visual polish is worth it.
//
// Run with `npm run catalogue -- --icons`. Without the flag the existing icons
// are left alone, so an ordinary build needs no network at all.

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/svg+xml': '.svg',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

// Ordered biggest-first. A 16px favicon.ico scaled up to a 40px tile looks
// exactly as bad as it sounds, so the large PNGs are tried well before it.
const ICON_PATHS = [
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/favicon-196x196.png',
  '/favicon-192x192.png',
  '/favicon-180x180.png',
  '/favicon-128.png',
  '/favicon-96x96.png',
  '/favicon-64x64.png',
  '/favicon-32x32.png',
  '/favicon.ico',
];

/** Reads the largest square declared inside an ICO directory. */
function icoMaxSize(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return 0;
  const count = buf.readUInt16LE(4);
  let max = 0;
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    if (off + 2 > buf.length) break;
    // 0 in the ICO header means 256.
    const w = buf[off] === 0 ? 256 : buf[off];
    if (w > max) max = w;
  }
  return max;
}

async function fetchIcon(entry) {
  // A small icon is worse than a big one but much better than none, so a
  // low-resolution find is held as a fallback rather than discarded.
  let fallback = null;

  for (const p of ICON_PATHS) {
    try {
      const res = await fetch(`https://${entry.domain}${p}`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: { accept: 'image/*' },
      });
      if (!res.ok) continue;

      // A 200 with an HTML body is a soft 404 — several large sites do this,
      // and without the content-type check you save a web page as a logo.
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const ext = EXT_BY_TYPE[type];
      if (!ext) continue;

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) continue;

      const declared = ext === '.ico' ? icoMaxSize(buf) : 0;
      // Below 32px there is nothing to salvage: scaled up to a 44px tile mark
      // it is mush, and the brand-colour monogram genuinely looks better.
      if (declared > 0 && declared < 32) continue;
      if (declared > 0 && declared < 48) {
        fallback ??= { ext, buf };
        continue;
      }

      const file = `${entry.id}${ext}`;
      await writeFile(path.join(ICON_DIR, file), buf);
      return file;
    } catch {
      // Timeout, DNS failure, TLS problem — try the next path, then give up.
    }
  }

  if (fallback) {
    const file = `${entry.id}${fallback.ext}`;
    await writeFile(path.join(ICON_DIR, file), fallback.buf);
    return file;
  }
  return null;
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

  if (errors.length > 0) {
    console.error(`\nCatalogue build failed with ${errors.length} error(s):\n`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error('\nA malformed entry must fail the build, not ship.\n');
    process.exit(1);
  }

  // Brand marks come from Simple Icons via scripts/enrich-icons.mjs and are
  // committed, so a build needs no network and is reproducible.
  await mkdir(ICON_DIR, { recursive: true });
  let copied = 0;
  const svgs = await readdir(ICON_SRC).catch(() => []);
  for (const f of svgs) {
    if (!f.endsWith('.svg')) continue;
    await copyFile(path.join(ICON_SRC, f), path.join(ICON_DIR, f));
    copied += 1;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (FETCH_ICONS) {
    await mkdir(ICON_DIR, { recursive: true });
    console.log(`\nFetching icons for ${entries.length} entries…`);
    let got = 0;
    for (const entry of entries) {
      const file = await fetchIcon(entry);
      if (file) {
        entry.icon = file;
        got += 1;
        console.log(`  ✓ ${entry.name} → ${file}`);
      } else {
        delete entry.icon;
        console.log(`  · ${entry.name} — no usable icon, falling back to a monogram`);
      }
    }
    console.log(`\n${got} of ${entries.length} icons fetched.`);
  } else {
    // Keep whatever the previous build resolved, so a no-network build does
    // not silently strip every icon out of the catalogue.
    const prior = await readFile(OUT, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
    if (prior) {
      const iconsById = new Map(prior.entries.filter((e) => e.icon).map((e) => [e.id, e.icon]));
      for (const entry of entries) {
        const existing = iconsById.get(entry.id);
        if (existing) entry.icon = existing;
      }
    }
  }

  // The version is a monotonic counter; CI bumps it on merge. Locally we derive
  // it from the entry count and content so a rebuild is deterministic.
  const previous = await readFile(OUT, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  const body = JSON.stringify(entries);
  const changed = !previous || JSON.stringify(previous.entries) !== body;
  const version = previous ? previous.version + (changed ? 1 : 0) : 1;

  const catalogue = {
    schema: SCHEMA,
    version,
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
