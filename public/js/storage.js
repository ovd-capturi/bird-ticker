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

  // Last observations
  getObservations() {
    return this.get("observations");
  },

  saveObservations(data) {
    data._savedAt = Date.now();
    this.set("observations", data);
  },

  // Alerts (matched missing birds)
  getAlerts() {
    return this.get("alerts");
  },

  saveAlerts(data) {
    this.set("alerts", data);
  },
};
