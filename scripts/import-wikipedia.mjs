#!/usr/bin/env node
// Imports subscription services from Wikipedia as stub entries.
//
// A stub carries a name, a category, an official domain and nothing else. It
// gets the service into search so someone can add the subscription and see its
// icon, while being honest that nobody has worked out how to cancel it yet.
//
// WHAT THIS IS AND ISN'T GOOD FOR
//
// Wikipedia categorises for encyclopedic completeness, not for what people
// actually pay for. "Subscription video on demand services" is 162 entries
// dominated by regional anime portals and wrestling channels, and Netflix,
// Spotify and Disney+ are in none of these categories at all. So this gives
// breadth cheaply and misses the obvious — the majors are hand-maintained in
// data/seed.json instead.
//
// Domains come from Wikidata's "official website" property rather than being
// guessed from the name, which would be wrong often enough to matter.
//
// Category membership and company names are facts, and Wikidata is CC0.
//
// Writes to data/wikipedia-stubs.json. Run: node scripts/import-wikipedia.mjs

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const OUT = path.join(DATA_DIR, 'wikipedia-stubs.json');

const UA = { 'User-Agent': 'subshq-catalogue/0.1 (https://github.com/shibbard/subshq-catalogue)' };

// Category → the category value used in the catalogue. Everything else lands
// in 'other', which is honest: guessing a category from a title is how you end
// up filing a meal-kit under software.
const SOURCES = [
  { cat: 'Subscription services', category: 'other' },
  { cat: 'Subscription video streaming services', category: 'streaming' },
  { cat: 'Subscription video on demand services', category: 'streaming' },
  { cat: 'Subscription video game services', category: 'gaming' },
];

// Meta and B2B categories are deliberately not imported: "Infrastructure as a
// service" is not something anyone cancels from their phone.
const SKIP_TITLE = [
  /^Subscription /i,
  / as a service$/i,
  /^As a service$/i,
  /^Big deal /i,
  /^Data clean room$/i,
  /^Live service game$/i,
  /^Meals on Wheels$/i, // a charity, not a subscription
  /^Vehicle subscription$/i,
  /\(disambiguation\)/i,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

async function categoryMembers(cat) {
  const out = [];
  let cont;
  do {
    const q = new URLSearchParams({
      action: 'query',
      list: 'categorymembers',
      cmtitle: `Category:${cat}`,
      cmlimit: '500',
      cmtype: 'page',
      format: 'json',
    });
    if (cont) q.set('cmcontinue', cont);
    const j = await api(`https://en.wikipedia.org/w/api.php?${q}`);
    out.push(...j.query.categorymembers.map((m) => m.title));
    cont = j.continue?.cmcontinue;
    await sleep(150);
  } while (cont);
  return out;
}

/** Wikidata ids for a batch of article titles (50 at a time is the API limit). */
async function wikidataIds(titles) {
  const map = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const q = new URLSearchParams({
      action: 'query',
      prop: 'pageprops',
      ppprop: 'wikibase_item',
      titles: batch.join('|'),
      format: 'json',
    });
    const j = await api(`https://en.wikipedia.org/w/api.php?${q}`);
    for (const page of Object.values(j.query.pages)) {
      const id = page.pageprops?.wikibase_item;
      if (id) map.set(page.title, id);
    }
    await sleep(150);
  }
  return map;
}

/** P856 is "official website". */
async function officialWebsites(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const q = new URLSearchParams({
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'claims',
      format: 'json',
    });
    const j = await api(`https://www.wikidata.org/w/api.php?${q}`);
    for (const [id, entity] of Object.entries(j.entities ?? {})) {
      const url = entity.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
      if (url) map.set(id, url);
    }
    await sleep(200);
  }
  return map;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** "Audible (service)" → "Audible"; "Graze (company)" → "Graze". */
function cleanName(title) {
  return title.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function existingIdsAndDomains() {
  const ids = new Set();
  const domains = new Set();
  const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    if (f === path.basename(OUT)) continue;
    const parsed = JSON.parse(await readFile(path.join(DATA_DIR, f), 'utf8'));
    for (const e of Array.isArray(parsed) ? parsed : [parsed]) {
      if (e.id) ids.add(e.id);
      if (e.domain) domains.add(e.domain.toLowerCase());
    }
  }
  return { ids, domains };
}

async function main() {
  const { ids: takenIds, domains: takenDomains } = await existingIdsAndDomains();

  const byTitle = new Map();
  for (const src of SOURCES) {
    const titles = await categoryMembers(src.cat);
    console.log(`  ${src.cat}: ${titles.length}`);
    for (const t of titles) {
      // First category wins, so a more specific one can't be overwritten by
      // the generic parent.
      if (!byTitle.has(t)) byTitle.set(t, src.category);
    }
  }

  const candidates = [...byTitle.keys()].filter((t) => !SKIP_TITLE.some((re) => re.test(t)));
  const skippedMeta = byTitle.size - candidates.length;

  console.log(`\n${byTitle.size} unique titles, ${skippedMeta} skipped as meta or B2B`);

  const idMap = await wikidataIds(candidates);
  console.log(`${idMap.size} have a Wikidata entity`);

  const siteMap = await officialWebsites([...idMap.values()]);
  console.log(`${siteMap.size} have an official website recorded`);

  const entries = [];
  const noDomain = [];
  const duplicates = [];

  for (const title of candidates) {
    const wd = idMap.get(title);
    const domain = wd ? domainOf(siteMap.get(wd) ?? '') : null;

    // No verifiable domain means no icon and no way to tell two services with
    // similar names apart. Not worth importing.
    if (!domain) {
      noDomain.push(title);
      continue;
    }
    if (takenDomains.has(domain)) {
      duplicates.push(title);
      continue;
    }

    const name = cleanName(title);
    let id = slugify(name);
    if (takenIds.has(id)) {
      duplicates.push(title);
      continue;
    }
    takenIds.add(id);
    takenDomains.add(domain);

    entries.push({
      id,
      name,
      category: byTitle.get(title),
      domain,
      price: null,
      wikipedia: title,
      verified: null,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(OUT, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

  console.log(`\nWrote ${entries.length} stubs → data/${path.basename(OUT)}`);
  console.log(`  ${noDomain.length} skipped, no official website on Wikidata`);
  console.log(`  ${duplicates.length} skipped, already in the catalogue`);
  console.log('\nEvery one of these is a stub: a name, a category and a domain.');
  console.log('None has cancellation steps. Adding those is the actual work.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
