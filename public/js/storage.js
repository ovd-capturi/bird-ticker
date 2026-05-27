// Minimal localStorage façade. Server (Postgres) is source of truth for
// observations, ticklists, alerts, AI results. Only device-scoped state
// (which Netfugl user is signed in, which list is selected, whether push
// is enabled on this device) lives here.
const Storage = {
  _prefix: "bird-ticker-",

  get(key) {
    if (key === "pushEnabled") {
      return localStorage.getItem(this._prefix + "pushEnabled") === "true";
    }
    return null;
  },

  set(key, value) {
    if (key === "pushEnabled") {
      localStorage.setItem(this._prefix + "pushEnabled", value ? "true" : "false");
    }
  },

  remove(key) {
    if (key === "settings") {
      localStorage.removeItem(this._prefix + "userId");
      localStorage.removeItem(this._prefix + "listType");
      return;
    }
    localStorage.removeItem(this._prefix + key);
  },

  getSettings() {
    return {
      userId: localStorage.getItem(this._prefix + "userId") || "",
      listType: localStorage.getItem(this._prefix + "listType") || "1",
    };
  },

  saveSettings(settings) {
    if (settings.userId !== undefined) {
      localStorage.setItem(this._prefix + "userId", settings.userId || "");
    }
    if (settings.listType !== undefined) {
      localStorage.setItem(this._prefix + "listType", settings.listType || "1");
    }
  },

  getTickList() { return null; },
  saveTickList() {},
  getAlerts() { return null; },
  saveAlerts() {},
  getPredictions() { return null; },
  savePredictions() {},
  getCalendar() { return null; },
  saveCalendar() {},

  async syncSettingsToServer() {},
  async loadSettingsFromServer() { return false; },
};
