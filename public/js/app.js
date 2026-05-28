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
  obsFilter: "missing",
  calendarView: "ai",
  rawSort: { key: "score", dir: "desc" },
  chatBusy: false,
  chatLoaded: false,
  currentDate: todayDate(),
  _expandedGroups: new Set(),
  _expandedRawRows: new Set(),
  _map: null,
  _markers: [],
  _userMarker: null,

  async init() {
    this.calendarView = Storage.getCalendarViewMode();
    Storage.getDeviceId();
    this.bindEvents();
    this.registerSW();

    let settings = Storage.getSettings();
    if (settings.userId) {
      const updated = await Storage.loadSettingsFromServer(settings.userId);
      if (updated) settings = Storage.getSettings();
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
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => {
        reg.update().catch(() => {});
        reg.addEventListener("updatefound", () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", () => {
            if (sw.state === "activated" && navigator.serviceWorker.controller) {
              location.reload();
            }
          });
        });
      })
      .catch(console.error);
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
          Storage.syncSettingsToServer();
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

    document.getElementById("btn-calendar-refresh").addEventListener("click", () => {
      this.loadCalendar(true);
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

    document.querySelectorAll(".filter-btn[data-obs-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.obsFilter = btn.dataset.obsFilter;
        document
          .querySelectorAll(".filter-btn[data-obs-filter]")
          .forEach((b) => b.classList.toggle("active", b === btn));
        this.renderAlerts();
      });
    });

    document.querySelectorAll(".filter-btn[data-calendar-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.calendarView = btn.dataset.calendarView;
        Storage.setCalendarViewMode(this.calendarView);
        document
          .querySelectorAll(".filter-btn[data-calendar-view]")
          .forEach((b) => b.classList.toggle("active", b === btn));
        this.renderCalendarView();
      });
    });

    const chatForm = document.getElementById("chat-form");
    const chatInput = document.getElementById("chat-input");
    chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.sendChat();
    });
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendChat();
      }
    });
    chatInput.addEventListener("input", () => this.autosizeChatInput());
    document.getElementById("btn-chat-clear").addEventListener("click", () => {
      this.clearChat();
    });
    document.querySelectorAll(".chat-suggestion").forEach((btn) => {
      btn.addEventListener("click", () => {
        chatInput.value = btn.dataset.prompt || btn.textContent;
        this.autosizeChatInput();
        chatInput.focus();
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

    document.getElementById("alerts-container").addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const group = e.target.closest(".bird-tree-item--group");
      if (!group) return;
      const key = group.dataset.key;
      if (!key) return;
      if (this._expandedGroups.has(key)) this._expandedGroups.delete(key);
      else this._expandedGroups.add(key);
      this.renderAlerts();
    });
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

  renderCalendarView() {
    document.querySelectorAll(".filter-btn[data-calendar-view]").forEach((b) => {
      b.classList.toggle("active", b.dataset.calendarView === this.calendarView);
    });
    const aiWrap = document.getElementById("calendar-ai-wrap");
    const raw = document.getElementById("calendar-raw");
    if (this.calendarView === "raw") {
      if (aiWrap) aiWrap.style.display = "none";
      if (raw) raw.style.display = "block";
      this.loadRawDataset();
    } else {
      if (aiWrap) aiWrap.style.display = "block";
      if (raw) raw.style.display = "none";
      this.loadCalendar();
    }
  },

  async loadRawDataset(forceRefresh = false) {
    const raw = document.getElementById("calendar-raw");
    const settings = Storage.getSettings();
    if (!settings.userId || this.userLat == null || this.userLng == null) {
      raw.innerHTML = `<div class="empty-state"><div class="emoji">📊</div><p>Mangler bruger-ID eller position</p></div>`;
      return;
    }

    const cached = Storage.getRawDataset();
    const ageMs = cached?._savedAt ? Date.now() - cached._savedAt : Infinity;
    const fresh = ageMs < 60 * 60 * 1000;

    if (cached) {
      this.renderRawDataset(cached);
    } else {
      raw.innerHTML = `<div class="empty-state"><div class="emoji">⏳</div><p>Henter rådata…</p></div>`;
    }
    if (fresh && !forceRefresh) return;

    try {
      const data = await Scraper.fetchPredictorDataset({
        userId: settings.userId,
        listType: settings.listType,
        lat: this.userLat,
        lng: this.userLng,
        mode: "day",
      });
      data._savedAt = Date.now();
      Storage.saveRawDataset(data);
      this.renderRawDataset(data);
    } catch (err) {
      console.warn("Raw dataset failed:", err.message);
      if (!cached) {
        raw.innerHTML = `<div class="empty-state"><div class="emoji">⚠️</div><p>Kunne ikke hente rådata: ${esc(err.message)}</p></div>`;
      }
    }
  },

  renderRawDataset(data) {
    const raw = document.getElementById("calendar-raw");
    if (!data?.candidates?.length) {
      raw.innerHTML = `<div class="empty-state"><div class="emoji">📊</div><p>Ingen kandidater i rådata</p></div>`;
      return;
    }

    const ageMin = Math.round((Date.now() - new Date(data.generatedAt).getTime()) / 60000);
    const ageLabel = ageMin <= 1 ? "Lige nu" : `${ageMin} min siden`;

    const sortKey = this.rawSort.key;
    const sortDir = this.rawSort.dir === "asc" ? 1 : -1;
    const rows = [...data.candidates];
    rows.sort((a, b) => {
      const va = rawSortValue(a, sortKey);
      const vb = rawSortValue(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return sortDir * va.localeCompare(vb, "da");
      return sortDir * (va - vb);
    });

    const arrow = (key) =>
      key === sortKey ? (sortDir > 0 ? " ▲" : " ▼") : "";

    const tableHead = `
      <thead>
        <tr>
          <th data-sort="name">Art${arrow("name")}</th>
          <th data-sort="location">Lokalitet${arrow("location")}</th>
          <th data-sort="score" class="num">Score${arrow("score")}</th>
          <th data-sort="band">Bånd${arrow("band")}</th>
          <th data-sort="evidence" class="num">Evidens${arrow("evidence")}</th>
          <th data-sort="lastObs">Sidste obs${arrow("lastObs")}</th>
        </tr>
      </thead>`;

    const body = rows.map((c, i) => {
      const key = `${c.latin}|${c.cluster?.loknr || ""}|${i}`;
      const expanded = this._expandedRawRows.has(key);
      const latinShown = c.latin && c.latin.toLowerCase() !== (c.name || "").toLowerCase();
      const lastObs = (c.evidence || []).reduce((acc, e) => (e.date > acc ? e.date : acc), "");
      const evCount = (c.evidence || []).length;
      const headRow = `
        <tr class="raw-row${expanded ? " raw-row--open" : ""}" data-raw-key="${esc(key)}">
          <td>
            <div class="raw-species">${esc(c.name || c.species || "—")}</div>
            ${latinShown ? `<div class="raw-latin">${esc(c.latin)}</div>` : ""}
          </td>
          <td>${esc(c.cluster?.name || "—")}</td>
          <td class="num">${(c.scoreNorm != null ? c.scoreNorm : c.score).toFixed(2)}</td>
          <td><span class="raw-band raw-band--${esc(c.band || "lav")}">${esc(c.band || "—")}</span></td>
          <td class="num">${evCount}</td>
          <td>${esc(lastObs || "—")}</td>
        </tr>`;
      const evidenceRows = !expanded ? "" : `
        <tr class="raw-detail"><td colspan="6">
          ${renderRawEvidence(c)}
        </td></tr>`;
      return headRow + evidenceRows;
    }).join("");

    raw.innerHTML = `
      <div class="raw-header">
        <div class="raw-title">📊 Rådata · ${rows.length} kandidater</div>
        <div class="raw-actions">
          <span class="raw-meta">${ageLabel}</span>
          <button class="btn-link" id="btn-raw-csv">⬇️ CSV</button>
          <button class="btn-link" id="btn-raw-refresh">🔄 Opdater</button>
        </div>
      </div>
      <div class="raw-dataset-wrap">
        <table class="raw-dataset">${tableHead}<tbody>${body}</tbody></table>
      </div>`;

    raw.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (this.rawSort.key === key) {
          this.rawSort.dir = this.rawSort.dir === "asc" ? "desc" : "asc";
        } else {
          this.rawSort.key = key;
          this.rawSort.dir = key === "name" || key === "location" || key === "band" ? "asc" : "desc";
        }
        this.renderRawDataset(data);
      });
    });

    raw.querySelectorAll(".raw-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        const k = tr.dataset.rawKey;
        if (!k) return;
        if (this._expandedRawRows.has(k)) this._expandedRawRows.delete(k);
        else this._expandedRawRows.add(k);
        this.renderRawDataset(data);
      });
    });

    document.getElementById("btn-raw-refresh")?.addEventListener("click", () => {
      this.loadRawDataset(true);
    });
    document.getElementById("btn-raw-csv")?.addEventListener("click", () => {
      downloadRawCsv(rows);
    });
  },

  expectedCalendarMonths() {
    // 3 months starting from current month
    const now = new Date();
    const out = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return out;
  },

  async loadCalendar(forceRefresh = false) {
    const settings = Storage.getSettings();
    const body = document.getElementById("calendar-body");
    const meta = document.getElementById("calendar-meta");
    if (!settings.userId) {
      body.innerHTML = `<div class="empty-state"><div class="emoji">👤</div><p>Bruger-ID mangler</p></div>`;
      meta.textContent = "";
      return;
    }

    const expected = this.expectedCalendarMonths();
    const cached = Storage.getCalendar();
    const cachedMonths = cached?.months?.map((m) => m.month) || [];
    const stale =
      !cached ||
      cachedMonths[0] !== expected[0] ||
      cachedMonths.length < expected.length;

    if (cached && !stale && !forceRefresh) {
      this.renderCalendar(cached);
      return;
    }

    // Show partial cache while regenerating
    if (cached) this.renderCalendar(cached);

    meta.textContent = "Genererer…";
    body.innerHTML = expected
      .map((m) => `<div class="calendar-month-loading" data-month="${m}">⏳ ${esc(formatMonthLabel(m))}…</div>`)
      .join("");

    const months = [];
    for (const month of expected) {
      try {
        const monthData = await Scraper.fetchCalendarMonth(
          settings.userId,
          settings.listType,
          month
        );
        months.push(monthData);
        const data = { generatedAt: new Date().toISOString(), months: [...months] };
        Storage.saveCalendar(data);
        this.renderCalendar(data, expected);
      } catch (err) {
        console.warn(`Calendar ${month} failed:`, err.message);
        months.push({ month, locations: [], error: err.message });
        this.renderCalendar({ generatedAt: new Date().toISOString(), months: [...months] }, expected);
      }
    }
  },

  renderCalendar(data, pendingMonths) {
    const body = document.getElementById("calendar-body");
    const meta = document.getElementById("calendar-meta");

    if (!data?.months?.length) {
      body.innerHTML = `<div class="empty-state"><div class="emoji">📅</div><p>Ingen data endnu</p></div>`;
      meta.textContent = "";
      return;
    }

    const ageMin = Math.round((Date.now() - new Date(data.generatedAt).getTime()) / 60000);
    meta.textContent = ageMin <= 1 ? "Lige nu" : ageMin < 60 ? `${ageMin} min siden` : `${Math.round(ageMin / 60)} t siden`;

    // Build set of currently ticked latin names for live overlay
    const tickList = Storage.getTickList();
    const tickedLatin = new Set();
    if (tickList?.birds) {
      for (const b of tickList.birds) {
        if (b.ticked && b.latin) tickedLatin.add(b.latin.toLowerCase());
      }
    }

    const monthsByKey = new Map(data.months.map((m) => [m.month, m]));
    const order = pendingMonths && pendingMonths.length ? pendingMonths : data.months.map((m) => m.month);

    body.innerHTML = order
      .map((monthKey) => {
        const m = monthsByKey.get(monthKey);
        if (!m) {
          return `<section class="calendar-month"><h3 class="calendar-month-title">${esc(formatMonthLabel(monthKey))}</h3><div class="calendar-month-loading">⏳ Genererer…</div></section>`;
        }
        return renderCalendarMonth(m, tickedLatin);
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
    document.getElementById("view-ai").classList.toggle("chat-open", view === "ai");
    document.body.classList.toggle("chat-active", view === "ai");
    document.getElementById("view-calendar").style.display = view === "calendar" ? "block" : "none";
    document.getElementById("search-bar").style.display = view === "list" ? "block" : "none";
    document.getElementById("sort-bar").style.display = view === "alerts" ? "flex" : "none";
    document.getElementById("obs-filter-bar").style.display = view === "alerts" ? "flex" : "none";

    if (view === "list") this.renderBirdList();
    if (view === "alerts") {
      this.initMap();
      this.renderAlerts();
      if (this._map) requestAnimationFrame(() => this._map.resize());
    }
    if (view === "ai") this.openChat();
    if (view === "calendar") this.renderCalendarView();
  },

  async saveSettings() {
    const userId = document.getElementById("input-user-id").value.trim();
    const listType = document.getElementById("input-list-type").value;

    if (!userId) {
      this.showToast("Indtast dit Netfugl bruger-ID");
      return;
    }

    Storage.saveSettings({ userId, listType });
    Storage.syncSettingsToServer();
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
      try {
        observations = await Scraper.fetchObservations("all", isToday ? null : date);
        observations = await Scraper.resolveCoordinates(observations);
      } catch (err) {
        console.warn("Failed to fetch observations:", err);
        observations = null;
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
      Storage.saveObservations(observations);

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

    const birds = Array.isArray(tickList.birds) ? tickList.birds : [];
    const totalCount = birds.length || tickList.total || 0;
    const tickedCount = birds.filter((b) => b.ticked).length || tickList.ticked || 0;
    document.getElementById("stat-ticked").textContent = tickedCount;
    document.getElementById("stat-total").textContent = totalCount;
    document.getElementById("stat-missing-alm").textContent = missingAlm.size;
    document.getElementById("stat-missing-su").textContent = missingSU.size;
    document.getElementById("stat-alerts").textContent = matched.size;

    const alertEl = document.getElementById("stat-alerts");
    alertEl.className = "stat-value" + (matched.size > 0 ? " alert" : "");

    const obsCount = observations?.observations?.length ?? 0;
    document.getElementById("stat-observations").textContent = obsCount;
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

    const artIdMap = Storage.get("artIdMap") || {};
    const speciesMap = Storage.get("speciesMap") || {};

    let matcher = null;
    const trimmed = (filter || "").trim();
    if (trimmed.length >= 3) {
      try {
        matcher = new RegExp(trimmed, "i");
      } catch {
        matcher = null;
      }
    }

    const birds = [];
    const seen = new Set();
    for (const bird of tickList.birds) {
      if (seen.has(bird.latin || bird.name)) continue;
      if (matcher && !matcher.test(bird.name || "") && !matcher.test(bird.latin || "")) continue;
      seen.add(bird.latin || bird.name);
      birds.push(bird);
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

  initMap() {
    if (this._map || typeof maplibregl === "undefined") return;
    const el = document.getElementById("obs-map");
    if (!el) return;
    this._map = new maplibregl.Map({
      container: el,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [11.0, 56.0],
      zoom: 5.7,
      attributionControl: { compact: true },
    });
    this._map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  },

  renderMap(items) {
    if (!this._map) return;
    if (!this._map.isStyleLoaded()) {
      this._map.once("load", () => this.renderMap(items));
      return;
    }

    for (const m of this._markers) m.remove();
    this._markers = [];

    const bounds = new maplibregl.LngLatBounds();
    let any = false;
    for (const obs of items) {
      if (obs.lat == null || obs.lng == null) continue;
      let kind = "normal";
      if (obs.ticked) kind = "ticked";
      else if (obs.rare) kind = "rare";
      else if (obs.scarce) kind = "scarce";

      const el = document.createElement("div");
      el.className = `obs-marker obs-marker--${kind}`;

      const popupHtml = `<strong>${esc(obs.species || "")}</strong><br>${esc(obs.location || "")}${obs.count ? ` · ${obs.count} stk` : ""}${obs.time ? `<br>🕐 ${esc(obs.time)}` : ""}`;
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([obs.lng, obs.lat])
        .setPopup(new maplibregl.Popup({ offset: 12, closeButton: false }).setHTML(popupHtml))
        .addTo(this._map);
      this._markers.push(marker);
      bounds.extend([obs.lng, obs.lat]);
      any = true;
    }

    if (this.userLat != null && this.userLng != null) {
      if (!this._userMarker) {
        const el = document.createElement("div");
        el.className = "user-marker";
        el.innerHTML = '<div class="user-marker-pulse"></div><div class="user-marker-dot"></div>';
        this._userMarker = new maplibregl.Marker({ element: el })
          .setLngLat([this.userLng, this.userLat])
          .setPopup(new maplibregl.Popup({ offset: 12, closeButton: false }).setHTML("📍 Din position"))
          .addTo(this._map);
      } else {
        this._userMarker.setLngLat([this.userLng, this.userLat]);
      }
      bounds.extend([this.userLng, this.userLat]);
      any = true;
    }

    if (any) {
      this._map.fitBounds(bounds, { padding: 30, maxZoom: 10, duration: 400 });
    }
  },

  buildObservationItems(mode) {
    if (mode === "all") {
      const observations = Storage.getObservations();
      const list = observations?.observations;
      if (!list || !list.length) return [];

      const tickList = Storage.getTickList();
      const tickedLatin = new Set();
      const tickedName = new Set();
      if (tickList?.birds) {
        for (const b of tickList.birds) {
          if (b.ticked) {
            if (b.latin) tickedLatin.add(Scraper.normalizeName(b.latin));
            if (b.name) tickedName.add(Scraper.normalizeName(b.name));
          }
        }
      }

      return list.map((obs) => {
        const dist = Scraper.distanceKm(this.userLat, this.userLng, obs.lat, obs.lng);
        const latinKey = obs.latin ? Scraper.normalizeName(obs.latin) : "";
        const nameKey = obs.species ? Scraper.normalizeName(obs.species) : "";
        const ticked = tickedLatin.has(latinKey) || tickedName.has(nameKey);
        return {
          ...obs,
          distance: dist != null ? Math.round(dist * 10) / 10 : null,
          ticked,
        };
      });
    }
    return Storage.getAlerts() || [];
  },

  renderAlerts() {
    const container = document.getElementById("alerts-container");
    const mode = this.obsFilter;
    const items = this.buildObservationItems(mode);

    this.renderMap(items || []);

    if (!items || items.length === 0) {
      const msg = mode === "all"
        ? "Ingen observationer på denne dag"
        : "Ingen manglende arter spottet i dag";
      container.innerHTML = `
        <div class="empty-state">
          <div class="emoji">🔭</div>
          <p>${msg}</p>
          <p style="margin-top: 8px; font-size: 13px;">Tryk 🔄 for at opdatere</p>
        </div>`;
      this._lastAlertNodes = null;
      return;
    }

    const speciesGroups = new Map();
    for (const alert of items) {
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
        ticked: obsArray[0].ticked,
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
      const groupKey = `g:${group.species}|${group.latin}`;
      if (!this._expandedGroups.has(groupKey)) continue;
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
      const tickedBadge = item.ticked ? '<span class="badge badge-ticked">✓ Krydset</span>' : "";

      const dofUrl = Scraper.getDofbasenUrl(item.artId);
      const locCount = item.locations ? [...new Set(item.locations.split(", "))].size : 0;
      const tickedClass = item.ticked ? " bird-card--ticked" : "";
      const groupKey = `g:${item.species}|${item.latin}`;
      const expanded = this._expandedGroups.has(groupKey);
      const collapsedClass = expanded ? "" : " bird-card--collapsed";
      const chevron = expanded ? "▾" : "▸";

      const html = `<div class="group-header">
            <div class="group-title">
              <div>
                <div class="species-name">
                  <span class="group-chevron">${chevron}</span>
                  ${dofUrl ? `<a href="${esc(dofUrl)}" target="_blank" rel="noopener" class="species-link">${esc(item.species)}</a>` : esc(item.species)}${badge}${tickedBadge}
                </div>
                <div class="latin-name">${esc(item.latin)}</div>
              </div>
              <div class="group-count">🔢 ${item.count || 0}${locCount ? ` · ${locCount} lok.` : ""}</div>
            </div>
          </div>`;

      return {
        key: groupKey,
        sig: `${item.count || 0}|${locCount}|${modifier}|${item.ticked ? 1 : 0}|${expanded ? 1 : 0}`,
        outerClass: `bird-tree-item bird-tree-item--group bird-card ${modifier}${tickedClass}${collapsedClass}`,
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
        node.dataset.key = key;
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

function rawSortValue(c, key) {
  switch (key) {
    case "name": return (c.name || c.species || "").toLowerCase();
    case "location": return (c.cluster?.name || "").toLowerCase();
    case "score": return c.scoreNorm != null ? c.scoreNorm : c.score;
    case "band":
      return c.band === "høj" ? 3 : c.band === "mellem" ? 2 : c.band === "lav" ? 1 : 0;
    case "evidence": return (c.evidence || []).length;
    case "lastObs": return (c.evidence || []).reduce((acc, e) => (e.date > acc ? e.date : acc), "");
    default: return 0;
  }
}

function renderRawEvidence(c) {
  const nearby = (c.cluster?.nearby || []).slice(0, 5);
  const ev = c.evidence || [];
  const nearbyHtml = nearby.length
    ? `<div class="raw-nearby"><strong>Nærliggende:</strong> ${nearby.map((n) =>
        `${esc(n.location)}${n.distKm != null ? ` (${n.distKm} km)` : ""}`).join(" · ")}</div>`
    : "";
  if (!ev.length) {
    return `${nearbyHtml}<div class="raw-no-evidence">Ingen evidens</div>`;
  }
  const list = ev.map((e) => `
    <li>
      <span class="raw-ev-date">${esc(e.date || "")}</span>
      <span class="raw-ev-loc">${esc(e.location || "")}</span>
      ${e.count != null ? `<span class="raw-ev-count">${esc(String(e.count))} stk</span>` : ""}
      ${e.observer ? `<span class="raw-ev-obs">👤 ${esc(e.observer)}</span>` : ""}
      ${e.behaviour ? `<span class="raw-ev-beh">📋 ${esc(e.behaviour)}</span>` : ""}
    </li>`).join("");
  return `${nearbyHtml}<ul class="raw-evidence">${list}</ul>`;
}

function downloadRawCsv(rows) {
  const headers = ["art", "latin", "lokalitet", "loknr", "score", "scoreNorm", "band", "evidens_antal", "sidste_obs"];
  const csvRows = [headers.join(",")];
  for (const c of rows) {
    const last = (c.evidence || []).reduce((acc, e) => (e.date > acc ? e.date : acc), "");
    csvRows.push([
      c.name || c.species || "",
      c.latin || "",
      c.cluster?.name || "",
      c.cluster?.loknr || "",
      c.score != null ? c.score.toFixed(4) : "",
      c.scoreNorm != null ? c.scoreNorm.toFixed(4) : "",
      c.band || "",
      (c.evidence || []).length,
      last,
    ].map(csvCell).join(","));
  }
  const blob = new Blob(["﻿" + csvRows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `predictor-dataset-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(v) {
  const s = String(v ?? "");
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const MONTH_NAMES_DA = [
  "Januar", "Februar", "Marts", "April", "Maj", "Juni",
  "Juli", "August", "September", "Oktober", "November", "December",
];

function formatMonthLabel(monthKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  return `${MONTH_NAMES_DA[parseInt(m[2], 10) - 1]} ${m[1]}`;
}

function renderCalendarMonth(monthData, tickedLatin) {
  const title = formatMonthLabel(monthData.month);
  let inner = "";
  if (monthData.error) {
    inner = `<div class="empty-state"><div class="emoji">⚠️</div><p>Kunne ikke generere: ${esc(monthData.error)}</p></div>`;
  } else if (monthData.note && (!monthData.locations || !monthData.locations.length)) {
    inner = `<div class="ai-empty">${esc(monthData.note)}</div>`;
  } else if (!monthData.locations || !monthData.locations.length) {
    inner = `<div class="ai-empty">Ingen anbefalinger</div>`;
  } else {
    inner = monthData.locations
      .map((loc) => {
        const birds = (loc.birds || [])
          .map((b) => {
            const ticked = tickedLatin.has((b.latin || "").toLowerCase());
            const confClass = b.confidence === "høj" ? "high" : b.confidence === "mellem" ? "med" : "low";
            const latinClean = (b.latin || "").trim();
            const speciesClean = (b.species || "").trim();
            const showLatin = latinClean && latinClean.toLowerCase() !== speciesClean.toLowerCase();
            return `
              <div class="calendar-bird calendar-bird--${confClass}${ticked ? " bird-ticked" : ""}">
                <div class="calendar-bird-head">
                  <div class="calendar-bird-species">
                    ${ticked ? "✓ " : ""}${esc(speciesClean)}
                    ${showLatin ? `<span class="calendar-bird-latin">${esc(latinClean)}</span>` : ""}
                  </div>
                  <div class="calendar-bird-conf">${esc(b.confidence || "")}</div>
                </div>
                <div class="calendar-bird-reason">${esc(b.reasoning || "")}</div>
              </div>`;
          })
          .join("");
        return `
          <div class="calendar-location">
            <div class="calendar-location-head">
              <div class="calendar-location-name">📍 ${esc(loc.name)}</div>
              <div class="calendar-location-count">${(loc.birds || []).length} arter</div>
            </div>
            ${loc.summary ? `<div class="calendar-location-summary">${esc(loc.summary)}</div>` : ""}
            <div class="calendar-birds">${birds}</div>
          </div>`;
      })
      .join("");
  }
  return `
    <section class="calendar-month">
      <h3 class="calendar-month-title">${esc(title)}</h3>
      ${inner}
    </section>`;
}

function renderChatMessages(messages) {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  if (!messages.length) {
    container.innerHTML = `
      <div class="chat-empty">
        <div class="emoji">💬</div>
        <p>Spørg ornitologen om manglende arter, lokaliteter eller hvad du kan se på vej hjem fra arbejde.</p>
      </div>`;
    return;
  }
  container.innerHTML = messages
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.content))
    .map((m) => {
      if (m.role === "user") {
        return `<div class="chat-bubble chat-bubble--user">${esc(m.content || "")}</div>`;
      }
      return `<div class="chat-bubble chat-bubble--assistant">${renderChatMarkdown(m.content || "")}</div>`;
    })
    .join("");
  container.scrollTop = container.scrollHeight;
}

function renderChatMarkdown(text) {
  // Light markdown: bold, italics, line breaks, lists, images. Trust the
  // model not to inject HTML (we esc() first), then unescape allowed markers.
  let out = esc(text);
  // Images — only same-origin /img/ paths allowed, to avoid arbitrary remote loads.
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
    if (!/^\/img\//.test(src)) return "";
    return `<img class="chat-img" src="${src}" alt="${alt || ""}" loading="lazy">`;
  });
  // Code spans
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold + italic
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  // Bullet list lines starting with "- " or "* "
  out = out.replace(/(?:^|\n)([-*]) +([^\n]+)/g, (m, _b, t) => `\n<li>${t}</li>`);
  out = out.replace(/(<li>[\s\S]+?<\/li>)(?=\n[^<]|\n*$)/g, "<ul>$1</ul>");
  // Line breaks
  out = out.replace(/\n/g, "<br>");
  return out;
}

Object.assign(App, {
  async openChat() {
    setTimeout(() => this.autosizeChatInput(), 0);
    const existing = Storage.getChatMessages();
    if (this.chatLoaded) {
      renderChatMessages(existing || []);
      return;
    }
    this.chatLoaded = true;
    renderChatMessages(existing || []);
    const deviceId = Storage.getDeviceId();
    try {
      const data = await Scraper.fetchChatHistory(deviceId);
      const fetched = (data.messages || []).map((m) => ({
        role: m.role,
        content: m.content || "",
      }));
      // Don't clobber an in-flight send that beat the history fetch.
      const current = Storage.getChatMessages() || [];
      if (current.length <= fetched.length) {
        Storage.saveChatMessages(fetched);
        renderChatMessages(fetched);
      }
    } catch (err) {
      console.warn("Chat history failed:", err.message);
    }
  },

  autosizeChatInput() {
    const ta = document.getElementById("chat-input");
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  },

  async sendChat() {
    if (this.chatBusy) return;
    const input = document.getElementById("chat-input");
    const text = (input.value || "").trim();
    if (!text) return;

    const settings = Storage.getSettings();
    const deviceId = Storage.getDeviceId();
    const messages = Storage.getChatMessages() || [];
    messages.push({ role: "user", content: text });
    messages.push({ role: "assistant", content: "…" });
    Storage.saveChatMessages(messages);
    renderChatMessages(messages);

    input.value = "";
    this.autosizeChatInput();
    this.chatBusy = true;
    this.setChatBusy(true);

    try {
      const res = await Scraper.sendChatMessage({
        deviceId,
        userId: settings.userId,
        listType: settings.listType,
        lat: this.userLat,
        lng: this.userLng,
        message: text,
      });
      messages.pop();
      messages.push({ role: "assistant", content: res.content || "" });
      Storage.saveChatMessages(messages);
      renderChatMessages(messages);
    } catch (err) {
      console.warn("Chat send failed:", err.message);
      messages.pop();
      messages.push({
        role: "assistant",
        content: `⚠️ ${err.message || "Chat fejlede"}`,
      });
      Storage.saveChatMessages(messages);
      renderChatMessages(messages);
    } finally {
      this.chatBusy = false;
      this.setChatBusy(false);
    }
  },

  setChatBusy(busy) {
    const send = document.getElementById("chat-send");
    const input = document.getElementById("chat-input");
    if (send) send.disabled = busy;
    if (input) input.disabled = busy;
  },

  async clearChat() {
    if (!confirm("Ryd hele chatten?")) return;
    const deviceId = Storage.getDeviceId();
    try {
      await Scraper.clearChatHistory(deviceId);
    } catch (err) {
      console.warn("Chat clear failed:", err.message);
    }
    Storage.saveChatMessages([]);
    renderChatMessages([]);
  },
});

document.addEventListener("DOMContentLoaded", () => App.init());
