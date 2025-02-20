const Fuse = require('fuse.js');

// Lista przykładowych przedmiotów
const items = [
  "T4_BAG",
  "T5_BAG",
  "SWIFTCLAW",
  "SADDLE_SWIFTCLAW",
  "MAMMOTH",
  "T8_MAMMOTH"
];

// Konfiguracja Fuse.js
const fuse = new Fuse(items, {
  includeScore: true,
  threshold: 0.3 // Im mniejsza wartość, tym dokładniejsze dopasowanie
});

// Testowe wyszukiwanie
const input = "Swiftclawwww"; // Symulujemy literówkę
const result = fuse.search(input);

// Wyświetlamy wynik
if (result.length > 0) {
  console.log(`Najlepsze dopasowanie: ${result[0].item}`);
} else {
  console.log("Nie znaleziono dopasowania.");
}