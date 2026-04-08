# 🐦 Bird Ticker - PWA Plan

## Concept
A Progressive Web App that cross-references your **Netfugl.dk tick list** (krydsliste) with **DOFbasen.dk's latest observations** to alert you when a bird you **haven't ticked** has been spotted in Denmark.

---

## Data Sources

### 1. Netfugl.dk Tick List
- **URL pattern**: `https://netfugl.dk/ranking/{listType}/{userId}`
- **Example**: `https://netfugl.dk/ranking/1/4468` (Danske Arter for user 4468)
- **Format**: HTML table with columns: `#`, `X`, `*`, `Navn`, `Dato`, `Lokation`, `Kort`
- **Key data**: Birds with `X` in column 2 = ticked/seen. Empty = **missing bird** (target!)
- `*` column marks birds no longer on the Danish list
- Bird names are Danish + Latin in parentheses

### 2. DOFbasen.dk Observations
- **URL**: `https://dofbasen.dk/observationer/`
- **Format**: HTML page with species in `<span class="defaultart">`, `<span class="subart">`, `<span class="seasonart">` + Latin in `<i>` tags
- **Key data**: Species name (Danish), Latin name, count, location, observer, behavior, time
- Can filter by date, region (lokalafdeling), observation type

---

## Architecture

### Tech Stack
- **Frontend**: Vanilla HTML/CSS/JS (no framework needed — keeps it simple & fast)
- **Backend/Proxy**: Small server needed for CORS (both sites don't have public APIs)
  - Option A: Cloudflare Worker (free tier, serverless)
  - Option B: Simple Node.js/Express proxy on e.g. Fly.io or Railway
  - Option C: Use a public CORS proxy (less reliable)
- **Storage**: `localStorage` for caching tick list + preferences
- **PWA**: Service Worker + Web App Manifest for offline support & home screen install

### Why a proxy is needed
Both netfugl.dk and dofbasen.dk serve HTML (no public JSON API) and don't set CORS headers. The app must scrape HTML, which requires a server-side proxy to fetch the pages and return parsed data.

---

## Features

### Phase 1 — MVP
1. **Configure your list**: Enter your Netfugl user ID (and list type, default "Danske Arter")
2. **Fetch & parse tick list**: Scrape netfugl.dk, extract all birds and their X/not-X status
3. **Fetch & parse today's observations**: Scrape dofbasen.dk observations page
4. **Match & highlight**: Show observations of species you're **missing** (no X)
5. **Alert list view**: Sorted by time, showing:
   - 🔴 Species name (Danish + Latin)
   - Location
   - Count
   - Time
   - Observer
6. **PWA install**: Add to home screen on iPhone with proper icon & splash screen

### Phase 2 — Enhanced
7. **Push-like notifications**: Background periodic fetch via service worker (limited on iOS, but can poll when app is open)
8. **Filter by region**: Choose lokalafdeling (DOFbasen supports this)
9. **Rarity highlighting**: Extra emphasis on `<span class="su">` (rare) and `<span class="subart">` (scarce) species
10. **Map view**: Show observation locations on a map
11. **Cache tick list**: Don't re-fetch every time; manual refresh button
12. **Stats**: Show progress — "You've seen 287/498 Danish species"

### Phase 3 — Nice to have
13. **Multiple lists**: Support year lists (årsarter), VP list, etc.
14. **Sound alert**: Play a sound when a new missing bird appears
15. **History**: Track which missing birds appeared over time
16. **Share**: Share a spotted missing bird alert

---

## File Structure

```
bird-app/
├── index.html              # Main app shell
├── css/
│   └── style.css           # Mobile-first responsive styles
├── js/
│   ├── app.js              # Main app logic & UI
│   ├── scraper.js          # Parsing logic for both sites
│   └── storage.js          # localStorage wrapper
├── sw.js                   # Service Worker for PWA/caching
├── manifest.json           # PWA manifest
├── icons/                  # App icons (192x192, 512x512)
│   ├── icon-192.png
│   └── icon-512.png
└── proxy/
    └── worker.js           # Cloudflare Worker proxy (or Node server)
```

---

## Proxy API Design

The proxy server exposes two endpoints:

### `GET /api/ticklist?listType=1&userId=4468`
- Fetches `https://netfugl.dk/ranking/{listType}/{userId}`
- Parses HTML table
- Returns JSON:
```json
{
  "user": "4468",
  "listType": "1",
  "listName": "Danske Arter",
  "total": 498,
  "ticked": 287,
  "birds": [
    { "number": 1, "name": "Urfugl", "latin": "Lyrurus tetrix", "ticked": false, "removed": true },
    { "number": 2, "name": "Agerhøne", "latin": "Perdix perdix", "ticked": true, "removed": false },
    ...
  ]
}
```

### `GET /api/observations?date=2026-04-08&region=all`
- Fetches `https://dofbasen.dk/observationer/`
- Parses HTML
- Returns JSON:
```json
{
  "date": "2026-04-08",
  "observations": [
    {
      "species": "Nordisk Lappedykker",
      "latin": "Podiceps auritus",
      "count": 2,
      "location": "Asserbo Strand (Melby Strand)",
      "observer": "Jon Lehmberg",
      "behavior": "R",
      "time": null,
      "rare": false,
      "scarce": false
    },
    ...
  ]
}
```

---

## Matching Logic

1. Build a **Set of missing birds** from the tick list (where `ticked === false`)
2. For each DOFbasen observation, check if species name OR Latin name matches a missing bird
3. Name matching should be **fuzzy-tolerant** for encoding issues (DOFbasen uses ISO-8859-1, Netfugl uses UTF-8) — normalize both to handle `ø/ö`, `å/aa`, etc.
4. Present matches as **alerts**, sorted by rarity first, then time

---

## UI Wireframes (Mobile-first)

```
┌─────────────────────────────┐
│ 🐦 Bird Ticker         ⚙️  │
│─────────────────────────────│
│ 📊 287/498 ticked           │
│ 🔍 3 missing birds spotted! │
│─────────────────────────────│
│                             │
│ 🔴 Fiskeørn                 │
│    Pandion haliaetus         │
│    📍 Hellebæk området      │
│    🕐 09:07 · 1 stk · NØ   │
│    👤 Kristian Gerdes        │
│                             │
│ 🟡 Rørdrum                  │
│    Botaurus stellaris        │
│    📍 Vaserne               │
│    🕐 07:38 · 1 stk · R    │
│    👤 Bent Søndervang        │
│                             │
│ 🟡 Mosehornugle             │
│    Asio flammeus             │
│    📍 Melby Overdrev        │
│    🕐 07:45 · 2 stk · R    │
│    👤 Jon Lehmberg           │
│                             │
│─────────────────────────────│
│ [🔄 Refresh]  [📋 All obs] │
│─────────────────────────────│
│ Last updated: 13:45         │
└─────────────────────────────┘
```

---

## Implementation Steps

### Step 1: Proxy Server (Cloudflare Worker)
- [ ] Create Cloudflare Worker that fetches & parses both sites
- [ ] Handle character encoding (ISO-8859-1 → UTF-8 for DOFbasen)
- [ ] Return clean JSON
- [ ] Add basic caching (5 min for observations, 1 hour for tick list)
- [ ] Deploy

### Step 2: Core PWA Shell
- [ ] Create `index.html` with mobile viewport, iOS meta tags
- [ ] Create `manifest.json` with app name, icons, theme color
- [ ] Create `sw.js` with app shell caching strategy
- [ ] Style with CSS (dark mode support, iOS safe areas)
- [ ] Generate app icons

### Step 3: Settings & Tick List
- [ ] Settings page: enter Netfugl user ID, select list type
- [ ] Fetch tick list via proxy
- [ ] Parse & store in localStorage
- [ ] Show tick list stats (X of Y ticked)
- [ ] Manual refresh button

### Step 4: Observation Matching
- [ ] Fetch today's observations via proxy
- [ ] Cross-reference with missing birds
- [ ] Display matched alerts with all details
- [ ] Auto-refresh every 5 minutes when app is open

### Step 5: Polish & Deploy
- [ ] Add pull-to-refresh gesture
- [ ] Add loading states & error handling
- [ ] Handle offline gracefully (show cached data)
- [ ] Deploy static files (GitHub Pages, Netlify, or Cloudflare Pages)
- [ ] Test on iPhone Safari — install to home screen

---

## Key Technical Considerations

### iOS PWA Limitations
- No real push notifications (iOS 16.4+ supports them for home screen PWAs, but requires user permission and is limited)
- Service Worker `fetch` in background is restricted — use in-app polling instead
- Must include `<meta name="apple-mobile-web-app-capable" content="yes">` and related tags
- Safe area insets for notched iPhones: `env(safe-area-inset-top)` etc.

### Character Encoding
- DOFbasen uses ISO-8859-1 (`ø` = `\xF8`, `å` = `\xE5`)
- Netfugl uses UTF-8
- The proxy must normalize both to UTF-8 for consistent matching

### Rate Limiting & Politeness
- Cache aggressively — tick lists rarely change
- Don't hammer DOFbasen — max 1 request per 5 minutes
- Add proper User-Agent header in proxy
- Consider adding `robots.txt` check

### Name Matching Edge Cases
- Some names differ slightly between the two sites
- Use Latin name as primary match key (more standardized)
- Fallback to Danish name fuzzy match
- Handle subspecies vs species differences
