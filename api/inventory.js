// Pyrolandia Inventory Cache API
// Vercel serverless function - caches Google Sheet data for 5 minutes
// Set SHEET_ID as environment variable in Vercel dashboard

const SHEET_ID = process.env.SHEET_ID || '16J7v_ODo4Ru4ZSytQI80dlA5a_Mh8fkgU5nqxEXd8U0';
const TABS = ['1/1','2/1','500G','200G','SHELLS','CANDLES','ROCKETS','FOUNTAINS','MISC'];
const CACHE_TTL = 5 * 60 * 1000;

let cache = { data: null, ts: 0 };

function parseCSVRow(row) {
  const result = [];
  let inQ = false, cur = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur.trim().replace(/^"|"$/g, '')); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur.trim().replace(/^"|"$/g, ''));
  return result;
}

function isBlank(line) {
  return line.replace(/","/g, '').replace(/"/g, '').replace(/,/g, '').trim() === '';
}

function parseTab(csv, tabIndex) {
  const lines = csv.split('\n');
  const items = [], seen = {};
  let hIdx = -1, hdrs = [];
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (isBlank(lines[i])) continue;
    const row = parseCSVRow(lines[i]);
    const nc = row.findIndex(h => h.toUpperCase().trim() === 'PRODUCT NAME');
    if (nc >= 0) { hIdx = i; hdrs = row; break; }
  }
  if (hIdx < 0) return [];
  let sC=-1, nC=-1, pC=-1, cpC=-1, pkC=-1, csC=-1, siC=-1, tC=-1;
  hdrs.forEach((h, i) => {
    const hdr = h.toUpperCase().trim();
    if (hdr === 'STATUS') sC=i;
    else if (hdr === 'PRODUCT NAME') nC=i;
    else if (hdr === 'PRICE' || hdr === 'RETAIL') pC=i;
    else if (hdr === 'CASE PRICE' || hdr === 'CASEPRICE') cpC=i;
    else if (hdr === 'PACKED') pkC=i;
    else if (hdr === 'CASES' || hdr === 'CONTAINER') csC=i;
    else if (hdr === 'SINGLES' || hdr === 'STORE') siC=i;
    else if (hdr === 'TOTAL' || hdr === 'QTY') tC=i;
  });
  if (nC < 0) return [];
  for (let i = hIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim() || isBlank(lines[i])) continue;
    const row = parseCSVRow(lines[i]);
    const name = row[nC].trim();
    if (!name || name.toUpperCase() === 'PRODUCT NAME') continue;
    const key = `${tabIndex}_${name.toUpperCase()}`;
    if (seen[key]) continue;
    seen[key] = true;
    const price  = pC  >= 0 ? row[pC].replace(/[^0-9.]/g, '').trim() : '';
    const caseP  = cpC >= 0 ? row[cpC].replace(/[^0-9.]/g, '').trim() : '';
    const packed = pkC >= 0 ? row[pkC].trim() : '';
    const cases  = csC >= 0 ? parseInt(row[csC]) || 0 : 0;
    const singles= siC >= 0 ? parseInt(row[siC]) || 0 : 0;
    const total  = tC  >= 0 ? parseInt(row[tC])  || 0 : 0;
    const qty    = total > 0 ? total : cases + singles;
    const rawS   = sC  >= 0 ? row[sC].trim().toUpperCase() : '';
    let status;
    if (qty > 0) status = qty <= 2 ? 'LOW' : 'IN';
    else if (['IN','LOW','OUT'].includes(rawS)) status = rawS;
    else status = 'OUT'; // keep priced-but-empty rows (don't drop them)
    items.push({ t: tabIndex, s: status, n: name, p: price, cp: caseP, pk: packed, qty });
  }
  return items;
}

async function fetchAllInventory() {
  const fetches = TABS.map((tab, idx) => {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}&t=${Date.now()}`;
    return fetch(url).then(r => r.text()).then(csv => parseTab(csv, idx)).catch(() => []);
  });
  const results = await Promise.all(fetches);
  const seen = {}, data = [];
  for (const items of results) {
    for (const item of items) {
      const key = `${item.t}_${item.n.toUpperCase()}`;
      if (!seen[key]) { seen[key] = true; data.push(item); }
    }
  }
  return data;
}

async function fetchDeals() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=DEALS&t=${Date.now()}`;
  try {
    const csv = await fetch(url).then(r => r.text());
    const lines = csv.split('\n');
    if (!lines.length) return [];
    const hdr = parseCSVRow(lines[0]);
    const fh = (hdr[0] || '').toUpperCase().trim();
    const startRow = (fh === 'ID' || fh === 'PRODUCT NAME') ? 1 : 0;
    const deals = [];
    for (let i = startRow; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const row = parseCSVRow(lines[i]);
      if (!row[0]) continue;
      const qty = parseInt(row[3]) || 0;
      const price = parseFloat(row[4]) || 0;
      if (!qty || !price) continue;
      deals.push({ id: row[0], productName: (row[1]||'').trim(), tab: parseInt(row[2])||0, qty, price, note: (row[5]||'').trim() });
    }
    return deals;
  } catch { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_TTL) {
    return res.status(200).json({ ...cache.data, cached: true, age: Math.round((now - cache.ts) / 1000) });
  }
  try {
    const [inventory, deals] = await Promise.all([fetchAllInventory(), fetchDeals()]);
    cache = { data: { inventory, deals }, ts: now };
    return res.status(200).json({ inventory, deals, cached: false, age: 0 });
  } catch (err) {
    if (cache.data) {
      return res.status(200).json({ ...cache.data, cached: true, stale: true, age: Math.round((now - cache.ts) / 1000) });
    }
    return res.status(500).json({ error: 'Failed to fetch inventory', message: err.message });
  }
}
