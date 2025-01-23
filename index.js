#!/usr/bin/env node
const axios = require('axios');

// Funkcja do pobierania i porównywania cen przedmiotu w wybranych miastach z uwzględnieniem jakości
async function compareItemPrices(itemId, city1, city2, quality = 1) {
  const url = `https://www.albion-online-data.com/api/v2/stats/prices/${itemId}.json`;

  try {
    const response = await axios.get(url);
    const data = response.data;

    // Filtrowanie danych według jakości
    const filteredData = data.filter(item => item.quality === quality);

    // Filtrujemy dane dla dwóch wybranych miast
    const priceCity1 = filteredData.find(item => item.city === city1);
    const priceCity2 = filteredData.find(item => item.city === city2);

    if (!priceCity1 || !priceCity2) {
      console.log("Nie znaleziono cen dla jednego z miast lub przedmiotu o podanej jakości.");
      return;
    }

    // Wyświetlamy porównanie
    console.log(`Ceny dla przedmiotu ${itemId} (Quality ${quality}):`);
    console.log(`${city1}: Najniższa cena sprzedaży: ${priceCity1.sell_price_min || 'Brak danych'}`);
    console.log(`${city2}: Najniższa cena sprzedaży: ${priceCity2.sell_price_min || 'Brak danych'}`);

    // Porównanie różnic w cenie
    if (priceCity1.sell_price_min && priceCity2.sell_price_min) {
      const difference = priceCity1.sell_price_min - priceCity2.sell_price_min;
      console.log(`Różnica w cenie: ${difference > 0 ? '+' : ''}${difference} srebra`);
    }
  } catch (error) {
    console.error("Błąd podczas pobierania danych:", error.message);
  }
}

// Pobieramy argumenty z terminala
const args = process.argv.slice(2);
const [itemId, city1, city2, quality] = args;

if (!itemId || !city1 || !city2) {
  console.log("Użycie: albion-prices <itemId> <city1> <city2> [quality]");
} else {
  compareItemPrices(itemId, city1, city2, parseInt(quality) || 1);
}