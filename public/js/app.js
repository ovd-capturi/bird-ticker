// ─── Bird Ticker App ───────────────────────────────────────────
const _formatLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};
const todayDate = () => _formatLocal(new Date());
const addDays = (dateStr, n) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return _formatLocal(dt);
};
const formatDateLabel = (dateStr) => {
  const today = todayDate();
  const yesterday = addDays(today, -1);
  if (dateStr === today) return "I dag";
  if (dateStr === yesterday) return "I går";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const days = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
  return `${days[dt.getDay()]} ${d}/${m}`;
};

const App = {
  refreshInterval: null,
  currentView: "alerts",
  sortMode: "distance",
  currentDate: todayDate(),

  async init() {
    this.bindEvents();
    this.registerSW();

    const settings = Storage.getSettings();
    if (settings.userId) {
      this.showMainView();
      this.updatePushButton();
      this.renderDateStrip();
      await this.getUserLocation();
      await this.loadData();
      this.startAutoRefresh();
      this.resubscribePushIfNeeded();
    } else {
      this.showSettings();
    }
  },

  registerSW() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(console.error);
    }
  },

  getUserLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
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

  bindEvents() {
    document.getElementById("btn-settings").addEventListener("click", () => {
      if (this.currentView === "settings") {
        const settings = Storage.getSettings();
        if (settings.userId) this.showMainView();
      } else {
        this.showSettings();
      }
    });

    document.getElementById("btn-refresh").addEventListener("click", async () => {
      await this.getUserLocation();
      this.loadData(true);
    });

    document.getElementById("btn-save-settings").addEventListener("click", () => {
      this.saveSettings();
    });

    document.getElementById("btn-toggle-push").addEventListener("click", () => {
      this.togglePush();
    });

    document.getElementById("btn-clear").addEventListener("click", () => {
      if (confirm("Ryd alle gemte data?")) {
        Storage.remove("ticklist");
        Storage.remove("observations");
        Storage.remove("alerts");
        Storage.remove("settings");
        Storage.remove("artIdMap");
        Storage.remove("userLocation");
        Storage.remove("pushEnabled");
        this.showSettings();
        this.showToast("Data ryddet");
      }
    });

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const view = tab.dataset.view;
        this.switchTab(view);
      });
    });

    document.querySelectorAll(".sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.sortMode = btn.dataset.sort;
        document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b === btn));
        this.renderAlerts();
      });
    });

    document.getElementById("search-input").addEventListener("input", (e) => {
      this.filterBirdList(e.target.value);
    });

    document.getElementById("date-prev").addEventListener("click", () => {
      this.changeDate(-1);
    });
    document.getElementById("date-next").addEventListener("click", () => {
      this.changeDate(1);
    });

    this.bindSwipe(document.getElementById("view-alerts"));
  },

  bindSwipe(el) {
    let startX = 0, startY = 0, tracking = false;
    el.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      this.changeDate(dx > 0 ? -1 : 1);
    }, { passive: true });
  },

  changeDate(delta) {
    const next = addDays(this.currentDate, delta);
    if (next > todayDate()) return; // no future
    this.currentDate = next;
    this.renderDateStrip();
    this.loadData();
  },

  renderDateStrip() {
    document.getElementById("date-label").textContent = formatDateLabel(this.currentDate);
    document.getElementById("date-next").disabled = this.currentDate === todayDate();
  },

  async loadAIPredictions(forceRefresh = false) {
    const banner = document.getElementById("ai-banner");
    const emptyState = document.getElementById("ai-empty-state");
    const settings = Storage.getSettings();
    if (!settings.userId || this.userLat == null || this.userLng == null) {
      banner.style.display = "none";
      if (emptyState) emptyState.style.display = "none";
      return;
    }

    const cached = Storage.getPredictions();
    const ageMs = cached?._savedAt ? Date.now() - cached._savedAt : Infinity;
    const fresh = ageMs < 60 * 60 * 1000;

    if (cached) {
      this.renderPredictions(cached);
    } else if (emptyState) {
      emptyState.style.display = "block";
    }
    if (fresh && !forceRefresh) return;

    try {
      const data = await Scraper.fetchPredictions(
        settings.userId,
        settings.listType,
        this.userLat,
        this.userLng
      );
      data._savedAt = Date.now();
      Storage.savePredictions(data);
      this.renderPredictions(data);
    } catch (err) {
      console.warn("AI predictions failed:", err.message);
      if (!cached) {
        banner.style.display = "none";
        if (emptyState) {
          emptyState.innerHTML = `<div class="empty-state"><div class="emoji">⚠️</div><p>Kunne ikke hente forudsigelser</p></div>`;
          emptyState.style.display = "block";
        }
      }
    }
  },

  renderPredictions(data) {
    const banner = document.getElementById("ai-banner");
    const meta = document.getElementById("ai-banner-meta");
    const body = document.getElementById("ai-banner-body");
    const emptyState = document.getElementById("ai-empty-state");

    if (!data || (!data.predictions?.length && !data.note)) {
      banner.style.display = "none";
      return;
    }
    banner.style.display = "block";
    if (emptyState) emptyState.style.display = "none";

    const ageMin = Math.round((Date.now() - new Date(data.generatedAt).getTime()) / 60000);
    meta.textContent = ageMin <= 1 ? "Lige nu" : `${ageMin} min siden`;

    if (!data.predictions.length && data.note) {
      body.innerHTML = `<div class="ai-empty">${esc(data.note)}</div>`;
      return;
    }

    body.innerHTML = data.predictions
      .map((p) => {
        const conf =
          p.confidence === "høj" ? "high" : p.confidence === "mellem" ? "med" : "low";
        const dates = (p.suggestedDates || []).map((d) => esc(d)).join(", ");
        const speciesClean = (p.species || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
        const latinClean = (p.latin || "").trim();
        const speciesLower = speciesClean.toLowerCase();
        const latinLower = latinClean.toLowerCase();
        const showLatin = latinClean && latinLower !== speciesLower;
        return `
          <div class="ai-card ai-card--${conf}">
            <div class="ai-card-head">
              <div class="ai-card-species">${esc(speciesClean)}${showLatin ? ` <span class="ai-card-latin">${esc(latinClean)}</span>` : ""}</div>
              <div class="ai-card-conf">${esc(p.confidence)}</div>
            </div>
            <div class="ai-card-loc">📍 ${esc(p.location)}</div>
            ${dates ? `<div class="ai-card-dates">📅 ${dates}</div>` : ""}
            <div class="ai-card-reason">${esc(p.reasoning)}</div>
          </div>`;
      })
      .join("");
  },

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
    document.getElementById("view-ai").style.display = view === "ai" ? "block" : "none";
    document.getElementById("search-bar").style.display = view === "list" ? "block" : "none";
    document.getElementById("sort-bar").style.display = view === "alerts" ? "flex" : "none";

    if (view === "list") this.renderBirdList();
    if (view === "alerts") this.renderAlerts();
    if (view === "ai") this.loadAIPredictions();
  },

  async saveSettings() {
    const userId = document.getElementById("input-user-id").value.trim();
    const listType = document.getElementById("input-list-type").value;

    if (!userId) {
      this.showToast("Indtast dit Netfugl bruger-ID");
      return;
    }

    Storage.saveSettings({ userId, listType });
    this.showMainView();
    this.updatePushButton();
    this.showToast("Indstillinger gemt — henter data...");
    await this.getUserLocation();
    await this.loadData(true);
    this.startAutoRefresh();
    this.resubscribePushIfNeeded();
  },

  async loadData(forceRefresh = false) {
    const settings = Storage.getSettings();
    if (!settings.userId) return;

    this.setLoading(true);
    const date = this.currentDate;
    const isToday = date === todayDate();
    // Past days are immutable on the source — reuse cached entry without re-fetch.
    const useCacheOnly = !isToday && !forceRefresh;

    try {
      let tickList = forceRefresh ? null : Storage.getTickList();
      if (!tickList) {
        tickList = await Scraper.fetchTickList(settings.userId, settings.listType);
        Storage.saveTickList(tickList);
      }

      let observations;
      const cachedObs = Storage.getObservations(date);
      if (useCacheOnly && cachedObs) {
        observations = cachedObs;
        Storage.touchObservations(date);
      } else {
        try {
          observations = await Scraper.fetchObservations("all", isToday ? null : date);
          observations = await Scraper.resolveCoordinates(observations);
          Storage.saveObservations(observations, date);
        } catch (err) {
          console.warn("Failed to fetch observations, using cached:", err);
          observations = cachedObs;
        }
      }

      if (observations) {
        const newMap = Scraper.buildArtIdMap(observations);
        const existingMap = Storage.get("artIdMap") || {};
        Storage.set("artIdMap", { ...existingMap, ...newMap });
      }

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

      const alerts = Scraper.matchAlerts(tickList, observations, this.userLat, this.userLng);
      Storage.saveAlerts(alerts);

      this.renderStats(tickList, alerts, observations);
      this.renderAlerts();
      this.updateRefreshTime();

      if (forceRefresh) {
        this.showToast(`Opdateret — ${alerts.length} arter spottet`);
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

  pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  },

  async togglePush() {
    if (!this.pushSupported()) {
      this.showToast("Push-notifikationer understøttes ikke på denne enhed");
      return;
    }

    const pushEnabled = Storage.get("pushEnabled");
    if (pushEnabled) {
      await this.unsubscribePush();
    } else {
      await this.subscribePush();
    }
    this.updatePushButton();
  },

  async subscribePush() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        this.showToast("Notifikationstilladelse afvist");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const vapidKey = await Scraper.getVapidKey();

      const padding = "=".repeat((4 - (vapidKey.length % 4)) % 4);
      const base64 = (vapidKey + padding).replace(/-/g, "+").replace(/_/g, "/");
      const raw = atob(base64);
      const key = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });

      const settings = Storage.getSettings();
      await Scraper.subscribePush(
        subscription.toJSON(),
        settings.userId,
        settings.listType
      );

      Storage.set("pushEnabled", true);
      this.showToast("🔔 Push-notifikationer aktiveret");
    } catch (err) {
      console.error("Push subscribe error:", err);
      this.showToast("Kunne ikke aktivere notifikationer: " + err.message);
    }
  },

  async unsubscribePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        await Scraper.unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      Storage.set("pushEnabled", false);
      this.showToast("🔕 Push-notifikationer deaktiveret");
    } catch (err) {
      console.error("Push unsubscribe error:", err);
      Storage.set("pushEnabled", false);
    }
  },

  updatePushButton() {
    const btn = document.getElementById("btn-toggle-push");
    const enabled = Storage.get("pushEnabled");
    btn.textContent = enabled ? "🔔 Notifikationer til" : "🔕 Notifikationer fra";
    btn.classList.toggle("push-on", !!enabled);
  },

  async resubscribePushIfNeeded() {
    if (!this.pushSupported() || !Storage.get("pushEnabled")) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        const settings = Storage.getSettings();
        await Scraper.subscribePush(
          subscription.toJSON(),
          settings.userId,
          settings.listType
        );
      }
    } catch (err) {
      console.warn("Re-subscribe failed:", err);
    }
  },

  renderStats(tickList, alerts, observations) {
    if (!tickList) return;

    const missingAlm = new Set();
    const missingSU = new Set();
    for (const bird of tickList.birds) {
      if (bird.ticked || bird.removed || !bird.latin) continue;
      (bird.isSU ? missingSU : missingAlm).add(bird.latin);
    }

    const matched = new Set();
    if (observations && observations.observations) {
      for (const obs of observations.observations) {
        if (obs.latin && (missingAlm.has(obs.latin) || missingSU.has(obs.latin))) {
          matched.add(obs.latin);
        }
      }
    }

    document.getElementById("stat-ticked").textContent = tickList.ticked;
    document.getElementById("stat-total").textContent = tickList.total;
    document.getElementById("stat-missing-alm").textContent = missingAlm.size;
    document.getElementById("stat-missing-su").textContent = missingSU.size;
    document.getElementById("stat-alerts").textContent = matched.size;

    const alertEl = document.getElementById("stat-alerts");
    alertEl.className = "stat-value" + (matched.size > 0 ? " alert" : "");
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

    const birds = [];
    const seen = new Set();
    for (const bird of tickList.birds) {
      if (!seen.has(bird.latin || bird.name)) {
        seen.add(bird.latin || bird.name);
        birds.push(bird);
      }
    }

    container.innerHTML = birds
      .map((b) => {
        const cls = b.removed ? "bird-list-item removed" : "bird-list-item";
        const tick = b.ticked
          ? '<div class="tick yes">✓</div>'
          : '<div class="tick no">✗</div>';
        const artId = artIdMap[Scraper.normalizeName(b.latin)]
          || speciesMap[b.name.toLowerCase().trim()];
        const url = Scraper.getDofbasenUrl(artId);
        const tag = url ? "a" : "div";
        const linkAttrs = url ? `href="${esc(url)}" target="_blank" rel="noopener"` : "";
        const suMark = b.isSU ? '<span class="su-marker">*</span> ' : "";
        return `
          <${tag} class="${cls}" ${linkAttrs}>
            ${tick}
            <div class="bird-info">
              <div class="bird-name">${suMark}${esc(b.name)}</div>
              <div class="bird-latin">${esc(b.latin)}</div>
            </div>
            ${url ? '<div class="link-arrow">›</div>' : ""}
          </${tag}>`;
      })
      .join("");
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
      this._lastAlertNodes = null;
      return;
    }

    const speciesGroups = new Map();
    for (const alert of alerts) {
      const speciesKey = alert.species + "|" + alert.latin;
      if (!speciesGroups.has(speciesKey)) {
        speciesGroups.set(speciesKey, []);
      }
      speciesGroups.get(speciesKey).push(alert);
    }

    const tree = [];
    for (const [key, obsArray] of speciesGroups) {
      obsArray.sort((a, b) => {
        const ta = Scraper.parseTimeMinutes(a.time);
        const tb = Scraper.parseTimeMinutes(b.time);
        if (ta == null && tb == null) return 0;
        if (ta == null) return 1;
        if (tb == null) return -1;
        return tb - ta;
      });

      const locations = [...new Set(obsArray.map(o => o.location))];
      const times = obsArray.map(o => o.time).filter(Boolean);
      const total = obsArray.reduce((sum, o) => sum + (o.count || 0), 0);

      const distances = obsArray.map(o => o.distance).filter(d => d != null);
      const minDistance = distances.length ? Math.min(...distances) : null;
      const latestTime = obsArray[0].time;

      tree.push({
        type: "group",
        species: obsArray[0].species,
        latin: obsArray[0].latin,
        rare: obsArray[0].rare,
        scarce: obsArray[0].scarce,
        seasonal: obsArray[0].seasonal,
        artId: obsArray[0].artId,
        locations: locations.join(", "),
        count: total,
        allTimes: times.join(", "),
        distance: minDistance,
        time: latestTime
      });

      for (const obs of obsArray) {
        tree.push({
          ...obs,
          type: "observation",
          isLast: obs === obsArray[obsArray.length - 1]
        });
      }
    }

    const groups = tree.filter(item => item.type === "group");
    const sortedGroups = Scraper.sortGroupedAlerts(groups, this.sortMode);

    const finalTree = [];
    for (const group of sortedGroups) {
      finalTree.push(group);
      for (const item of tree) {
        if (item.type === "observation" &&
            item.species === group.species &&
            item.latin === group.latin) {
          finalTree.push(item);
        }
      }
    }

    const built = finalTree.map((item) => this.buildAlertItem(item));
    this.reconcileAlerts(container, built);
  },

  buildAlertItem(item) {
    const isGroup = item.type === "group";
    if (isGroup) {
      let modifier = "normal";
      let badge = "";
      if (item.rare) {
        modifier = "rare";
        badge = '<span class="badge badge-rare">Sjælden</span>';
      } else if (item.scarce) {
        modifier = "scarce";
        badge = '<span class="badge badge-scarce">Fåtallig</span>';
      } else if (item.seasonal) {
        modifier = "seasonal";
        badge = '<span class="badge badge-seasonal">Periodisk</span>';
      }

      const dofUrl = Scraper.getDofbasenUrl(item.artId);
      const locCount = item.locations ? [...new Set(item.locations.split(", "))].size : 0;

      const html = `<div class="group-header">
            <div class="group-title">
              <div>
                <div class="species-name">
                  ${dofUrl ? `<a href="${esc(dofUrl)}" target="_blank" rel="noopener" class="species-link">${esc(item.species)}</a>` : esc(item.species)}${badge}
                </div>
                <div class="latin-name">${esc(item.latin)}</div>
              </div>
              <div class="group-count">🔢 ${item.count || 0}${locCount ? ` · ${locCount} lok.` : ""}</div>
            </div>
          </div>`;

      return {
        key: `g:${item.species}|${item.latin}`,
        sig: `${item.count || 0}|${locCount}|${modifier}`,
        outerClass: `bird-tree-item bird-tree-item--group bird-card ${modifier}`,
        html,
      };
    }

    const mapUrl = Scraper.getMapUrl(item.lat, item.lng, `${item.species} - ${item.location}`);
    const dofObsUrl = Scraper.getDofbasenObsUrl(item.loknr, this.currentDate);
    let content = '<div class="obs-box">';
    content += '<div class="obs-header">';
    content += '<div class="obs-location">';
    content += '<span class="obs-icon">📍</span>';
    content += dofObsUrl
      ? `<a href="${esc(dofObsUrl)}" target="_blank" rel="noopener" class="obs-link">${esc(item.location)} ↗</a>`
      : `${esc(item.location)}`;
    if (mapUrl) {
      content += ` <a href="${esc(mapUrl)}" target="_blank" rel="noopener" class="obs-map-link" title="Vis på kort">🗺️</a>`;
    }
    content += '</div>';
    content += `<div class="obs-count">🔢 ${item.count || 0} stk</div>`;
    content += '</div>';
    content += '<div class="obs-meta">';
    content += `<div class="obs-time">🕐 ${esc(item.time) || "Ukendt tid"}</div>`;
    content += item.distance != null ? `<div class="obs-distance">📍 ${item.distance} km</div>` : "";
    content += item.observer ? `<div class="obs-observer">👤 ${esc(item.observer)}</div>` : "";
    content += item.behavior ? `<div class="obs-behavior">📋 ${esc(item.behavior)}</div>` : "";
    content += '</div>';
    content += '</div>';

    return {
      key: `o:${item.species}|${item.latin}|${item.location}|${item.loknr || ""}|${item.time || ""}|${item.observer || ""}`,
      sig: `${item.count || 0}|${item.time || ""}|${item.observer || ""}|${item.behavior || ""}|${item.lat ?? ""}|${item.lng ?? ""}|${item.distance ?? ""}`,
      outerClass: "bird-tree-item bird-tree-item--obs",
      html: content,
    };
  },

  reconcileAlerts(container, items) {
    const prevMap = this._lastAlertNodes instanceof Map ? this._lastAlertNodes : new Map();
    const nextMap = new Map();
    const fragment = document.createDocumentFragment();

    for (const item of items) {
      const { key, sig, html, outerClass } = item;
      let entry = prevMap.get(key);
      if (entry) {
        if (entry.sig !== sig) {
          entry.node.className = outerClass;
          entry.node.innerHTML = html;
          entry.sig = sig;
        } else if (entry.node.className !== outerClass) {
          entry.node.className = outerClass;
        }
        prevMap.delete(key);
      } else {
        const node = document.createElement("div");
        node.className = outerClass + " enter";
        node.innerHTML = html;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => node.classList.remove("enter"))
        );
        entry = { node, sig };
      }
      fragment.appendChild(entry.node);
      nextMap.set(key, entry);
    }

    container.replaceChildren(fragment);
    this._lastAlertNodes = nextMap;
  },

  filterBirdList(query) {
    this.renderBirdList(query);
  },

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

function esc(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

document.addEventListener("DOMContentLoaded", () => App.init());
