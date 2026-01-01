// src/utils/units.js

function parseQuantity(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const range = s.match(/^(\d+(?:\s+\d+\/\d+|\.\d+)?)\s*[-–]\s*(\d+(?:\s+\d+\/\d+|\.\d+)?)/);
  if (range) {
    const a = parseQuantity(range[1]);
    const b = parseQuantity(range[2]);
    if (a != null && b != null) return (a + b) / 2;
  }
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return parseFloat(mixed[1]) + parseFloat(mixed[2]) / parseFloat(mixed[3]);
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseFloat(frac[1]) / parseFloat(frac[2]);
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function roundSmart(n, unit) {
  if (n == null) return n;
  if (unit === 'g') { if (n < 50) return Math.round(n); if (n < 200) return Math.round(n/5)*5; return Math.round(n/10)*10; }
  if (unit === 'ml') { if (n < 50) return Math.round(n/5)*5; if (n < 250) return Math.round(n/10)*10; return Math.round(n/25)*25; }
  if (unit === '°C' || unit === '°F') return Math.round(n);
  if (unit === 'cm' || unit === 'in') return Math.round(n*10)/10;
  return Math.round(n*100)/100;
}

const UNITS = {
  weightStd: [
    { key: 'lb',  rx: '(lb|lbs|pounds?)', toMetric: v=>v*453.592, metricKey:'g', fromMetric:g=>g/453.592 },
    { key: 'oz',  rx: '(oz|ounces?)',     toMetric: v=>v*28.3495, metricKey:'g', fromMetric:g=>g/28.3495 },
  ],
  weightMet: [
    { key: 'g',  rx: '(g|grams?)' },
    { key: 'kg', rx: '(kg|kilograms?)' },
  ],
  volumeStd: [
    { key: 'tsp',   rx: '(tsp|teaspoons?)', toMetric:v=>v*5,        metricKey:'ml', fromMetric:ml=>ml/5 },
    { key: 'tbsp',  rx: '(tbsp|tablespoons?)', toMetric:v=>v*15,    metricKey:'ml', fromMetric:ml=>ml/15 },
    { key: 'cup',   rx: '(cups?)',          toMetric:v=>v*240,      metricKey:'ml', fromMetric:ml=>ml/240 },
    { key: 'fl oz', rx: '(fl\\s*oz|fluid\\s*ounces?)', toMetric:v=>v*29.5735, metricKey:'ml', fromMetric:ml=>ml/29.5735 },
    { key: 'pt',    rx: '(pts?|pints?)',    toMetric:v=>v*473.176,  metricKey:'ml', fromMetric:ml=>ml/473.176 },
    { key: 'qt',    rx: '(qts?|quarts?)',   toMetric:v=>v*946.353,  metricKey:'ml', fromMetric:ml=>ml/946.353 },
    { key: 'gal',   rx: '(gals?|gallons?)', toMetric:v=>v*3785.41,  metricKey:'ml', fromMetric:ml=>ml/3785.41 },
  ],
  volumeMet: [
    { key: 'ml', rx: '(ml|millilit(er|re)s?)' },
    { key: 'l',  rx: '((l|L)|lit(er|re)s?)' },
  ],
  lengthStd: [{ key: 'in', rx: '(in|inches?)', toMetric:v=>v*2.54, metricKey:'cm', fromMetric:cm=>cm/2.54 }],
  lengthMet: [{ key: 'cm', rx: '(cm|centimet(er|re)s?)' }],
  temp: [{ key: '°F', rx: '°?\\s?F', toMetric:f=>(f-32)*5/9, fromMetric:c=>(c*9/5)+32, metricKey:'°C' }],
};

const unitParts = [].concat(UNITS.weightStd, UNITS.volumeStd, UNITS.lengthStd, UNITS.temp)
  .map(u => u.rx);
const unitRegex = new RegExp(`\\b(\\d+(?:\\s+\\d+/\\d+|/\\d+|\\.\\d+)?)\\s*(${unitParts.join('|')})\\b`, 'gi');
const tempRegex = /\b(\d{2,3})\s*°?\s*F\b/gi;
const tempCRegex = /\b(\d{2,3})\s*°?\s*C\b/gi;

export const UnitSystem = { STANDARD: 'standard', METRIC: 'metric' };

export function convertTextLine(line, toSystem = UnitSystem.METRIC) {
  if (!line) return line;
  let out = line;

  // Temps
  out = toSystem === UnitSystem.METRIC
    ? out.replace(tempRegex, (_, n) => `${roundSmart(((+n - 32)*5)/9, '°C')}°C`)
    : out.replace(tempCRegex, (_, n) => `${roundSmart((+n*9)/5 + 32, '°F')}°F`);

  // Weights / volumes / lengths
  out = out.replace(unitRegex, (m, qtyRaw, ...rest) => {
    const qty = parseQuantity(qtyRaw); if (qty == null) return m;
    const all = [].concat(UNITS.weightStd, UNITS.volumeStd, UNITS.lengthStd, UNITS.temp, UNITS.weightMet, UNITS.volumeMet, UNITS.lengthMet);
    const matchedUnitText = rest.find(x => typeof x === 'string' && x) || '';
    const u = all.find(u => new RegExp(`^${u.rx}$`, 'i').test(matchedUnitText));
    if (!u) return m;

    if (toSystem === UnitSystem.METRIC) {
      if (u.toMetric && u.metricKey) {
        let converted = u.toMetric(qty);
        let key = u.metricKey;
        if (key === 'l' && converted < 1.5) { converted *= 1000; key = 'ml'; }
        return `${roundSmart(converted, key)} ${key}`;
      }
      return m;
    } else {
      // metric -> standard
      if (/(^g$|grams?)/i.test(matchedUnitText)) {
        const g = qty;
        if (g >= 454) return `${roundSmart(g/453.592, 'lb')} lb`;
        return `${roundSmart(g/28.3495, 'oz')} oz`;
      }
      if (/(^kg$|kilograms?)/i.test(matchedUnitText)) return `${roundSmart((qty*1000)/453.592, 'lb')} lb`;
      if (/(^ml$|millilit(er|re)s?)/i.test(matchedUnitText)) {
        const ml = qty;
        if (ml >= 946) return `${roundSmart(ml/946.353, 'qt')} qt`;
        if (ml >= 240) return `${roundSmart(ml/240, 'cup')} cup`;
        if (ml >= 15)  return `${roundSmart(ml/15, 'tbsp')} tbsp`;
        return `${roundSmart(ml/5, 'tsp')} tsp`;
      }
      if (/((^l$|lit(er|re)s?))/i.test(matchedUnitText)) return `${roundSmart((qty*1000)/946.353, 'qt')} qt`;
      if (/(^cm$|centimet(er|re)s?)/i.test(matchedUnitText)) return `${roundSmart(qty/2.54, 'in')} in`;
      return m;
    }
  });

  return out;
}

export function convertIngredient(ing, toSystem = UnitSystem.METRIC) {
  if (typeof ing === 'string') return convertTextLine(ing, toSystem);
  if (ing && typeof ing.text === 'string') return { ...ing, text: convertTextLine(ing.text, toSystem) };
  return ing;
}

export function convertRecipe(recipe, toSystem = UnitSystem.METRIC) {
  if (!recipe) return recipe;
  const next = { ...recipe };
  if (Array.isArray(next.ingredients)) next.ingredients = next.ingredients.map(i => convertIngredient(i, toSystem));
  if (Array.isArray(next.instructions)) next.instructions = next.instructions.map(s => convertTextLine(s, toSystem));
  if (typeof next.title === 'string') next.title = convertTextLine(next.title, toSystem);
  if (typeof next.notes === 'string') next.notes = convertTextLine(next.notes, toSystem);
  return next;
}
