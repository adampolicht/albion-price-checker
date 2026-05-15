# Albion Price Checker

Terminal tool for comparing item prices across all 8 cities in Albion Online. Shows buy/sell prices, best arbitrage route, profit after tax, and data freshness — all in one table.

## Installation

```bash
git clone https://github.com/adampolicht/albion-price-checker.git
cd albion-price-checker
npm install
npm install -g .
```

## Usage

### Single item

```bash
albion-prices <item> [tier.enchant | quality] [--enchant N] [--premium]
```

```bash
albion-prices "expert bag"             # all enchant levels, quality Normal
albion-prices "carving sword" 6.1      # T6, enchantment .1, full city table
albion-prices T5_BAG 2                 # direct item ID, quality Good
albion-prices T5_BAG 2 --enchant 3    # full city table for .3 enchant
albion-prices "fiend robe" --premium   # premium tax (4% instead of 8%)
```

### Scan mode — compare many items at once

```bash
albion-prices scan <pattern> [tier[.enchant]] [quality] [--limit N] [--premium]
```

```bash
albion-prices scan bag 5               # all T5 bags, sorted by profit margin
albion-prices scan sword 6.1           # T6 swords, enchantment .1 only
albion-prices scan "plate armor" 7 2   # T7 plate armors, quality Good
albion-prices scan sword 6 2 --premium --limit 30
```

### Other

```bash
albion-prices --update-cache           # refresh item name database (weekly auto-refresh)
```

## Tier.enchant notation

Use `<tier>.<enchant>` as the second argument to filter by both tier and enchantment level at once — same notation as the game uses (e.g. `6.1` = Tier 6, enchantment .1).

## Quality levels

| Value | Name |
|---|---|
| 1 | Normal (default) |
| 2 | Good |
| 3 | Outstanding |
| 4 | Excellent |
| 5 | Masterpiece |

## Tax

Profit is calculated after full market tax:
- **Non-premium**: ~14.5% break-even spread required
- **Premium** (`--premium`): ~9.6% break-even spread required

## Data freshness

Prices from the [Albion Online Data Project](https://www.albion-online-data.com/) are color-coded by age:
- Green — under 45 min
- Yellow ⚠ — 45–180 min
- Red ⚠ STALE — over 3 hours (likely no longer valid)
