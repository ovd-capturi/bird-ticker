// ─── LocalStorage Wrapper ──────────────────────────────────────
const Storage = {
  _prefix: "bird-ticker-",

  get(key) {
    try {
      const raw = localStorage.getItem(this._prefix + key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(this._prefix + key, JSON.stringify(value));
    } catch (e) {
      console.warn("Storage write failed:", e);
    }
  },

  remove(key) {
    localStorage.removeItem(this._prefix + key);
  },

  // Settings
  getSettings() {
    return this.get("settings") || { userId: "", listType: "1" };
  },

  saveSettings(settings) {
    settings._savedAt = Date.now();
    this.set("settings", settings);
  },

  // Tick list
  getTickList() {
    return this.get("ticklist");
  },

  saveTickList(data) {
    data._savedAt = Date.now();
    this.set("ticklist", data);
  },

  // Observations — keyed by date (YYYY-MM-DD), capped at 7 entries (LRU by access).
  _OBS_MAX_DAYS: 7,

  getObservationsMap() {
    return this.get("observationsByDate2") || {};
  },

  getObservations(date) {
    const map = this.getObservationsMap();
    const key = date || "_today";
    const entry = map[key];
    return entry ? entry.data : null;
  },

  saveObservations(data, date) {
    const map = this.getObservationsMap();
    const key = date || "_today";
    data._savedAt = Date.now();
    map[key] = { data, accessedAt: Date.now() };

    // Prune to last N by accessedAt
    const keys = Object.keys(map);
    if (keys.length > this._OBS_MAX_DAYS) {
      keys.sort((a, b) => map[a].accessedAt - map[b].accessedAt);
      while (keys.length > this._OBS_MAX_DAYS) {
        delete map[keys.shift()];
      }
    }
    this.set("observationsByDate2", map);
  },

  touchObservations(date) {
    const map = this.getObservationsMap();
    const key = date || "_today";
    if (map[key]) {
      map[key].accessedAt = Date.now();
      this.set("observationsByDate2", map);
    }
  },

  // Alerts (matched missing birds)
  getAlerts() {
    return this.get("alerts");
  },

  saveAlerts(data) {
    this.set("alerts", data);
  },

  // AI predictions
  getPredictions() {
    return this.get("predictions");
  },

  savePredictions(data) {
    this.set("predictions", data);
  },

  // AI calendar (3-month forward view)
  getCalendar() {
    return this.get("calendar");
  },

  saveCalendar(data) {
    this.set("calendar", data);
  },

  async syncSettingsToServer() {
    try {
      const settings = this.getSettings();
      if (!settings || !settings.userId) return;
      const loc = this.get("userLocation");
      const body = {
        userId: settings.userId,
        listType: settings.listType,
        lat: loc ? loc.lat : null,
        lng: loc ? loc.lng : null,
        settings,
      };
      await fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {}
  },

  async loadSettingsFromServer(userId) {
    if (!userId) return false;
    try {
      const res = await fetch("/api/prefs?userId=" + encodeURIComponent(userId));
      if (res.status !== 200) return false;
      const remote = await res.json();
      const remoteTime = remote.updated_at ? new Date(remote.updated_at).getTime() : 0;
      const localSettings = this.get("settings") || {};
      const localTime = localSettings._savedAt || 0;
      if (remoteTime <= localTime) return false;

      let changed = false;
      const merged = { ...localSettings, ...(remote.settings || {}) };
      if (remote.user_id) merged.userId = remote.user_id;
      if (remote.list_type) merged.listType = remote.list_type;
      merged._savedAt = remoteTime;
      this.set("settings", merged);
      changed = true;

      if (remote.location_lat != null && remote.location_lng != null) {
        const localLoc = this.get("userLocation") || {};
        this.set("userLocation", {
          lat: remote.location_lat,
          lng: remote.location_lng,
          time: localLoc.time || remoteTime,
        });
        changed = true;
      }
      return changed;
    } catch {
      return false;
    }
  },
};
