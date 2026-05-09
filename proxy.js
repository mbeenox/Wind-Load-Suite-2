// api/proxy.js — Vercel serverless CORS proxy
// Uses ESM export to match package.json "type": "module"

const ALLOWED = [
  'earthquake.usgs.gov',
  'gis.asce.org',
  'hazards.fema.gov',
  'hdsc.nws.noaa.gov',
  'nominatim.openstreetmap.org',
  'geocoding.geo.census.gov',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { target } = req.query;
  if (!target) return res.status(400).json({ error: 'Missing target' });

  let url;
  try { url = new URL(target); }
  catch { return res.status(400).json({ error: 'Invalid URL: ' + target }); }

  if (!ALLOWED.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    return res.status(403).json({ error: 'Host not allowed: ' + url.hostname });
  }

  try {
    const upstream = await fetch(target, { headers: { 'User-Agent': 'WindSuite/1.0' } });
    const contentType = upstream.headers.get('content-type') || 'application/json';
    const body = await upstream.text();
    res.setHeader('Content-Type', contentType);
    return res.status(upstream.status).send(body);
  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}
