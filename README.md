# Albion Online Price Checker & Flip Finder

A command-line tool for **Albion Online** traders. Check live item prices across all 8 cities, find the best city-to-city arbitrage routes, and rank flip opportunities by silver profit — directly from your terminal.

Built for players who want to identify market inefficiencies fast: buy low in one city, sell high in another, with profit calculated after market tax. Supports all tiers (T4–T8), enchantment levels (.1–.4), and quality grades.

## Installation

Requires [Node.js](https://nodejs.org/) 16+.

```bash
git clone https://github.com/adampolicht/albion-price-checker.git
cd albion-price-checker
npm install
npm install -g .
```

After that, `albion-prices` is available globally in any terminal window.

## Commands

### `flips` — find the best flip opportunities

Scans popular T4–T8 items across all cities and ranks them by profit per flip.

```bash
albion-prices flips                          # top 20 flips, T4–T8 popular items
albion-prices flips --skip-blackmarket       # city-to-city only, no Black Market
albion-prices flips bag                      # flips for bags only
albion-prices flips bag 5                    # T5 bags only
albion-prices flips --skip-blackmarket --limit 5   # top 5, no Black Market
albion-prices flips --premium                # use premium tax rate
```

`--skip-blackmarket` is useful when you want realistic city-to-city trades and don't want Black Market dominating the results.

Results are sorted by **absolute profit** (silver per flip), not percentage, so low-value items don't crowd out real opportunities.

---

### `scan` — compare many items by pattern

```bash
albion-prices scan <pattern> [tier[.enchant]] [quality] [--limit N] [--premium] [--skip-blackmarket]
```

```bash
albion-prices scan bag 5                     # all T5 bags, sorted by margin
albion-prices scan sword 6.1                 # T6 swords, enchantment .1 only
albion-prices scan "plate armor" 7 2         # T7 plate armors, quality Good
albion-prices scan sword 6 2 --premium --limit 30
albion-prices scan cape 8 --skip-blackmarket # T8 capes, city-to-city only
```

---

### Single item — full price table

```bash
albion-prices <item> [tier.enchant | quality] [--enchant N] [--premium]
```

```bash
albion-prices "expert bag"                   # all enchant levels, quality Normal
albion-prices "carving sword" 6.1            # T6 enchantment .1, full city table
albion-prices T5_BAG 2                       # direct item ID, quality Good
albion-prices T5_BAG 2 --enchant 3           # full city table for .3 enchant
albion-prices "fiend robe" --premium         # use premium tax
```

---

### Other

```bash
albion-prices --update-cache                 # refresh item name database (auto-refreshes weekly)
```

## Quality levels

| Value | Name |
|---|---|
| 1 | Normal (default) |
| 2 | Good |
| 3 | Outstanding |
| 4 | Excellent |
| 5 | Masterpiece |

## Tier.enchant notation

Use `<tier>.<enchant>` to filter by both tier and enchantment at once — same notation as the game (e.g. `6.1` = Tier 6, enchantment .1).

## Tax

Profit is calculated after full market tax:
- **Non-premium** (default): ~14.5% break-even spread required
- **Premium** (`--premium`): ~9.6% break-even spread required

## Data freshness

Prices come from the [Albion Online Data Project](https://www.albion-online-data.com/) and are color-coded by age:
- ✓ Green — under 45 min (reliable)
- ~ Yellow — 45–180 min (check before trading)
- ✗ Red STALE — over 3 hours (likely outdated)

Data is most fresh during peak trading hours when other players have the client mod running.
