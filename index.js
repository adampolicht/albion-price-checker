#!/usr/bin/env node
'use strict';

const axios = require('axios');
const Fuse  = require('fuse.js');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const CACHE_FILE      = path.join(__dirname, 'items-cache.json');
const CACHE_TTL_MS    = 7 * 24 * 60 * 60 * 1000;
const ITEMS_URL       = 'https://raw.githubusercontent.com/broderickhyman/ao-bin-dumps/master/formatted/items.json';
const API_BASE        = 'https://west.albion-online-data.com/api/v2/stats/prices';

const CITIES = [
  'Caerleon', 'Bridgewatch', 'Lymhurst', 'Martlock',
  'Thetford', 'Fort Sterling', 'Brecilien', 'Black Market',
];

const QUALITY_NAMES = { 1: 'Normal', 2: 'Good', 3: 'Outstanding', 4: 'Excellent', 5: 'Masterpiece' };
const ENCHANT_LEVELS  = [0, 1, 2, 3, 4];
const BATCH_SIZE      = 80;   // items per API request

// Keywords used for broad "flips" scan when no pattern is given (T4–T8 popular tradeable items)
const FLIP_KEYWORDS = [
  'bag', 'cape', 'tome', 'shield',
  'sword', 'axe', 'bow', 'crossbow', 'staff', 'spear',
  'mace', 'hammer', 'dagger', 'quarterstaff', 'warbow',
  'plate armor', 'leather armor', 'cloth armor',
  'plate shoes', 'leather shoes', 'cloth shoes',
  'plate helmet', 'leather helmet', 'cloth helmet',
  'plate gloves', 'leather gloves', 'cloth gloves',
];

// Staleness thresholds (minutes)
const STALE_WARN_MIN  = 45;   // yellow warning
const STALE_OLD_MIN   = 180;  // red — likely gone

// ─── Tax ─────────────────────────────────────────────────────────────────────
// Setup 2.5% both sides + transaction tax 8% (non-premium) / 4% (premium)
// Net receive: sell × 0.895 | 0.935. Net cost: buy × 1.025.
function calcProfit(buyPrice, sellPrice, premium) {
  if (!buyPrice || !sellPrice || buyPrice <= 0 || sellPrice <= 0) return null;
  return (premium ? sellPrice * 0.935 : sellPrice * 0.895) - buyPrice * 1.025;
}

function calcProfitPct(buyPrice, p) {
  if (p === null || !buyPrice) return null;
  return (p / (buyPrice * 1.025)) * 100;
}

// ─── Enchantment helpers ──────────────────────────────────────────────────────
function enchantId(baseId, level) {
  return level === 0 ? baseId : `${baseId}@${level}`;
}

// Parse Albion tier.enchant notation: "6.1" → { tier: 6, enchant: 1 }
// Plain tier "6" → { tier: 6, enchant: null }. Returns null if invalid.
function parseTierEnchant(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const tier    = parseInt(m[1]);
  const enchant = m[2] !== undefined ? parseInt(m[2]) : null;
  if (tier < 1 || tier > 8) return null;
  if (enchant !== null && (enchant < 0 || enchant > 4)) return null;
  return { tier, enchant };
}

// ─── Items cache ──────────────────────────────────────────────────────────────
async function loadItems(forceUpdate) {
  const cacheExists = fs.existsSync(CACHE_FILE);
  const cacheAge    = cacheExists ? Date.now() - fs.statSync(CACHE_FILE).mtimeMs : Infinity;

  if (!forceUpdate && cacheExists && cacheAge < CACHE_TTL_MS) {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }

  process.stdout.write(chalk.dim('Fetching item database... '));
  const res   = await axios.get(ITEMS_URL, { timeout: 20000 });
  const items = res.data
    .filter(i => i.UniqueName && i.LocalizedNames?.['EN-US'])
    .map(i => ({ id: i.UniqueName, name: i.LocalizedNames['EN-US'] }));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(items));
  console.log(chalk.dim(`${items.length} items cached.\n`));
  return items;
}

// ─── Fuzzy search ─────────────────────────────────────────────────────────────
function findItem(items, query, tierFilter = null) {
  // Direct ID match always checked against full list
  const direct = items.find(i => i.id.toUpperCase() === query.toUpperCase());
  if (direct) return [direct];

  // Narrow pool to tier if provided (e.g. tier 6 → only T6_* base items)
  const pool = tierFilter
    ? items.filter(i => i.id.toUpperCase().startsWith(`T${tierFilter}_`) && !i.id.includes('@'))
    : items;

  const fuse = new Fuse(pool, {
    keys: [{ name: 'name', weight: 0.7 }, { name: 'id', weight: 0.3 }],
    includeScore: true,
    threshold: 0.4,
  });
  const words = query.toLowerCase().split(/\s+/);
  return fuse.search(query)
    .map(r => {
      const nameLower = r.item.name.toLowerCase();
      const hits = words.filter(w => nameLower.includes(w)).length;
      return { item: r.item, score: r.score, hits };
    })
    .sort((a, b) => b.hits - a.hits || a.score - b.score)
    .slice(0, 5)
    .map(r => r.item);
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function fetchPrices(itemIds, quality) {
  const all = [];
  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batch = itemIds.slice(i, i + BATCH_SIZE);
    const url   = `${API_BASE}/${batch.join(',')}.json?locations=${encodeURIComponent(CITIES.join(','))}&qualities=${quality}`;
    const res   = await axios.get(url, { timeout: 15000 });
    all.push(...res.data);
  }
  return all;
}

function buildCityMap(data, itemId, quality) {
  const map = {};
  for (const e of data) {
    if (e.item_id?.toUpperCase() !== itemId.toUpperCase()) continue;
    if (e.quality !== quality) continue;
    map[e.city] = {
      sell:     e.sell_price_min       || 0,
      buy:      e.buy_price_max        || 0,
      sellDate: e.sell_price_min_date,
      buyDate:  e.buy_price_max_date,
    };
  }
  return map;
}

function bestArbitrage(cityMap, premium, skipCities = []) {
  const active   = skipCities.length ? CITIES.filter(c => !skipCities.includes(c)) : CITIES;
  const withSell = active.filter(c => cityMap[c]?.sell > 0);
  const withBuy  = active.filter(c => cityMap[c]?.buy  > 0);

  let best = null;
  for (const buyCity of withSell) {
    for (const sellCity of withBuy) {
      if (buyCity === sellCity) continue;
      const buyPrice  = cityMap[buyCity].sell;
      const sellPrice = cityMap[sellCity].buy;
      const p   = calcProfit(buyPrice, sellPrice, premium);
      const pct = calcProfitPct(buyPrice, p);
      if (best === null || (p !== null && p > (best.profit ?? -Infinity))) {
        best = {
          buyCity, sellCity, buyPrice, sellPrice, profit: p, profitPct: pct,
          buyAge:  cityMap[buyCity].sellDate,
          sellAge: cityMap[sellCity].buyDate,
        };
      }
    }
  }
  return best;
}

// ─── Formatting ───────────────────────────────────────────────────────────────
function fmtSilver(n, width = 9) {
  if (!n || n <= 0) return '—'.padStart(width);
  let s;
  if (n >= 1_000_000) s = (n / 1_000_000).toFixed(2) + 'M';
  else if (n >= 1_000) s = (n / 1_000).toFixed(1) + 'k';
  else                 s = String(n);
  return s.padStart(width);
}

function ageMinutes(dateStr) {
  if (!dateStr || dateStr.startsWith('0001')) return Infinity;
  return (Date.now() - new Date(dateStr)) / 60000;
}

function fmtAge(dateStr) {
  const mins = ageMinutes(dateStr);
  if (mins === Infinity) return chalk.dim('never   ');
  let s;
  if (mins < 60) s = `${Math.round(mins)}min`;
  else if (mins < 24 * 60) s = `${Math.floor(mins / 60)}h ago`;
  else s = `${Math.floor(mins / 1440)}d ago`;
  s = s.padEnd(8);
  if (mins < STALE_WARN_MIN) return chalk.green(s);
  if (mins < STALE_OLD_MIN)  return chalk.yellow(s);
  return chalk.red(s);
}

function staleFlag(dateStr) {
  const mins = ageMinutes(dateStr);
  if (mins > STALE_OLD_MIN) return chalk.red(' ⚠ STALE');
  if (mins > STALE_WARN_MIN) return chalk.yellow(' ⚠');
  return '';
}

// ─── Single-item view ─────────────────────────────────────────────────────────
function printTable(item, quality, data, premium, enchantFilter) {
  const W   = 86;
  const bar = '═'.repeat(W);
  const sep = '─'.repeat(W);
  const qualLabel = QUALITY_NAMES[quality] || `Q${quality}`;

  const levels = enchantFilter !== null ? [enchantFilter] : ENCHANT_LEVELS;

  console.log('\n' + chalk.cyan(bar));
  console.log(chalk.bold(`  ${item.name}  ·  ${item.id}  ·  ${qualLabel}`));
  console.log(chalk.cyan(bar));

  // Compact enchant summary table (when showing multiple enchants)
  if (levels.length > 1) {
    console.log(chalk.bold('  ' + 'Enchant'.padEnd(10) + 'Best Buy'.padEnd(16) + 'Buy Price'.padStart(10) +
      '  ' + 'Best Sell'.padEnd(16) + 'Sell Price'.padStart(11) + '  Profit'));
    console.log(chalk.dim('  ' + sep));

    let anyData = false;
    for (const lvl of levels) {
      const id      = enchantId(item.id, lvl);
      const cityMap = buildCityMap(data, id, quality);
      const arb     = bestArbitrage(cityMap, premium);
      const label   = lvl === 0 ? '  base  ' : `  .${lvl}     `;

      if (!arb || arb.profit === null) {
        console.log(`  ${chalk.dim(label)}` + chalk.dim('  no data'));
        continue;
      }
      anyData = true;

      const profitStr = arb.profit >= 0
        ? chalk.green(`+${fmtSilver(Math.round(arb.profit)).trim()} (${arb.profitPct?.toFixed(0)}%)`)
        : chalk.red(`${fmtSilver(Math.round(arb.profit)).trim()} (${arb.profitPct?.toFixed(0)}%)`);

      const buyStale  = staleFlag(arb.buyAge);
      const sellStale = staleFlag(arb.sellAge);

      console.log(
        `  ${chalk.cyan(label)}` +
        arb.buyCity.padEnd(16) + fmtSilver(arb.buyPrice).padStart(10) + buyStale.padEnd(4) +
        '  ' + arb.sellCity.padEnd(16) + fmtSilver(arb.sellPrice).padStart(10) + sellStale.padEnd(4) +
        '  ' + profitStr
      );
    }

    if (!anyData) {
      console.log(chalk.dim('  No price data found across any enchantment level.'));
    }
    console.log(chalk.dim('  ' + sep));
    console.log(chalk.dim(`  Tax: ${premium ? 'premium 4%' : 'non-premium 8%'}  ·  Use --enchant N for full city breakdown  ·  ` +
      `${chalk.yellow('⚠')} = data ${STALE_WARN_MIN}+ min old  ·  ${chalk.red('⚠ STALE')} = ${STALE_OLD_MIN}+ min`));
  }

  // Full city table (when a single enchant is selected)
  if (levels.length === 1) {
    const lvl     = levels[0];
    const id      = enchantId(item.id, lvl);
    const cityMap = buildCityMap(data, id, quality);

    const withSell = CITIES.filter(c => cityMap[c]?.sell > 0);
    const withBuy  = CITIES.filter(c => cityMap[c]?.buy  > 0);
    const bestBuyCity  = withSell.length ? withSell.reduce((a, b) => cityMap[a].sell < cityMap[b].sell ? a : b) : null;
    const bestSellCity = withBuy.length  ? withBuy.reduce((a, b) => cityMap[a].buy > cityMap[b].buy ? a : b)   : null;

    const enchLabel = lvl === 0 ? '' : ` .${lvl}`;
    console.log(chalk.bold(`  Enchantment${enchLabel}`));
    console.log(chalk.dim('  ' + sep));
    console.log(chalk.bold('  ' + 'City'.padEnd(16) + 'Sell (min)'.padStart(10) + '  ' + 'Updated'.padEnd(10) +
      'Buy (max)'.padStart(10) + '  ' + 'Updated'.padEnd(10) + 'Note'));
    console.log(chalk.dim('  ' + sep));

    for (const city of CITIES) {
      const d = cityMap[city] || {};
      const isBestBuy  = city === bestBuyCity;
      const isBestSell = city === bestSellCity;

      const sellRaw = fmtSilver(d.sell);
      const buyRaw  = fmtSilver(d.buy);

      const sellStr = d.sell > 0 ? (isBestBuy  ? chalk.green(sellRaw)  : sellRaw) : chalk.dim(sellRaw);
      const buyStr  = d.buy  > 0 ? (isBestSell ? chalk.green(buyRaw)   : buyRaw)  : chalk.dim(buyRaw);

      const tags = [];
      if (isBestBuy)  tags.push(chalk.green('← buy here'));
      if (isBestSell) tags.push(chalk.green('← sell here'));

      console.log('  ' + city.padEnd(16) +
        sellStr + '  ' + fmtAge(d.sellDate) + '  ' +
        buyStr  + '  ' + fmtAge(d.buyDate)  + '  ' +
        tags.join('  '));
    }

    console.log(chalk.dim('  ' + sep));

    const arb = bestArbitrage(cityMap, premium);
    if (arb && arb.buyCity !== arb.sellCity) {
      const profitStr = arb.profit !== null
        ? (arb.profit >= 0 ? chalk.green(`+${Math.round(arb.profit).toLocaleString()} (${arb.profitPct?.toFixed(1)}%)`)
                           : chalk.red(`${Math.round(arb.profit).toLocaleString()} (${arb.profitPct?.toFixed(1)}%)`))
        : chalk.dim('—');

      console.log(`\n  ${chalk.bold('Best arbitrage')}  ${chalk.dim(premium ? '[premium 4%]' : '[non-premium 8%]')}`);
      console.log(`  Buy  ${chalk.cyan(arb.buyCity.padEnd(14))}  ${fmtSilver(arb.buyPrice).trim()}${staleFlag(arb.buyAge)}`);
      console.log(`  Sell ${chalk.cyan(arb.sellCity.padEnd(14))}  ${fmtSilver(arb.sellPrice).trim()}${staleFlag(arb.sellAge)}`);
      console.log(`  Profit: ${profitStr}`);

      if (arb.profit !== null && arb.profit < 0) {
        const be = Math.ceil(arb.buyPrice * 1.025 / (premium ? 0.935 : 0.895));
        console.log(chalk.dim(`  Break-even sell price: ${be.toLocaleString()}`));
      }
    } else {
      console.log(chalk.dim('\n  No arbitrage opportunity found.'));
    }
  }

  console.log('\n' + chalk.cyan(bar) + '\n');
}

// ─── Scan mode ────────────────────────────────────────────────────────────────
async function runScan(items, pattern, tierArg, quality, limit, premium, enchantOnly = null, skipCities = []) {
  const W   = 92;
  const bar = '═'.repeat(W);
  const sep = '─'.repeat(W);

  // Filter items by name/id pattern and optional tier
  const tierPrefix = tierArg ? `T${tierArg}_` : null;
  const patWords   = pattern.toLowerCase().split(/\s+/);

  const matched = items.filter(item => {
    if (item.id.includes('@')) return false;  // skip enchanted variants — we generate them ourselves
    if (tierPrefix && !item.id.toUpperCase().startsWith(tierPrefix)) return false;
    const nameLower = item.name.toLowerCase();
    const idLower   = item.id.toLowerCase();
    return patWords.every(w => nameLower.includes(w) || idLower.includes(w));
  });

  if (!matched.length) {
    console.log(chalk.red(`\nNo items found matching "${pattern}"${tierArg ? ` tier ${tierArg}` : ''}.\n`));
    return;
  }

  // Build full list of IDs (base + enchants, or specific enchant only)
  const levelsToFetch = enchantOnly !== null ? [enchantOnly] : ENCHANT_LEVELS;
  const allIds = matched.flatMap(item =>
    levelsToFetch.map(lvl => enchantId(item.id, lvl))
  );

  const enchantLabel = enchantOnly !== null ? ` .${enchantOnly}` : '';
  const tierLabel = tierArg ? ` · Tier ${tierArg}${enchantLabel}` : '';
  const qualLabel = QUALITY_NAMES[quality] || `Q${quality}`;
  console.log('\n' + chalk.cyan(bar));
  console.log(chalk.bold(`  SCAN  ·  "${pattern}"${tierLabel}  ·  ${qualLabel}  ·  ${matched.length} item type(s)`));
  console.log(chalk.dim(`  Fetching prices for ${allIds.length} item variants...`));
  console.log(chalk.cyan(bar));

  let data;
  try {
    data = await fetchPrices(allIds, quality);
  } catch (err) {
    console.error(chalk.red('API error:'), err.message);
    return;
  }

  // Calculate best arbitrage per item+enchant
  const rows = [];
  for (const item of matched) {
    for (const lvl of levelsToFetch) {
      const id      = enchantId(item.id, lvl);
      const cityMap = buildCityMap(data, id, quality);
      const arb     = bestArbitrage(cityMap, premium, skipCities);
      if (!arb || arb.profit === null) continue;
      rows.push({ item, lvl, arb });
    }
  }

  if (!rows.length) {
    console.log(chalk.dim('  No price data found.\n'));
    return;
  }

  // Sort by profit margin descending
  rows.sort((a, b) => (b.arb.profitPct ?? -Infinity) - (a.arb.profitPct ?? -Infinity));
  const display = rows.slice(0, limit);

  console.log(chalk.bold(
    '  ' + 'Item'.padEnd(26) + 'Ench'.padEnd(6) +
    'Buy City'.padEnd(14) + 'Buy Price'.padStart(10) +
    '  ' + 'Sell City'.padEnd(14) + 'Sell Price'.padStart(11) +
    '  Profit   Margin   Freshness'
  ));
  console.log(chalk.dim('  ' + sep));

  for (const { item, lvl, arb } of display) {
    const enchLabel   = lvl === 0 ? 'base' : `.${lvl}  `;
    const profitStr   = arb.profit >= 0
      ? chalk.green(`+${fmtSilver(Math.round(arb.profit)).trim()}`)
      : chalk.red(fmtSilver(Math.round(arb.profit)).trim());
    const marginStr   = arb.profitPct !== null
      ? (arb.profit >= 0 ? chalk.green(`${arb.profitPct.toFixed(0)}%`.padStart(6))
                         : chalk.red(`${arb.profitPct.toFixed(0)}%`.padStart(6)))
      : '     —';

    const buyMins  = ageMinutes(arb.buyAge);
    const sellMins = ageMinutes(arb.sellAge);
    const maxMins  = Math.max(buyMins === Infinity ? 0 : buyMins, sellMins === Infinity ? 0 : sellMins);
    let fresh;
    if (maxMins < STALE_WARN_MIN) fresh = chalk.green('fresh');
    else if (maxMins < STALE_OLD_MIN) fresh = chalk.yellow('aging');
    else fresh = chalk.red('stale');

    console.log(
      '  ' + item.name.slice(0, 24).padEnd(26) +
      enchLabel.padEnd(6) +
      arb.buyCity.padEnd(14) +
      fmtSilver(arb.buyPrice).padStart(10) +
      '  ' + arb.sellCity.padEnd(14) +
      fmtSilver(arb.sellPrice).padStart(11) +
      '  ' + profitStr.padEnd(10) +
      marginStr + '   ' + fresh
    );
  }

  console.log(chalk.dim('  ' + sep));
  if (rows.length > limit) {
    console.log(chalk.dim(`  Showing top ${limit} of ${rows.length} results. Use --limit N to see more.`));
  }
  console.log(chalk.dim(`  Tax: ${premium ? 'premium 4%' : 'non-premium 8%'}`));
  console.log('\n' + chalk.cyan(bar) + '\n');
}

// ─── Flips mode ───────────────────────────────────────────────────────────────
async function runFlips(items, pattern, tierArg, quality, limit, premium, skipCities, enchantOnly = null) {
  const W   = 96;
  const bar = '═'.repeat(W);
  const sep = '─'.repeat(W);

  // Filter items: either by user pattern or by popular-tradeable keywords in T4–T8
  const tierPrefix = tierArg ? `T${tierArg}_` : null;

  let matched;
  if (pattern) {
    const patWords = pattern.toLowerCase().split(/\s+/);
    matched = items.filter(item => {
      if (item.id.includes('@')) return false;
      if (tierPrefix && !item.id.toUpperCase().startsWith(tierPrefix)) return false;
      const nameLower = item.name.toLowerCase();
      const idLower   = item.id.toLowerCase();
      return patWords.every(w => nameLower.includes(w) || idLower.includes(w));
    });
  } else {
    matched = items.filter(item => {
      if (item.id.includes('@')) return false;
      if (tierPrefix) {
        if (!item.id.toUpperCase().startsWith(tierPrefix)) return false;
      } else {
        const m = item.id.match(/^T(\d+)_/);
        if (!m) return false;
        const t = parseInt(m[1]);
        if (t < 4 || t > 8) return false;
      }
      const nameLower = item.name.toLowerCase();
      return FLIP_KEYWORDS.some(kw => nameLower.includes(kw));
    });
  }

  if (!matched.length) {
    console.log(chalk.red('\nNo items matched the criteria.\n'));
    return;
  }

  const levelsToFetch = enchantOnly !== null ? [enchantOnly] : ENCHANT_LEVELS;
  const allIds = matched.flatMap(item => levelsToFetch.map(lvl => enchantId(item.id, lvl)));

  const skipLabel  = skipCities.length ? chalk.yellow(`  ·  skip: ${skipCities.join(', ')}`) : '';
  const tierLabel  = tierArg ? ` · T${tierArg}` : ' · T4–T8';
  const patLabel   = pattern ? ` · "${pattern}"` : ' · popular items';
  const qualLabel  = QUALITY_NAMES[quality] || `Q${quality}`;

  console.log('\n' + chalk.cyan(bar));
  console.log(chalk.bold(`  BEST FLIPS${patLabel}${tierLabel}  ·  ${qualLabel}`) + skipLabel);
  console.log(chalk.dim(`  Scanning ${matched.length} item types (${allIds.length} variants)...`));
  console.log(chalk.cyan(bar));

  let data;
  try {
    data = await fetchPrices(allIds, quality);
  } catch (err) {
    console.error(chalk.red('API error:'), err.message);
    return;
  }

  // Collect all profitable flips
  const rows = [];
  for (const item of matched) {
    for (const lvl of levelsToFetch) {
      const id      = enchantId(item.id, lvl);
      const cityMap = buildCityMap(data, id, quality);
      const arb     = bestArbitrage(cityMap, premium, skipCities);
      if (!arb || arb.profit === null || arb.profit <= 0) continue;
      rows.push({ item, lvl, arb });
    }
  }

  if (!rows.length) {
    console.log(chalk.dim('  No profitable flips found right now.\n'));
    return;
  }

  // Sort by absolute profit (silver earned per flip), not %, to surface real opportunities
  rows.sort((a, b) => (b.arb.profit ?? -Infinity) - (a.arb.profit ?? -Infinity));
  const display = rows.slice(0, limit);

  console.log(chalk.bold(
    '  ' + '#'.padEnd(4) +
    'Item'.padEnd(26) + 'Ench'.padEnd(6) +
    'Buy in'.padEnd(14) + 'Buy Price'.padStart(10) +
    '  ' + 'Sell in'.padEnd(14) + 'Sell Price'.padStart(11) +
    '  Profit      Margin  Data'
  ));
  console.log(chalk.dim('  ' + sep));

  for (let i = 0; i < display.length; i++) {
    const { item, lvl, arb } = display[i];
    const enchLabel = lvl === 0 ? 'base' : `.${lvl}  `;

    const profitStr = chalk.green(`+${fmtSilver(Math.round(arb.profit)).trim()}`);
    const marginStr = arb.profitPct !== null
      ? chalk.green(`${arb.profitPct.toFixed(0)}%`.padStart(5))
      : '    —';

    const buyMins  = ageMinutes(arb.buyAge);
    const sellMins = ageMinutes(arb.sellAge);
    const maxMins  = Math.max(buyMins === Infinity ? 0 : buyMins, sellMins === Infinity ? 0 : sellMins);
    const fresh = maxMins < STALE_WARN_MIN ? chalk.green('✓ fresh')
                : maxMins < STALE_OLD_MIN  ? chalk.yellow('~ aging')
                : chalk.red('✗ stale');

    const medal = i === 0 ? chalk.yellow('🥇') : i === 1 ? chalk.white('🥈') : i === 2 ? chalk.yellow('🥉') : '  ';
    const rankStr = `${medal} ${String(i + 1) + '.'}`.padEnd(6);

    console.log(
      '  ' + rankStr +
      item.name.slice(0, 24).padEnd(26) +
      enchLabel.padEnd(6) +
      arb.buyCity.padEnd(14) +
      fmtSilver(arb.buyPrice).padStart(10) +
      '  ' + arb.sellCity.padEnd(14) +
      fmtSilver(arb.sellPrice).padStart(11) +
      '  ' + profitStr.padEnd(14) +
      marginStr + '  ' + fresh
    );
  }

  console.log(chalk.dim('  ' + sep));
  if (rows.length > limit) {
    console.log(chalk.dim(`  Showing top ${limit} of ${rows.length} profitable flips.  Use --limit N to see more.`));
  }
  console.log(chalk.dim(
    `  Sorted by profit  ·  Tax: ${premium ? 'premium 4%' : 'non-premium 8%'}  ·  ` +
    `✓ fresh <${STALE_WARN_MIN}min  ~ aging <${STALE_OLD_MIN}min  ✗ stale`
  ));
  if (skipCities.length) {
    console.log(chalk.dim(`  ${chalk.yellow('⚠')}  Excluded from results: ${skipCities.join(', ')}`));
  }
  console.log('\n' + chalk.cyan(bar) + '\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
  const argv       = process.argv.slice(2);
  const flags      = new Set(argv.filter(a => a.startsWith('--')));
  // Exclude values consumed by value-taking flags (e.g. the "3" in --limit 3)
  const VALUE_FLAGS = new Set(['--enchant', '--limit']);
  const positional = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && VALUE_FLAGS.has(argv[i - 1])) return false;
    return true;
  });

  const isScan     = positional[0] === 'scan';
  const isFlips    = positional[0] === 'flips';
  const isUpdate   = flags.has('--update-cache');
  const premium    = flags.has('--premium');
  const skipCities = flags.has('--skip-blackmarket') ? ['Black Market'] : [];

  // --enchant N flag
  let enchantFilter = null;
  const enchantIdx = argv.findIndex(a => a === '--enchant');
  if (enchantIdx !== -1) enchantFilter = parseInt(argv[enchantIdx + 1]) ?? null;

  // --limit N flag
  let limit = 20;
  const limitIdx = argv.findIndex(a => a === '--limit');
  if (limitIdx !== -1) limit = parseInt(argv[limitIdx + 1]) || 20;

  if (!positional.length && !isUpdate) {
    console.log(chalk.bold('\n  Albion Online Price Checker\n'));
    console.log(`  ${chalk.cyan('albion-prices')} <item name or ID> [quality] [--enchant N] [--premium]\n`);
    console.log(`  ${chalk.cyan('albion-prices scan')} <pattern> [tier] [quality] [--limit N] [--premium] [--skip-blackmarket]\n`);
    console.log(`  ${chalk.cyan('albion-prices flips')} [pattern] [tier] [quality] [--limit N] [--premium] [--skip-blackmarket]\n`);
    console.log('  Examples:');
    console.log('    albion-prices "expert bag" 1                    ' + chalk.dim('# all enchants'));
    console.log('    albion-prices "carving sword" 6.1               ' + chalk.dim('# T6 .1 enchant, full city table'));
    console.log('    albion-prices T5_BAG 2 --enchant 3              ' + chalk.dim('# full city table for .3'));
    console.log('    albion-prices scan bag 5                        ' + chalk.dim('# scan T5 bags, sorted by margin'));
    console.log('    albion-prices scan sword 6.1                    ' + chalk.dim('# T6 swords, .1 enchant only'));
    console.log('    albion-prices flips                             ' + chalk.dim('# best flips across popular T4–T8 items'));
    console.log('    albion-prices flips bag 5                       ' + chalk.dim('# best bag flips, T5'));
    console.log('    albion-prices flips --skip-blackmarket             ' + chalk.dim('# exclude Caerleon from results'));
    console.log('    albion-prices flips --skip-blackmarket --limit 5   ' + chalk.dim('# top 5, no Caerleon'));
    console.log('    albion-prices --update-cache\n');
    console.log('  Quality:  1=Normal  2=Good  3=Outstanding  4=Excellent  5=Masterpiece');
    console.log(chalk.dim('  Tax:      non-premium ~14.5% break-even  ·  --premium ~9.6% break-even\n'));
    process.exit(0);
  }

  let items;
  try {
    items = await loadItems(isUpdate);
  } catch (err) {
    console.error(chalk.red('Failed to load item database:'), err.message);
    process.exit(1);
  }

  if (isUpdate && positional.length <= 1 && !isScan) {
    console.log(chalk.green('Items cache updated.'));
    process.exit(0);
  }

  // ── Flips mode ─────────────────────────────────────────────────────────────
  if (isFlips) {
    // flips [pattern] [tier[.enchant]] [quality]
    // pattern is optional — if first arg looks like a tier ("5", "6.1") treat it as tier
    const args = positional.slice(1);  // drop "flips"
    let pattern = null, tierArg = null, qualityArg = null, flipsEnchant = null;

    for (const a of args) {
      const parsed = parseTierEnchant(a);
      if (parsed && !pattern) {
        // looks like a tier spec
        tierArg      = parsed.tier;
        flipsEnchant = parsed.enchant;
      } else if (/^\d$/.test(a) && parseInt(a) >= 1 && parseInt(a) <= 5 && tierArg !== null) {
        qualityArg = parseInt(a);
      } else if (!pattern) {
        pattern = a;
      }
    }
    const quality = qualityArg ? Math.min(5, Math.max(1, qualityArg)) : 1;
    await runFlips(items, pattern, tierArg ? String(tierArg) : null, quality, limit, premium, skipCities, flipsEnchant);
    process.exit(0);
  }

  // ── Scan mode ──────────────────────────────────────────────────────────────
  if (isScan) {
    const [, pattern, tierArg, qualityArg] = positional;
    if (!pattern) {
      console.error(chalk.red('\nUsage: albion-prices scan <pattern> [tier[.enchant]] [quality]\n'));
      process.exit(1);
    }
    // tierArg supports plain "6" or tier.enchant "6.1"
    const parsed      = parseTierEnchant(tierArg);
    const tier        = parsed?.tier   ?? null;
    const scanEnchant = parsed?.enchant ?? null;
    const quality     = qualityArg ? Math.min(5, Math.max(1, parseInt(qualityArg))) : 1;
    await runScan(items, pattern, tier, quality, limit, premium, scanEnchant, skipCities);
    process.exit(0);
  }

  // ── Single item mode ───────────────────────────────────────────────────────
  const [query, secondArg, thirdArg] = positional;

  // secondArg can be:
  //   - quality only:      "2"   → quality=2
  //   - tier.enchant:      "6.1" → tier filter + enchant filter, quality from thirdArg
  const tierEnchant = parseTierEnchant(secondArg);
  let quality, tierFilter, enchantFromArg;
  if (tierEnchant && tierEnchant.tier >= 2 && secondArg?.includes('.')) {
    // "6.1" style notation
    tierFilter    = tierEnchant.tier;
    enchantFromArg = tierEnchant.enchant;
    quality       = Math.min(5, Math.max(1, parseInt(thirdArg) || 1));
  } else {
    tierFilter    = null;
    enchantFromArg = null;
    quality       = Math.min(5, Math.max(1, parseInt(secondArg) || 1));
  }
  // --enchant flag takes precedence over tier.enchant notation
  const finalEnchantFilter = enchantFilter !== null ? enchantFilter : enchantFromArg;

  const matches = findItem(items, query, tierFilter);
  if (!matches.length) {
    console.error(chalk.red(`\nNo item found matching: "${query}"\n`));
    process.exit(1);
  }

  const item = matches[0];
  if (matches.length > 1) {
    console.log(chalk.yellow(`\nMultiple matches for "${query}":`));
    matches.forEach((m, i) => console.log(chalk.dim(`  ${i + 1}. ${m.name}  (${m.id})`)));
    console.log(chalk.dim(`\n  Using: ${item.name}  (${item.id})`));
  }

  // Build IDs to fetch (all enchants or specific one)
  const levels  = finalEnchantFilter !== null ? [finalEnchantFilter] : ENCHANT_LEVELS;
  const idsToFetch = levels.map(lvl => enchantId(item.id, lvl));

  let data;
  try {
    data = await fetchPrices(idsToFetch, quality);
  } catch (err) {
    console.error(chalk.red('\nAPI error:'), err.message);
    process.exit(1);
  }

  printTable(item, quality, data, premium, finalEnchantFilter);
}

main().catch(err => {
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
});
