# Albion Price Checker

A terminal-based tool to compare item prices between cities in Albion Online using the public API.

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/adampolicht/albion-price-checker.git
   cd albion-price-checker
2. Install dependencies:
   ```bash
   npm install
3. Install tool globally:
   ```bash
   npm install -g .

## Usage
1. Run the tool from any terminal to compare item prices:
   ```bash
   albion-prices <item_id> <city1> <city2> [quality]
   ```
   example:
   ```bash
   albion-prices T4_BAG Thetford Caerleon 2

## Notes
1. Replace <item_id> with the desired item's ID
2. Replace <city1> and <city2> with the names of the cities you want to compare
3. [quality] is optional (from 1 low to 5 excellent) and default set to 1 if not provided
