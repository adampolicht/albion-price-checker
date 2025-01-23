#!/usr/bin/env node
const axios = require('axios');

// function for downloading and comparing prices of item and quality in selected cities
async function compareItemPrices(itemId, city1, city2, quality = 1) {
  const url = `https://www.albion-online-data.com/api/v2/stats/prices/${itemId}.json`;

  try {
    const response = await axios.get(url);
    const data = response.data;

    // filter by item quality
    const filteredData = data.filter(item => item.quality === quality);

    // filter for 2 cities
    const priceCity1 = filteredData.find(item => item.city === city1);
    const priceCity2 = filteredData.find(item => item.city === city2);

    if (!priceCity1 || !priceCity2) {
      console.log("No prices were found for one of the cities or an item of the specified quality.");
      return;
    }

    // comparison
    console.log(`Price for ${itemId} (Quality ${quality}):`);
    console.log(`${city1}: Lowest price sprzedaży: ${priceCity1.sell_price_min || 'No data'}`);
    console.log(`${city2}: Lowest price sprzedaży: ${priceCity2.sell_price_min || 'No data'}`);

    // price difference
    if (priceCity1.sell_price_min && priceCity2.sell_price_min) {
      const difference = priceCity1.sell_price_min - priceCity2.sell_price_min;
      console.log(`Price difference: ${difference > 0 ? '+' : ''}${difference} silver`);
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

// arguments from terminal
const args = process.argv.slice(2);
const [itemId, city1, city2, quality] = args;

if (!itemId || !city1 || !city2) {
  console.log("Usage: albion-prices <itemId> <city1> <city2> [quality]");
} else {
  compareItemPrices(itemId, city1, city2, parseInt(quality) || 1);
}