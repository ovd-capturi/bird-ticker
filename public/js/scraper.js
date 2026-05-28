// ─── API Client / Data Fetcher ─────────────────────────────────
const API_BASE = location.origin;

const Scraper = {
  async fetchTickList(userId, listType = "1") {
    const url = `${API_BASE}/api/ticklist?userId=${encodeURIComponent(userId)}&listType=${encodeURIComponent(listType)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
   },

  async sendChatMessage({ deviceId, userId, listType, lat, lng, message }) {
    const res = await fetch(`${API_BASE}/api/ai-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, userId, listType, lat, lng, message }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
   },

  async fetchChatHistory(deviceId) {
    const res = await fetch(
      `${API_BASE}/api/ai-chat/history?deviceId=${encodeURIComponent(deviceId)}`
    );
    if (!res.ok) return { messages: [] };
    return res.json();
   },

  async clearChatHistory(deviceId) {
    const res = await fetch(
      `${API_BASE}/api/ai-chat?deviceId=${encodeURIComponent(deviceId)}`,
      { method: "DELETE" }
    );
    return res.ok;
   },

  async fetchPredictorDataset({ userId, listType, lat, lng, mode = "day", month }) {
    const params = new URLSearchParams({ userId, listType, mode });
    if (mode === "day") {
      params.set("lat", lat);
      params.set("lng", lng);
    } else if (mode === "calendar") {
      params.set("month", month);
    }
    const url = `${API_BASE}/api/predictor-dataset?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
   },

  async fetchCalendarMonth(userId, listType, month) {
    const url = `${API_BASE}/api/ai-calendar?userId=${encodeURIComponent(userId)}&listType=${encodeURIComponent(listType)}&month=${encodeURIComponent(month)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
   },

  async fetchObservations(region = "all", date = null) {
    let url = `${API_BASE}/api/observations?region=${encodeURIComponent(region)}`;
    if (date) url += `&date=${encodeURIComponent(date)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
   },

   // Fetch full species name -> artId map from DOFbasen
  async fetchSpeciesMap() {
    const url = `${API_BASE}/api/species-map`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    return data.byName || {};
   },

   // Fetch coordinates for localities missing coords
  async fetchLocalityCoords(loknrs) {
    if (!loknrs.length) return {};
    const ids = loknrs.join(",");
    const url = `${API_BASE}/api/localities?ids=${encodeURIComponent(ids)}`;
    const res = await fetch(url);
    if (!res.ok) return {};
    return res.json();
   },

   // Resolve coordinates for observations that lack them
  async resolveCoordinates(observations) {
    if (!observations?.observations) return observations;

     // Find observations missing coords but having loknr
    const needCoords = [];
    for (const obs of observations.observations) {
      if (obs.lat == null && obs.loknr) {
         // Check localStorage cache first
        const cached = Storage.get(`lok-${obs.loknr}`);
        if (cached) {
          obs.lat = cached.lat;
          obs.lng = cached.lng;
         } else {
          needCoords.push(obs.loknr);
         }
       }
     }

     // Fetch missing locality coordinates in batch
    const uniqueLoknrs = [...new Set(needCoords)];
    if (uniqueLoknrs.length > 0) {
      try {
        const lokMap = await this.fetchLocalityCoords(uniqueLoknrs);
         // Cache results and apply to observations
        for (const [loknr, data] of Object.entries(lokMap)) {
          Storage.set(`lok-${loknr}`, data);
         }
        for (const obs of observations.observations) {
          if (obs.lat == null && obs.loknr && lokMap[obs.loknr]) {
            obs.lat = lokMap[obs.loknr].lat;
            obs.lng = lokMap[obs.loknr].lng;
           }
         }
       } catch (err) {
        console.warn("Failed to resolve locality coords:", err);
       }
     }

    return observations;
   },

   // Normalize a bird name for matching
  normalizeName(name) {
    return name
       .toLowerCase()
       .trim()
       .replace(/\s+/g, " ")
       .normalize("NFC");
   },

   // Haversine distance in km
  distanceKm(lat1, lng1, lat2, lng2) {
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
   },

   // Find missing birds that appear in today's observations
  matchAlerts(tickList, observations, userLat, userLng) {
    if (!tickList?.birds || !observations?.observations) return [];

     // Build set of missing birds (not ticked, not removed from list)
    const missingByLatin = new Map();
    const missingByName = new Map();

    for (const bird of tickList.birds) {
      if (!bird.ticked && !bird.removed) {
        if (bird.latin) {
          missingByLatin.set(this.normalizeName(bird.latin), bird);
         }
        missingByName.set(this.normalizeName(bird.name), bird);
       }
     }

    const alerts = [];
    const seenSpecies = new Set();

    for (const obs of observations.observations) {
      const latinKey = this.normalizeName(obs.latin);
      const nameKey = this.normalizeName(obs.species);

      const matchedBird = missingByLatin.get(latinKey) || missingByName.get(nameKey);

      if (matchedBird) {
        const speciesKey = matchedBird.latin || matchedBird.name;
        if (!seenSpecies.has(speciesKey + obs.location)) {
          seenSpecies.add(speciesKey + obs.location);

          const dist = this.distanceKm(userLat, userLng, obs.lat, obs.lng);

          alerts.push({
             ...obs,
            tickListName: matchedBird.name,
            tickListLatin: matchedBird.latin,
            number: matchedBird.number,
            distance: dist != null ? Math.round(dist * 10) / 10 : null,
           });
         }
       }
     }

    return alerts;
   },

   // Parse time string to minutes since midnight (for sorting)
   // Handles: "HH:MM", "HH:MM-HH:MM", "HH:MM-"
   // Returns the START time as minutes, or null
  parseTimeMinutes(timeStr) {
    if (!timeStr) return null;
    const m = timeStr.match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
   },

   // Sort alerts by different criteria (individual alerts)
  sortAlerts(alerts, mode) {
    const sorted = [...alerts];
    switch (mode) {
      case "distance":
        sorted.sort((a, b) => {
          if (a.distance == null && b.distance == null) return 0;
          if (a.distance == null) return 1;
          if (b.distance == null) return -1;
          return a.distance - b.distance;
         });
        break;
      case "rarity":
        sorted.sort((a, b) => {
          if (a.rare !== b.rare) return a.rare ? -1 : 1;
          if (a.scarce !== b.scarce) return a.scarce ? -1 : 1;
          return a.species.localeCompare(b.species, "da");
         });
        break;
      case "name":
        sorted.sort((a, b) => a.species.localeCompare(b.species, "da"));
        break;
      case "time":
        sorted.sort((a, b) => {
          const ta = this.parseTimeMinutes(a.time);
          const tb = this.parseTimeMinutes(b.time);
          if (ta == null && tb == null) return 0;
          if (ta == null) return 1;
          if (tb == null) return -1;
          return tb - ta; // latest first
         });
        break;
     }
    return sorted;
   },

   // Sort grouped alerts (each group has multiple observations, sort by group's most recent)
  sortGroupedAlerts(grouped, mode) {
    const sorted = [...grouped];
    switch (mode) {
      case "distance":
        sorted.sort((a, b) => {
          if (a.distance == null && b.distance == null) return 0;
          if (a.distance == null) return 1;
          if (b.distance == null) return -1;
          return a.distance - b.distance;
         });
        break;
      case "rarity":
        sorted.sort((a, b) => {
          if (a.rare !== b.rare) return a.rare ? -1 : 1;
          if (a.scarce !== b.scarce) return a.scarce ? -1 : 1;
          return a.species.localeCompare(b.species, "da");
         });
        break;
      case "name":
        sorted.sort((a, b) => a.species.localeCompare(b.species, "da"));
        break;
      case "time":
         // Sort by group's most recent observation (first entry has the time)
         sorted.sort((a, b) => {
          const ta = this.parseTimeMinutes(a.time);
          const tb = this.parseTimeMinutes(b.time);
          if (ta == null && tb == null) return 0;
          if (ta == null) return 1;
          if (tb == null) return -1;
          return tb - ta; // latest first
         });
        break;
     }
    return sorted;
  },

   // Build a latin name -> artId map from observations
  buildArtIdMap(observations) {
    const map = {};
    if (!observations?.observations) return map;
    for (const obs of observations.observations) {
      if (obs.artId && obs.latin) {
        map[this.normalizeName(obs.latin)] = obs.artId;
       }
     }
    return map;
   },

   // Get DOFbasen species page URL
  getDofbasenUrl(artId) {
    if (!artId) return null;
    return `https://dofbasen.dk/danmarksfugle/art/${artId}`;
   },

   // Deep link to a locality's observations on a given date (YYYY-MM-DD)
  getDofbasenObsUrl(loknr, dateStr) {
    if (!loknr || !dateStr) return null;
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const visidag = `${m[3]}-${m[2]}-${m[1]}`;
    return `https://dofbasen.dk/observationer/index.php?lok=${loknr}&visning=allfugle&visidag=${visidag}`;
   },

   // Get Apple Maps / Google Maps URL for coordinates
  getMapUrl(lat, lng, label) {
    if (lat == null || lng == null) return null;
    return `https://maps.apple.com/?q=${encodeURIComponent(label || "Fugl")}&ll=${lat},${lng}&z=14`;
   },

   // ─── Push Notifications ────────────────────────────────────
  async getVapidKey() {
    const res = await fetch(`${API_BASE}/api/push/vapid-key`);
    const data = await res.json();
    return data.publicKey;
   },

  async subscribePush(subscription, userId, listType) {
    await fetch(`${API_BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription, userId, listType }),
     });
   },

  async unsubscribePush(endpoint) {
    await fetch(`${API_BASE}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
     });
   },
};
