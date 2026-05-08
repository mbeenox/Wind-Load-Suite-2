# Wind Suite — ASCE 7 Wind Load Calculator + Site Hazard Lookup

A self-contained React app combining:
- **WSS Load Lookup** — site hazard parameters (wind, seismic, snow, ice, rain, flood, tsunami, tornado) via USGS / ASCE GIS / FEMA / NOAA APIs
- **ASCE 7 Wind Load Calculator** — full wind pressure calculations (MWFRS, C&C, Open Bldg, Roof W, Other W) for editions 7-05 through 7-22

---

## Repo Structure

```
wind-suite/
├── api/
│   └── proxy.js          ← Vercel serverless CORS proxy
├── src/
│   ├── WindSuiteApp.jsx  ← All app logic (self-contained, no backend)
│   └── main.jsx          ← React entry point
├── index.html            ← Loads Leaflet CDN + mounts app
├── package.json
├── vite.config.js
└── vercel.json
```

---

## Deploy to Vercel (GitHub → Vercel)

1. Create a new GitHub repo named `wind-suite`
2. Upload all files maintaining the folder structure above
3. Go to vercel.com → Add New Project → Import the `wind-suite` repo
4. Framework: **Vite** (auto-detected)
5. No environment variables needed
6. Deploy → done

---

## How It Works

### Left Sidebar — Two Tabs

**🌐 Site Hazards tab**
- Enter address, lat/lon, or pick on map
- Select ASCE standard (7-10, 7-16, 7-22), Risk Category, Site Soil Class
- Click **Run Hazard Lookup** → fetches all 8 hazards in parallel
- Wind result appears with **→ Send to Wind Inputs** button
- Clicking Send pre-fills Edition, Risk Category, and V in the Wind Inputs tab

**💨 Wind Inputs tab**
- Full ASCE 7 sidebar (Edition, Risk Cat, Exposure, V, Geometry, Kzt, Gust)
- When pre-filled from WSS: Edition / RC / V are grayed out with a 🔗 badge
- Click **Edit manually** to unlock and override
- Click **Restore WSS values** to snap back to hazard lookup values

### Right Content Area
- Unchanged: Qz Profile, MWFRS Dir, MWFRS LR, C&C, Open Bldg, Roof W, Other W tabs

---

## Notes

- **No backend required** — all wind load calculations are inline JavaScript
- **CORS proxy** — all hazard API calls route through `/api/proxy` (Vercel serverless)
- **7-05 edition** — available in Wind Calculator only, not in WSS Lookup (no API source)
- **Seismic / snow auto-populate** — not wired yet; planned for future calculator tabs
- **Leaflet** loaded via CDN in `index.html` — do not add to npm dependencies
