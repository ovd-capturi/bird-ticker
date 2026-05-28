// Minimal storage façade. Server (Postgres) is source of truth for
// observations, ticklists, alerts, AI results. Device-scoped state
// (Netfugl user, selected list, push toggle, last known location)
// lives in localStorage. Session-scoped derived state (current tick
// list, alerts, AI results, locality lookups) lives in memory.
const Storage = {
  _prefix: "bird-ticker-",
  _mem: new Map(),

  get(key) {
    if (key === "pushEnabled") {
      return localStorage.getItem(this._prefix + "pushEnabled") === "true";
    }
    if (key === "userLocation") {
      try {
        const raw = localStorage.getItem(this._prefix + "userLocation");
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }
    return this._mem.has(key) ? this._mem.get(key) : null;
  },

  set(key, value) {
    if (key === "pushEnabled") {
      localStorage.setItem(this._prefix + "pushEnabled", value ? "true" : "false");
      return;
    }
    if (key === "userLocation") {
      localStorage.setItem(this._prefix + "userLocation", JSON.stringify(value));
      return;
    }
    this._mem.set(key, value);
  },

  remove(key) {
    if (key === "settings") {
      localStorage.removeItem(this._prefix + "userId");
      localStorage.removeItem(this._prefix + "listType");
      return;
    }
    if (key === "pushEnabled" || key === "userLocation") {
      localStorage.removeItem(this._prefix + key);
      return;
    }
    this._mem.delete(key);
  },

  getSettings() {
    return {
      userId: localStorage.getItem(this._prefix + "userId") || "",
      listType: localStorage.getItem(this._prefix + "listType") || "1",
    };
  },

  getCalendarViewMode() {
    const v = localStorage.getItem(this._prefix + "calendarViewMode");
    return v === "raw" ? "raw" : "ai";
  },
  setCalendarViewMode(mode) {
    localStorage.setItem(this._prefix + "calendarViewMode", mode === "raw" ? "raw" : "ai");
  },

  getDeviceId() {
    let id = localStorage.getItem(this._prefix + "deviceId");
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
        (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
      localStorage.setItem(this._prefix + "deviceId", id);
    }
    return id;
  },

  saveSettings(settings) {
    if (settings.userId !== undefined) {
      localStorage.setItem(this._prefix + "userId", settings.userId || "");
    }
    if (settings.listType !== undefined) {
      localStorage.setItem(this._prefix + "listType", settings.listType || "1");
    }
  },

  getTickList() { return this._mem.get("tickList") ?? null; },
  saveTickList(v) { this._mem.set("tickList", v); },
  getAlerts() { return this._mem.get("alerts") ?? null; },
  saveAlerts(v) { this._mem.set("alerts", v); },
  getObservations() { return this._mem.get("observations") ?? null; },
  saveObservations(v) { this._mem.set("observations", v); },
  getRawDataset() { return this._mem.get("rawDataset") ?? null; },
  saveRawDataset(v) { this._mem.set("rawDataset", v); },
  getChatMessages() { return this._mem.get("chatMessages") ?? null; },
  saveChatMessages(v) { this._mem.set("chatMessages", v); },
  getCalendar() { return this._mem.get("calendar") ?? null; },
  saveCalendar(v) { this._mem.set("calendar", v); },

  async syncSettingsToServer() {},
  async loadSettingsFromServer() { return false; },
};
