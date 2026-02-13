// public/admin.js (FULL REPLACE) v20260213-admin-tidy
(() => {
  const $ = (s) => document.querySelector(s);

  const btnLogin = $("#btnLogin");
  const btnLogout = $("#btnLogout");
  const authStatus = $("#authStatus");

  const newContinent = $("#newContinent");
  const newCountry = $("#newCountry");
  const newDeal = $("#newDeal");
  const newPartner = $("#newPartner");
  const btnAdd = $("#btnAdd");

  const btnReload = $("#btnReload");
  const btnDeleteSelected = $("#btnDeleteSelected");
  const selCount = $("#selCount");
  const chkAll = $("#chkAll");
  const searchBox = $("#searchBox");

  const btnPrev = $("#btnPrev");
  const btnNext = $("#btnNext");
  const pageInfo = $("#pageInfo");
  const pageSizeSel = $("#pageSize");

  const tbody = $("#dbTbody");
  const table = $("#dbTable");

  let authed = false;

  // world-atlas list
  let worldCountries = []; // [{iso2, name}]
  let iso2ToName = new Map();
  let iso2ToContinent = new Map();

  // db rows
  let rows = [];
  let view = [];
  let page = 1;
  let pageSize = Number(pageSizeSel?.value) || 50;

  // selection & sorting
  const selectedIds = new Set();

  // ✅ 안정성: 기본 정렬은 id desc (updated_at 때문에 행이 위로 튀는 착시 방지)
  let sortKey = "id";
  let sortDir = "desc"; // asc|desc

  const TYPE_RANK = { EXCLUSIVE: 0, MLD: 1, GLD: 2, TBD: 3 };

  // ---------- helpers ----------
  function escapeHTML(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function fetchJSON(url, opts) {
    const r = await fetch(url, opts);
    const t = await r.text();
    let j = {};
    try { j = t ? JSON.parse(t) : {}; } catch {}
    if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}${j?.error ? ` (${j.error})` : ""}`);
    return j;
  }

  async function postJSON(url, body) {
    return fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    });
  }

  async function putJSON(url, body) {
    return fetchJSON(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    });
  }

  async function delJSON(url) {
    return fetchJSON(url, { method: "DELETE", credentials: "same-origin" });
  }

  function getColCount() {
    // ✅ 헤더 칼럼 수 기준으로 colspan 자동 계산 (없으면 8칸)
    const n = table?.querySelectorAll("thead th")?.length;
    return Number.isFinite(n) && n > 0 ? n : 8;
  }

  function findScrollContainer() {
    // tbody가 들어있는 스크롤 영역 찾기
    // (레이아웃이 바뀌어도 최대한 따라가도록)
    if (!tbody) return null;
    let p = tbody.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      const style = window.getComputedStyle(p);
      const oy = style.overflowY;
      if (oy === "auto" || oy === "scroll") return p;
      p = p.parentElement;
    }
    return tbody.parentElement;
  }

  function flashRow(id) {
    if (!tbody || !id) return;
    const tr = tbody.querySelector(`tr[data-id="${id}"]`);
    if (!tr) return;
    tr.classList.add("flash");
    setTimeout(() => tr.classList.remove("flash"), 650);
  }

  function setAuthUI() {
    if (!authStatus) return;
    authStatus.textContent = authed ? "Signed in" : "Not signed in";
    authStatus.classList.toggle("ok", authed);

    if (btnAdd) btnAdd.disabled = !authed;
    if (btnDeleteSelected) btnDeleteSelected.disabled = !authed || selectedIds.size === 0;
  }

  async function refreshAuth() {
    const j = await fetchJSON("/api/health", { credentials: "same-origin" });
    authed = !!j.authed;
    setAuthUI();
  }

  async function doLogin() {
    const pw = prompt("Admin password");
    if (!pw) return;
    try {
      await postJSON("/api/login", { password: pw });
      await refreshAuth();
      await loadDeals({ keepPage: true, keepScroll: true });
    } catch (e) {
      alert(String(e.message || e));
    }
  }

  async function doLogout() {
    try { await postJSON("/api/logout", {}); } catch {}
    authed = false;
    selectedIds.clear();
    setAuthUI();
    render();
  }

  // ---------- continents ----------
  function guessContinentFromLonLat(lon, lat) {
    if (lat <= -60) return "Antarctica";
    if ((lon >= 110 && lon <= 180 && lat >= -50 && lat <= 25) || (lon <= -130 && lat >= -25 && lat <= 25)) return "Oceania";
    if (lon <= -30) {
      if (lat >= 15) return "North America";
      if (lat >= 7) return "Central America";
      return "South America";
    }
    if (lon >= -25 && lon <= 60 && lat >= -40 && lat <= 37) return "Africa";
    if (lon >= -30 && lon <= 60 && lat >= 35 && lat <= 72) return "Europe";
    if (lon >= 34 && lon <= 60 && lat >= 12 && lat <= 38) return "Middle East";
    if (lon >= 60 && lon <= 180 && lat >= 5 && lat <= 80) return "Asia";
    return "Unknown";
  }

  const CONTINENT_OVERRIDES = { SG: "Asia", HK: "Asia", MO: "Asia", TW: "Asia" };

  const CONTINENT_ORDER = [
    "All",
    "Asia",
    "Europe",
    "North America",
    "Central America",
    "South America",
    "Africa",
    "Middle East",
    "Oceania",
    "Antarctica",
    "Unknown",
  ];

  function rebuildContinentDropdown() {
    if (!newContinent) return;
    newContinent.innerHTML = "";
    for (const c of CONTINENT_ORDER) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      newContinent.appendChild(opt);
    }
    newContinent.value = "All";
  }

  function getCountryListFiltered(continent) {
    const key = String(continent || "All");
    if (key === "All") return worldCountries;
    return worldCountries.filter((c) => (iso2ToContinent.get(c.iso2) || "Unknown") === key);
  }

  function rebuildCountryDropdown(continent) {
    if (!newCountry) return;
    const list = getCountryListFiltered(continent);
    newCountry.innerHTML = "";
    for (const c of list) {
      const opt = document.createElement("option");
      opt.value = c.iso2;
      opt.textContent = `${c.name} (${c.iso2})`;
      newCountry.appendChild(opt);
    }
    if (!newCountry.value && list.length) newCountry.value = list[0].iso2;
  }

  function inferContinentFromIso2(iso2) {
    const key = String(iso2 || "").toUpperCase();
    return CONTINENT_OVERRIDES[key] || iso2ToContinent.get(key) || "Unknown";
  }

  async function loadWorldAtlasCountriesAndContinents() {
    const topo = await fetchJSON("/data/countries-110m.json");
    const n3map = await fetchJSON("/data/iso_n3_to_iso2.json");

    const geoms = topo?.objects?.countries?.geometries || [];
    const mapIso2Name = new Map();
    const mapIso2Cont = new Map();

    let features = [];
    try {
      features = window.topojson && topo ? window.topojson.feature(topo, topo.objects.countries).features : [];
    } catch { features = []; }

    for (const g of geoms) {
      const n3 = String(g.id || "").trim();
      const iso2 = String(n3map[n3] || "").trim().toUpperCase();
      const name = String(g.properties?.name || "").trim();
      if (iso2 && name && !mapIso2Name.has(iso2)) mapIso2Name.set(iso2, name);
    }

    for (const [k, v] of Object.entries(CONTINENT_OVERRIDES)) mapIso2Cont.set(k, v);

    if (features.length && window.d3) {
      for (const f of features) {
        const n3 = String(f.id || "").trim();
        const iso2 = String(n3map[n3] || "").trim().toUpperCase();
        if (!iso2) continue;
        let lon = 0, lat = 0;
        try {
          const c = window.d3.geoCentroid(f);
          lon = Number(c?.[0]);
          lat = Number(c?.[1]);
        } catch {}
        let cont = guessContinentFromLonLat(lon, lat);
        if (CONTINENT_OVERRIDES[iso2]) cont = CONTINENT_OVERRIDES[iso2];
        mapIso2Cont.set(iso2, cont);
      }
    }

    iso2ToName = mapIso2Name;
    iso2ToContinent = mapIso2Cont;

    worldCountries = [...mapIso2Name.entries()]
      .map(([iso2, name]) => ({ iso2, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- deals ----------
  async function loadDeals(opts = {}) {
    const { keepPage = false, keepScroll = false, focusId = null } = opts;

    const prevPage = page;
    const prevQ = String(searchBox?.value || "");
    const scroller = findScrollContainer();
    const prevScrollTop = keepScroll && scroller ? scroller.scrollTop : 0;

    const j = await fetchJSON("/api/deals", { credentials: "same-origin" });
    rows = (j.data || []).map((r) => {
      const iso2 = String(r.country_iso2 || "").toUpperCase();
      return {
        ...r,
        show_on_map: (r.show_on_map === undefined || r.show_on_map === null) ? true : !!r.show_on_map,
        country_name: iso2ToName.get(iso2) || iso2,
        _dirty: false,
      };
    });

    selectedIds.clear();
    if (chkAll) chkAll.checked = false;

    if (searchBox) searchBox.value = prevQ;

    applyView({ keepPage: keepPage ? prevPage : 1 });

    if (keepScroll && scroller) scroller.scrollTop = prevScrollTop;
    if (focusId) flashRow(focusId);

    setAuthUI();
  }

  function applyView({ keepPage = 1 } = {}) {
    const q = String(searchBox?.value || "").trim().toLowerCase();

    view = rows.filter((r) => {
      if (!q) return true;
      return (
        String(r.continent || "").toLowerCase().includes(q) ||
        String(r.country_iso2 || "").toLowerCase().includes(q) ||
        String(r.country_name || "").toLowerCase().includes(q) ||
        String(r.deal_type || "").toLowerCase().includes(q) ||
        String(r.partner_name || "").toLowerCase().includes(q) ||
        String(r.updated_at || "").toLowerCase().includes(q)
      );
    });

    sortView();
    page = Math.max(1, Number(keepPage) || 1);
    render();
  }

 function sortView() {
  const dir = sortDir === "asc" ? 1 : -1;

  view.sort((a, b) => {
    const ka = a?.[sortKey];
    const kb = b?.[sortKey];

    // 1) id 숫자 정렬
    if (sortKey === "id") return (Number(ka) - Number(kb)) * dir;

    // 2) *_at 날짜 정렬
    if (String(sortKey).endsWith("_at")) {
      const ta = Date.parse(String(ka || "")) || 0;
      const tb = Date.parse(String(kb || "")) || 0;
      return (ta - tb) * dir;
    }

    // 3) ✅ show_on_map (ON/OFF) 정렬 추가
    // - desc(기본): ON(1) 먼저
    // - asc: OFF(0) 먼저
    if (sortKey === "show_on_map") {
      const ba = (a.show_on_map ?? true) ? 1 : 0;
      const bb = (b.show_on_map ?? true) ? 1 : 0;
      return (ba - bb) * dir;
    }

    // 4) deal_type는 rank 기준 정렬
    if (sortKey === "deal_type") {
      const TYPE_RANK = { EXCLUSIVE: 0, MLD: 1, GLD: 2, TBD: 3 };
      const ra = TYPE_RANK[String(ka || "").toUpperCase()] ?? 999;
      const rb = TYPE_RANK[String(kb || "").toUpperCase()] ?? 999;
      return (ra - rb) * dir;
    }

    // 5) 나머지는 문자열 정렬
    return String(ka ?? "").localeCompare(String(kb ?? "")) * dir;
  });
}


  function setSort(key) {
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = "asc"; }
    sortView();
    render();
  }

  function updateSelectionUI() {
    if (selCount) selCount.textContent = `${selectedIds.size} selected`;
    if (btnDeleteSelected) btnDeleteSelected.disabled = !authed || selectedIds.size === 0;
  }

  function render() {
    updateSelectionUI();
    if (!tbody) return;
    tbody.innerHTML = "";

    const total = view.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(page, totalPages);

    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const pageRows = view.slice(start, end);

    if (pageInfo) pageInfo.textContent = `Page ${page} / ${totalPages} · ${total} rows`;
    if (btnPrev) btnPrev.disabled = page <= 1;
    if (btnNext) btnNext.disabled = page >= totalPages;

    if (pageRows.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="${getColCount()}" class="muted" style="padding:18px;">No rows</td>`;
      tbody.appendChild(tr);
      return;
    }

    const contOptionsHTML = CONTINENT_ORDER
      .filter((c) => c !== "All")
      .map((c) => `<option value="${c}">${c}</option>`)
      .join("");

    for (const r of pageRows) {
      const tr = document.createElement("tr");
      tr.dataset.id = r.id;
      if (r._dirty) tr.classList.add("dirty");

      const isSelected = selectedIds.has(r.id);

      const countryOptions = worldCountries.map((c) => {
        const selected = String(r.country_iso2 || "").toUpperCase() === c.iso2 ? "selected" : "";
        return `<option value="${c.iso2}" ${selected}>${escapeHTML(c.name)} (${c.iso2})</option>`;
      }).join("");

      const dealOptions = ["EXCLUSIVE", "MLD", "GLD", "TBD"].map((d) =>
        `<option value="${d}" ${String(r.deal_type || "").toUpperCase() === d ? "selected" : ""}>${d}</option>`
      ).join("");

      tr.innerHTML = `
        <td class="col-check"><input class="rowCheck" type="checkbox" ${isSelected ? "checked" : ""}></td>
        <td><select class="input input--sm contSel">${contOptionsHTML}</select></td>
        <td><select class="input input--sm countrySel">${countryOptions}</select></td>
        <td><select class="input input--sm dealSel">${dealOptions}</select></td>
        <td><input class="input input--sm partnerInp" value="${escapeHTML(r.partner_name || "")}"></td>
        <td class="muted small">${escapeHTML(r.updated_at || "")}</td>
        <td>
          <button type="button" class="btnMini mapToggleBtn ${r.show_on_map ? "primary" : ""}" ${!authed ? "disabled" : ""}>
            ${r.show_on_map ? "ON" : "OFF"}
          </button>
        </td>
        <td class="col-actions">
          <div style="display:flex; gap:8px; align-items:center; white-space:nowrap;">
            <button type="button" class="btnMini primary saveBtn" ${(!authed || !r._dirty) ? "disabled" : ""}>Save</button>
            <button type="button" class="btnMini danger delBtn" ${!authed ? "disabled" : ""}>Delete</button>
          </div>
        </td>
      `;

      const rowChk = tr.querySelector(".rowCheck");
      rowChk.addEventListener("change", () => {
        if (rowChk.checked) selectedIds.add(r.id); else selectedIds.delete(r.id);
        updateSelectionUI();
      });

      const contSel = tr.querySelector(".contSel");
      const countrySel = tr.querySelector(".countrySel");
      const dealSel = tr.querySelector(".dealSel");
      const partnerInp = tr.querySelector(".partnerInp");
      const saveBtn = tr.querySelector(".saveBtn");
      const delBtn = tr.querySelector(".delBtn");
      const mapToggleBtn = tr.querySelector(".mapToggleBtn");

      const inferred = inferContinentFromIso2(r.country_iso2);
      contSel.value = (CONTINENT_ORDER.includes(String(r.continent)) && r.continent !== "All") ? r.continent : inferred;

      function markDirty() {
        r._dirty = true;
        tr.classList.add("dirty");
        saveBtn.disabled = !authed ? true : false;
      }

      contSel.addEventListener("change", () => { r.continent = contSel.value; markDirty(); });

      countrySel.addEventListener("change", () => {
        r.country_iso2 = countrySel.value;
        r.country_name = iso2ToName.get(String(r.country_iso2 || "").toUpperCase()) || r.country_iso2;
        const autoC = inferContinentFromIso2(r.country_iso2);
        r.continent = autoC;
        contSel.value = autoC;
        markDirty();
      });

      dealSel.addEventListener("change", () => { r.deal_type = dealSel.value; markDirty(); });
      partnerInp.addEventListener("input", () => { r.partner_name = partnerInp.value; markDirty(); });

      mapToggleBtn.addEventListener("click", async () => {
        if (!authed) return;

        const next = !r.show_on_map;
        mapToggleBtn.disabled = true;

        try {
          await putJSON(`/api/deals/${r.id}`, {
            country_iso2: r.country_iso2,
            continent: r.continent,
            deal_type: r.deal_type,
            partner_name: r.partner_name,
            show_on_map: next,
          });
          await loadDeals({ keepPage: true, keepScroll: true, focusId: r.id });
        } catch (e) {
          alert(String(e.message || e));
        } finally {
          mapToggleBtn.disabled = !authed;
        }
      });

      saveBtn.addEventListener("click", async () => {
        if (!authed) return;
        saveBtn.disabled = true;
        try {
          await putJSON(`/api/deals/${r.id}`, {
            country_iso2: r.country_iso2,
            continent: r.continent,
            deal_type: r.deal_type,
            partner_name: r.partner_name,
            show_on_map: r.show_on_map,
          });
          await loadDeals({ keepPage: true, keepScroll: true, focusId: r.id });
        } catch (e) {
          alert(String(e.message || e));
          saveBtn.disabled = false;
        }
      });

      delBtn.addEventListener("click", async () => {
        if (!authed) return;
        if (!confirm(`Delete?\n\n${r.country_name} (${r.country_iso2})\n${r.deal_type} - ${r.partner_name}`)) return;
        try {
          await delJSON(`/api/deals/${r.id}`);
          selectedIds.delete(r.id);
          await loadDeals({ keepPage: true, keepScroll: true });
        } catch (e) {
          alert(String(e.message || e));
        }
      });

      tbody.appendChild(tr);
    }
  }

  async function createDeal() {
    if (!authed) return alert("Login first.");

    const country_iso2 = newCountry.value;
    const deal_type = newDeal.value;
    const partner_name = String(newPartner.value || "").trim();

    let continent = newContinent.value;
    if (continent === "All") continent = inferContinentFromIso2(country_iso2);

    if (!country_iso2) return alert("Choose a country");
    if (!partner_name) return alert("Enter partner name");

    btnAdd.disabled = true;
    try {
      await postJSON("/api/deals", { continent, country_iso2, deal_type, partner_name });
      newPartner.value = "";
      await loadDeals({ keepPage: true, keepScroll: true });
    } catch (e) {
      alert(String(e.message || e));
    } finally {
      btnAdd.disabled = !authed;
    }
  }

  async function deleteSelected() {
    if (!authed) return;
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} selected rows?`)) return;

    btnDeleteSelected.disabled = true;
    try {
      for (const id of [...selectedIds]) await delJSON(`/api/deals/${id}`);
      selectedIds.clear();
      chkAll.checked = false;
      await loadDeals({ keepPage: true, keepScroll: true });
    } catch (e) {
      alert(String(e.message || e));
    } finally {
      updateSelectionUI();
    }
  }

  // ---------- events ----------
  btnLogin?.addEventListener("click", doLogin);
  btnLogout?.addEventListener("click", doLogout);
  btnReload?.addEventListener("click", () => loadDeals({ keepPage: true, keepScroll: true }));
  btnAdd?.addEventListener("click", createDeal);
  btnDeleteSelected?.addEventListener("click", deleteSelected);

  searchBox?.addEventListener("input", () => applyView({ keepPage: 1 }));

  pageSizeSel?.addEventListener("change", () => {
    pageSize = Number(pageSizeSel.value) || 50;
    page = 1;
    chkAll.checked = false;
    render();
  });

  btnPrev?.addEventListener("click", () => { page = Math.max(1, page - 1); chkAll.checked = false; render(); });
  btnNext?.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(view.length / pageSize));
    page = Math.min(totalPages, page + 1);
    chkAll.checked = false;
    render();
  });

  chkAll?.addEventListener("change", () => {
    const total = view.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(page, totalPages);
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const pageRows = view.slice(start, end);

    if (!chkAll.checked) for (const r of pageRows) selectedIds.delete(r.id);
    else for (const r of pageRows) selectedIds.add(r.id);
    render();
  });

  table?.querySelectorAll("th[data-sort]")?.forEach((th) => {
    th.addEventListener("click", () => setSort(th.dataset.sort));
  });

  newContinent?.addEventListener("change", () => { rebuildCountryDropdown(newContinent.value); });

  // ---------- init ----------
  (async function init() {
    try {
      await loadWorldAtlasCountriesAndContinents();
      rebuildContinentDropdown();
      rebuildCountryDropdown("All");

      await refreshAuth();
      await loadDeals({ keepPage: true, keepScroll: true });
    } catch (e) {
      console.error(e);
      alert(`Admin init failed:\n${String(e.message || e)}`);
    }
  })();
})();
