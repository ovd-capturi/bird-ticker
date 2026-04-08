// ─── Bird Ticker App ───────────────────────────────────────────
const App = {
  refreshInterval: null,
  currentView: "alerts", // alerts | list | settings
  sortMode: "distance", // distance | rarity | name
  userLat: null,
  userLng: null,

  async init() {
    this.bindEvents();
    this.registerSW();

    const settings = Storage.getSettings();
    if (settings.userId) {
      this.showMainView();
      await this.getUserLocation();
      await this.loadData();
      this.startAutoRefresh();
    } else {
      this.showSettings();
    }
  },

  registerSW() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(console.error);
    }
  },

  // ─── Geolocation ────────────────────────────────────────────
  getUserLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        console.warn("Geolocation not supported");
        resolve();
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.userLat = pos.coords.latitude;
          this.userLng = pos.coords.longitude;
          Storage.set("userLocation", { lat: this.userLat, lng: this.userLng, time: Date.now() });
          resolve();
        },
        (err) => {
          console.warn("Geolocation denied:", err.message);
          // Try cached location
          const cached = Storage.get("userLocation");
          if (cached) {
            this.userLat = cached.lat;
            this.userLng = cached.lng;
          }
          resolve();
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
      );
    });
  },

  // ─── Event Binding ───────────────────────────────────────────
  bindEvents() {
    // Settings button
    document.getElementById("btn-settings").addEventListener("click", () => {
      if (this.currentView === "settings") {
        const settings = Storage.getSettings();
        if (settings.userId) this.showMainView();
      } else {
        this.showSettings();
      }
    });

    // Refresh button
    document.getElementById("btn-refresh").addEventListener("click", async () => {
      await this.getUserLocation();
      this.loadData(true);
    });

    // Save settings
    document.getElementById("btn-save-settings").addEventListener("click", () => {
      this.saveSettings();
    });

    // Clear data
    document.getElementById("btn-clear").addEventListener("click", () => {
      if (confirm("Ryd alle gemte data?")) {
        Storage.remove("ticklist");
        Storage.remove("observations");
        Storage.remove("alerts");
        Storage.remove("settings");
        Storage.remove("artIdMap");
        Storage.remove("userLocation");
        this.showSettings();
        this.showToast("Data ryddet");
      }
    });

    // Tabs
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const view = tab.dataset.view;
        this.switchTab(view);
      });
    });

    // Sort buttons
    document.querySelectorAll(".sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.sortMode = btn.dataset.sort;
        document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b === btn));
        this.renderAlerts();
      });
    });

    // Search
    document.getElementById("search-input").addEventListener("input", (e) => {
      this.filterBirdList(e.target.value);
    });
  },

  // ─── Navigation ──────────────────────────────────────────────
  showSettings() {
    this.currentView = "settings";
    document.getElementById("main-content").style.display = "none";
    document.getElementById("settings-panel").classList.add("visible");
    document.getElementById("btn-refresh").style.display = "none";

    const settings = Storage.getSettings();
    document.getElementById("input-user-id").value = settings.userId || "";
    document.getElementById("input-list-type").value = settings.listType || "1";
  },

  showMainView() {
    this.currentView = "alerts";
    document.getElementById("settings-panel").classList.remove("visible");
    document.getElementById("main-content").style.display = "block";
    document.getElementById("btn-refresh").style.display = "";
    this.switchTab("alerts");
  },

  switchTab(view) {
    this.currentView = view;
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.view === view);
    });

    document.getElementById("view-alerts").style.display = view === "alerts" ? "block" : "none";
    document.getElementById("view-list").style.display = view === "list" ? "block" : "none";
    document.getElementById("search-bar").style.display = view === "list" ? "block" : "none";
    document.getElementById("sort-bar").style.display = view === "alerts" ? "flex" : "none";

    if (view === "list") this.renderBirdList();
    if (view === "alerts") this.renderAlerts();
  },

  // ─── Settings ────────────────────────────────────────────────
  async saveSettings() {
    const userId = document.getElementById("input-user-id").value.trim();
    const listType = document.getElementById("input-list-type").value;

    if (!userId) {
      this.showToast("Indtast dit Netfugl bruger-ID");
      return;
    }

    Storage.saveSettings({ userId, listType });
    this.showMainView();
    this.showToast("Indstillinger gemt — henter data...");
    await this.getUserLocation();
    await this.loadData(true);
    this.startAutoRefresh();
  },

  // ─── Data Loading ────────────────────────────────────────────
  async loadData(forceRefresh = false) {
    const settings = Storage.getSettings();
    if (!settings.userId) return;

    this.setLoading(true);

    try {
      // Load tick list (use cache unless forced)
      let tickList = forceRefresh ? null : Storage.getTickList();
      if (!tickList) {
        tickList = await Scraper.fetchTickList(settings.userId, settings.listType);
        Storage.saveTickList(tickList);
      }

      // Always load fresh observations
      let observations;
      try {
        observations = await Scraper.fetchObservations();

        // Resolve coordinates for observations missing them
        observations = await Scraper.resolveCoordinates(observations);

        Storage.saveObservations(observations);
      } catch (err) {
        console.warn("Failed to fetch observations, using cached:", err);
        observations = Storage.getObservations();
      }

      // Build artId map from observations (latin name -> artId)
      if (observations) {
        const newMap = Scraper.buildArtIdMap(observations);
        const existingMap = Storage.get("artIdMap") || {};
        Storage.set("artIdMap", { ...existingMap, ...newMap });
      }

      // Fetch full species name map (Danish name -> artId) for bird list links
      let speciesMap = Storage.get("speciesMap");
      if (!speciesMap || forceRefresh) {
        try {
          speciesMap = await Scraper.fetchSpeciesMap();
          Storage.set("speciesMap", speciesMap);
        } catch (e) {
          console.warn("Failed to fetch species map:", e);
          speciesMap = speciesMap || {};
        }
      }

      // Match alerts
      const alerts = Scraper.matchAlerts(tickList, observations, this.userLat, this.userLng);
      Storage.saveAlerts(alerts);

      // Update UI
      this.renderStats(tickList, alerts);
      this.renderAlerts();
      this.updateRefreshTime();

      if (forceRefresh) {
        this.showToast(`Opdateret — ${alerts.length} manglende arter spottet`);
      }
    } catch (err) {
      console.error("Load error:", err);
      this.showError(err.message);
    } finally {
      this.setLoading(false);
    }
  },

  startAutoRefresh() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(() => this.loadData(), 5 * 60 * 1000);
  },

  // ─── Rendering ───────────────────────────────────────────────
  renderStats(tickList, alerts) {
    if (!tickList) return;
    const missing = tickList.birds.filter((b) => !b.ticked && !b.removed).length;

    document.getElementById("stat-ticked").textContent = tickList.ticked;
    document.getElementById("stat-total").textContent = tickList.total;
    document.getElementById("stat-missing").textContent = missing;
    document.getElementById("stat-alerts").textContent = alerts ? alerts.length : 0;

    const alertEl = document.getElementById("stat-alerts");
    alertEl.className = "stat-value" + (alerts && alerts.length > 0 ? " alert" : "");
  },

  renderAlerts() {
    const container = document.getElementById("alerts-container");
    let alerts = Storage.getAlerts();

    if (!alerts || alerts.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="emoji">🔭</div>
          <p>Ingen manglende arter spottet i dag</p>
          <p style="margin-top: 8px; font-size: 13px;">Tryk 🔄 for at opdatere</p>
        </div>`;
      return;
    }

    // Sort
    alerts = Scraper.sortAlerts(alerts, this.sortMode);

    container.innerHTML = alerts
      .map((a) => {
        let cardClass = "bird-card";
        let badge = "";
        if (a.rare) {
          cardClass += " rare";
          badge = '<span class="badge badge-rare">Sjælden</span>';
        } else if (a.scarce) {
          cardClass += " scarce";
          badge = '<span class="badge badge-scarce">Fåtallig</span>';
        } else if (a.seasonal) {
          cardClass += " seasonal";
          badge = '<span class="badge badge-seasonal">Periodisk</span>';
        } else {
          cardClass += " normal";
        }

        const dofUrl = Scraper.getDofbasenUrl(a.artId);
        const mapUrl = Scraper.getMapUrl(a.lat, a.lng, `${a.species} - ${a.location}`);
        const distText = a.distance != null ? `${a.distance} km` : "";

        return `
          <div class="${cardClass}">
            <div class="card-header-row">
              <div>
                <div class="species-name">
                  ${dofUrl ? `<a href="${esc(dofUrl)}" target="_blank" rel="noopener" class="species-link">${esc(a.species)}</a>` : esc(a.species)}${badge}
                </div>
                <div class="latin-name">${esc(a.latin)}</div>
              </div>
              ${distText ? `<div class="distance-badge">${distText}</div>` : ""}
            </div>
            <div class="details">
              <span class="detail-location">
                ${mapUrl
                  ? `<a href="${esc(mapUrl)}" target="_blank" rel="noopener" class="map-link">📍 ${esc(a.location)} ↗</a>`
                  : `📍 ${esc(a.location)}`}
              </span>
              ${a.count ? `<span>🔢 ${a.count} stk</span>` : ""}
              ${a.time ? `<span>🕐 ${esc(a.time)}</span>` : ""}
              ${a.observer ? `<span>👤 ${esc(a.observer)}</span>` : ""}
              ${a.behavior ? `<span>📋 ${esc(a.behavior)}</span>` : ""}
            </div>
          </div>`;
      })
      .join("");
  },

  renderBirdList(filter = "") {
    const container = document.getElementById("list-container");
    const tickList = Storage.getTickList();

    if (!tickList) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="emoji">📋</div>
          <p>Ingen krydsliste hentet endnu</p>
        </div>`;
      return;
    }

    const filterLower = filter.toLowerCase();
    const artIdMap = Storage.get("artIdMap") || {};
    const speciesMap = Storage.get("speciesMap") || {};
    const birds = tickList.birds.filter((b) => {
      if (!filter) return true;
      return (
        b.name.toLowerCase().includes(filterLower) ||
        b.latin.toLowerCase().includes(filterLower)
      );
    });

    container.innerHTML = birds
      .map((b) => {
        const cls = b.removed ? "bird-list-item removed" : "bird-list-item";
        const tick = b.ticked
          ? '<div class="tick yes">✓</div>'
          : '<div class="tick no">✗</div>';
        // Try artId from observations (by latin), then from species map (by Danish name)
        const artId = artIdMap[Scraper.normalizeName(b.latin)]
          || speciesMap[b.name.toLowerCase().trim()];
        const url = Scraper.getDofbasenUrl(artId);
        const tag = url ? "a" : "div";
        const linkAttrs = url ? `href="${esc(url)}" target="_blank" rel="noopener"` : "";
        return `
          <${tag} class="${cls}" ${linkAttrs}>
            ${tick}
            <div class="bird-info">
              <div class="bird-name">${esc(b.name)}</div>
              <div class="bird-latin">${esc(b.latin)}</div>
            </div>
            ${url ? '<div class="link-arrow">›</div>' : ""}
          </${tag}>`;
      })
      .join("");
  },

  filterBirdList(query) {
    this.renderBirdList(query);
  },

  // ─── UI Helpers ──────────────────────────────────────────────
  setLoading(loading) {
    const el = document.getElementById("loading-indicator");
    el.style.display = loading ? "block" : "none";
  },

  showError(message) {
    const container = document.getElementById("alerts-container");
    container.innerHTML = `
      <div class="error-state">
        <div class="emoji">⚠️</div>
        <p>Fejl: ${esc(message)}</p>
        <p style="margin-top: 8px; font-size: 13px;">Tjek din forbindelse og prøv igen</p>
      </div>`;
  },

  updateRefreshTime() {
    const el = document.getElementById("refresh-time");
    const now = new Date();
    const locStr = this.userLat != null
      ? ` · 📍 Position aktiv`
      : ` · 📍 Ingen position`;
    el.textContent =
      `Sidst opdateret: ${now.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })}${locStr}`;
  },

  showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 3000);
  },
};

// ─── Helper ────────────────────────────────────────────────────
function esc(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── Boot ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => App.init());
