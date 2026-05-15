#!/usr/bin/env node
'use strict';

const axios = require('axios');
const Fuse  = require('fuse.js');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const CACHE_FILE   = path.join(__dirname, 'items-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ITEMS_URL    = 'https://raw.githubusercontent.com/broderickhyman/ao-bin-dumps/master/formatted/items.json';
const API_BASE     = 'https://west.albion-online-data.com/api/v2/stats/prices';

const CITIES = [
  'Caerleon', 'Bridgewatch', 'Lymhurst', 'Martlock',
  'Thetford', 'Fort Sterling', 'Brecilien', 'Black Market',
];

const QUALITY_NAMES = { 1: 'Normal', 2: 'Good', 3: 'Outstanding', 4: 'Excellent', 5: 'Masterpiece' };

// ─── Tax ─────────────────────────────────────────────────────────────────────
// Setup fee 2.5% on both buy and sell orders.
// Transaction tax: 8% non-premium, 4% premium.
// Net receive: sell * (1 - 0.025 - tax). Net cost: buy * 1.025.
// Non-premium break-even: ~14.5% spread. Premium: ~9.6%.
function calcProfit(buyPrice, sellPrice, premium) {
  if (!buyPrice || !sellPrice || buyPrice <= 0 || sellPrice <= 0) return null;
  const netSell = premium ? sellPrice * 0.935 : sellPrice * 0.895;
  return netSell - buyPrice * 1.025;
}

function calcProfitPct(buyPrice, p) {
  if (p === null || !buyPrice) return null;
  return (p / (buyPrice * 1.025)) * 100;
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
function findItem(items, query) {
  const direct = items.find(i => i.id.toUpperCase() === query.toUpperCase());
  if (direct) return [direct];

  const fuse = new Fuse(items, {
    keys: [{ name: 'name', weight: 0.7 }, { name: 'id', weight: 0.3 }],
    includeScore: true,
    threshold: 0.4,
  });

  const results = fuse.search(query);

  // Re-rank: items containing ALL query words score highest, then Fuse score
  const words = query.toLowerCase().split(/\s+/);
  const ranked = results
    .map(r => {
      const nameLower = r.item.name.toLowerCase();
      const wordHits  = words.filter(w => nameLower.includes(w)).length;
      return { item: r.item, fuseScore: r.score, wordHits };
    })
    .sort((a, b) => b.wordHits - a.wordHits || a.fuseScore - b.fuseScore);

  return ranked.slice(0, 5).map(r => r.item);
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

function fmtAge(dateStr, width = 8) {
  if (!dateStr || dateStr.startsWith('0001')) return chalk.dim('never'.padEnd(width));
  const h = Math.floor((Date.now() - new Date(dateStr)) / 3_600_000);
  let s;
  if (h < 1)  s = '< 1h';
  else if (h < 24) s = `${h}h ago`;
  else         s = `${Math.floor(h / 24)}d ago`;
  const padded = s.padEnd(width);
  if (h < 2)  return chalk.green(padded);
  if (h < 24) return chalk.yellow(padded);
  return chalk.red(padded);
}

// ─── Price table ──────────────────────────────────────────────────────────────
function printTable(item, quality, data, premium) {
  const cityMap = {};
  for (const entry of data) {
    if (entry.quality !== quality) continue;
    cityMap[entry.city] = {
      sell:        entry.sell_price_min      || 0,
      buy:         entry.buy_price_max       || 0,
      sellDate:    entry.sell_price_min_date,
      buyDate:     entry.buy_price_max_date,
    };
  }

  const citiesWithSell = CITIES.filter(c => cityMap[c]?.sell > 0);
  const citiesWithBuy  = CITIES.filter(c => cityMap[c]?.buy  > 0);

  const bestBuyCity  = citiesWithSell.length
    ? citiesWithSell.reduce((a, b) => cityMap[a].sell < cityMap[b].sell ? a : b)
    : null;
  const bestSellCity = citiesWithBuy.length
    ? citiesWithBuy.reduce((a, b) => cityMap[a].buy > cityMap[b].buy ? a : b)
    : null;

  const W   = 84;
  const bar = '═'.repeat(W);
  const sep = '─'.repeat(W);

  const qualLabel = QUALITY_NAMES[quality] || `Q${quality}`;
  console.log('\n' + chalk.cyan(bar));
  console.log(chalk.bold(`  ${item.name}  ·  ${item.id}  ·  ${qualLabel}`));
  console.log(chalk.cyan(bar));
  console.log(
    chalk.bold(
      '  ' + 'City'.padEnd(16) +
      'Sell (min)'.padStart(10) + '  ' + 'Updated'.padEnd(9) +
      'Buy (max)'.padStart(10) + '  ' + 'Updated'.padEnd(9) +
      'Arbitrage'
    )
  );
  console.log(chalk.dim('  ' + sep));

  for (const city of CITIES) {
    const d = cityMap[city] || {};
    const isBestBuy  = city === bestBuyCity;
    const isBestSell = city === bestSellCity;

    const sellRaw = fmtSilver(d.sell);
    const buyRaw  = fmtSilver(d.buy);

    const sellStr = d.sell > 0
      ? (isBestBuy  ? chalk.green(sellRaw) : sellRaw)
      : chalk.dim(sellRaw);
    const buyStr  = d.buy > 0
      ? (isBestSell ? chalk.green(buyRaw)  : buyRaw)
      : chalk.dim(buyRaw);

    const tags = [];
    if (isBestBuy)  tags.push(chalk.green('← buy here'));
    if (isBestSell) tags.push(chalk.green('← sell here'));

    console.log(
      '  ' + city.padEnd(16) +
      sellStr + '  ' + fmtAge(d.sellDate) + '  ' +
      buyStr  + '  ' + fmtAge(d.buyDate)  + '  ' +
      tags.join('  ')
    );
  }

  console.log(chalk.dim('  ' + sep));

  // ─── Arbitrage summary ───────────────────────────────────────────────────
  if (bestBuyCity && bestSellCity && bestBuyCity !== bestSellCity) {
    const buyPrice  = cityMap[bestBuyCity].sell;
    const sellPrice = cityMap[bestSellCity].buy;
    const p   = calcProfit(buyPrice, sellPrice, premium);
    const pct = calcProfitPct(buyPrice, p);

    const profitStr = p !== null
      ? (p >= 0 ? chalk.green(`+${Math.round(p).toLocaleString()} silver`) : chalk.red(`${Math.round(p).toLocaleString()} silver`))
      : chalk.dim('—');
    const pctStr = pct !== null
      ? (pct >= 0 ? chalk.green(`(+${pct.toFixed(1)}%)`) : chalk.red(`(${pct.toFixed(1)}%)`))
      : '';

    console.log(`\n  ${chalk.bold('Best arbitrage')}  ${chalk.dim(premium ? '[premium tax 4%]' : '[non-premium tax 8%]')}`);
    console.log(`  Buy  in ${chalk.cyan(bestBuyCity.padEnd(14))}  ${fmtSilver(buyPrice).trim()} silver`);
    console.log(`  Sell in ${chalk.cyan(bestSellCity.padEnd(14))}  ${fmtSilver(sellPrice).trim()} silver`);
    console.log(`  Profit: ${profitStr}  ${pctStr}`);

    if (p !== null && p < 0) {
      const breakEven = Math.ceil(buyPrice * 1.025 / (premium ? 0.935 : 0.895));
      console.log(chalk.dim(`  Break-even sell price: ${breakEven.toLocaleString()} silver`));
    }
  } else if (!bestBuyCity || !bestSellCity) {
    console.log(chalk.dim('\n  Insufficient price data for arbitrage calculation.'));
  } else {
    console.log(chalk.dim(`\n  Best buy and sell are both in ${bestBuyCity} — no cross-city arbitrage.`));
  }

  console.log('\n' + chalk.cyan(bar) + '\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv       = process.argv.slice(2);
  const flags      = new Set(argv.filter(a => a.startsWith('--')));
  const positional = argv.filter(a => !a.startsWith('--'));
  const [query, qualityArg] = positional;
  const quality = Math.min(5, Math.max(1, parseInt(qualityArg) || 1));
  const premium = flags.has('--premium');
  const update  = flags.has('--update-cache');

  if (!query && !update) {
    console.log(chalk.bold('\n  Albion Online Price Checker\n'));
    console.log(`  ${chalk.cyan('albion-prices')} <item name or ID> [quality] [--premium] [--update-cache]\n`);
    console.log('  Examples:');
    console.log('    albion-prices "royal bag" 2');
    console.log('    albion-prices T5_BAG 3 --premium');
    console.log('    albion-prices "adept\'s sword"');
    console.log('    albion-prices --update-cache\n');
    console.log('  Quality:  1=Normal  2=Good  3=Outstanding  4=Excellent  5=Masterpiece');
    console.log(chalk.dim('  Tax:      non-premium ~14.5% break-even  ·  --premium ~9.6% break-even\n'));
    process.exit(0);
  }

  let items;
  try {
    items = await loadItems(update);
  } catch (err) {
    console.error(chalk.red('Failed to load item database:'), err.message);
    process.exit(1);
  }

  if (update && !query) {
    console.log(chalk.green('Items cache updated.'));
    process.exit(0);
  }

  const matches = findItem(items, query);
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

  let data;
  try {
    data = await fetchPrices(item.id, quality);
  } catch (err) {
    console.error(chalk.red('\nAPI error:'), err.message);
    process.exit(1);
  }

  printTable(item, quality, data, premium);
}

async function fetchPrices(itemId, quality) {
  const url = `${API_BASE}/${itemId}.json?locations=${encodeURIComponent(CITIES.join(','))}&qualities=${quality}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data;
}

main().catch(err => {
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
});
