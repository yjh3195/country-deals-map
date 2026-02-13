// public/map.js v20260213-3
// Fixes:
// (1) leader line crossing text -> auto switch text left/right (away from centroid)
// (2) tooltip positioning -> relative to mapWrap (not pageX drift)
// (3) TBD visible (default ON)
// (4) per-type filter toggles (EXCLUSIVE/MLD/GLD/TBD)
// (5) ✅ show_on_map OFF -> remove from map+labels
// (6) ✅ label_positions saved as centroid-based offset(dx,dy) for cross-device consistency

(() => {
  const MAP_JSON = "/data/countries-110m.json";
  const ISO_N3_MAP = "/data/iso_n3_to_iso2.json";
  const DEALS_API = "/api/deals";

  const LABELS_GET = "/api/labels";
  const LABELS_PUT = "/api/labels";
  const LABELS_RESET = "/api/labels/reset";
  const HEALTH_API = "/api/health";

  const elMapWrap = document.getElementById("mapWrap");
  const elMap = document.getElementById("map");
  const elTooltip = document.getElementById("tooltip");
  const elErr = document.getElementById("mapError");
  const elPanelBody = document.getElementById("panelBody");

  const btnEditLabels = document.getElementById("btnEditLabels");
  const btnSaveLabels = document.getElementById("btnSaveLabels");
  const btnResetLabels = document.getElementById("btnResetLabels");

  const btnFltExclusive = document.getElementById("fltExclusive");
  const btnFltMLD = document.getElementById("fltMLD");
  const btnFltGLD = document.getElementById("fltGLD");
  const btnFltTBD = document.getElementById("fltTBD");

  // ---------- state ----------
  let authed = false;
  let editMode = false;

  // default: ALL ON (includes TBD)
  const showTypes = new Set(["EXCLUSIVE", "MLD", "GLD", "TBD"]);

  let topo = null;
  let n3to2 = null;
  let deals = [];
  let labelsDB = new Map();       // key -> saved label
  let dirtyKeys = new Set();      // changed keys

  // d3 refs
  let svg, gCountries, gLabels, projection, path;
  let features = [];
  let dealsByIso2 = new Map();

  const TYPE_RANK = { EXCLUSIVE: 0, MLD: 1, GLD: 2, TBD: 3 };

  // ✅ Projection id: prevents saved label_positions from being reused across incompatible schemes
  // v3-offset: label x,y are saved as centroid-based offsets (dx, dy), not absolute px.
  const PROJ_ID = "equalearth-pacific-v3-offset";

  function escapeHTML(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showError(title, details = []) {
    if (!elErr) return;
    elErr.style.display = "block";
    elErr.innerHTML = `
      <div style="font-weight:900; margin-bottom:6px;">${escapeHTML(title)}</div>
      <ul style="margin:0; padding-left:18px;">
        ${details.map(d => `<li style="margin:4px 0;">${escapeHTML(d)}</li>`).join("")}
      </ul>
    `;
  }
  function clearError() {
    if (!elErr) return;
    elErr.style.display = "none";
    elErr.innerHTML = "";
  }

  async function fetchJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
    return r.json();
  }

  function dealColor(type) {
    switch (type) {
      case "EXCLUSIVE": return "#e11d48";
      case "MLD": return "#f59e0b";
      case "GLD": return "#16a34a";
      case "TBD": return "#b9a6ff";
      default: return "#e5e7eb";
    }
  }
  function dealLetter(type) {
    switch (type) {
      case "EXCLUSIVE": return "E";
      case "MLD": return "M";
      case "GLD": return "G";
      case "TBD": return "T";
      default: return "";
    }
  }
  function badgeClass(type) {
    switch (type) {
      case "EXCLUSIVE": return "e";
      case "MLD": return "m";
      case "GLD": return "g";
      case "TBD": return "t";
      default: return "";
    }
  }

  function pickRepresentative(arr) {
    if (!arr || arr.length === 0) return null;
    return arr[0]; // already sorted
  }

  function buildTooltipHTML(countryName, arr) {
    if (!arr || arr.length === 0) {
      return `<div class="title">${escapeHTML(countryName)}</div>
              <div class="row"><span class="muted">No deals</span></div>`;
    }
    const rows = arr.map((d) => `
      <div class="row">
        <span class="badge ${badgeClass(d.deal_type)}">${dealLetter(d.deal_type)}</span>
        <span>${escapeHTML(d.partner_name)}</span>
      </div>
    `).join("");
    return `<div class="title">${escapeHTML(countryName)}</div>${rows}`;
  }

  // ✅ Tooltip positioning: relative to mapWrap
  function setTooltip(event, html) {
    if (!elTooltip || !elMapWrap) return;
    const rect = elMapWrap.getBoundingClientRect();

    // use client coords to avoid "far right drift"
    let x = (event.clientX - rect.left) + 12;
    let y = (event.clientY - rect.top) + 12;

    // clamp inside panel
    const maxX = rect.width - 20;
    const maxY = rect.height - 20;
    x = Math.max(10, Math.min(x, maxX));
    y = Math.max(10, Math.min(y, maxY));

    elTooltip.style.display = "block";
    elTooltip.style.left = `${x}px`;
    elTooltip.style.top = `${y}px`;
    elTooltip.innerHTML = html;
  }
  function hideTooltip() {
    if (!elTooltip) return;
    elTooltip.style.display = "none";
    elTooltip.innerHTML = "";
  }

  function setPanel(countryName, iso2, arr) {
    if (!elPanelBody) return;

    if (!countryName) {
      elPanelBody.classList.add("muted");
      elPanelBody.innerHTML = "No selection";
      return;
    }

    const list = Array.isArray(arr) ? arr : [];

    elPanelBody.classList.remove("muted");

    if (list.length === 0) {
      elPanelBody.innerHTML = `
        <div style="font-weight:950; margin-bottom:8px;">
          ${escapeHTML(countryName)} ${iso2 ? `(${escapeHTML(iso2)})` : ""}
        </div>
        <div class="muted">No deals</div>
      `;
      return;
    }

    // Representative 제거 + All partners 가로
    elPanelBody.innerHTML = `
      <div style="font-weight:950; margin-bottom:8px;">
        ${escapeHTML(countryName)} ${iso2 ? `(${escapeHTML(iso2)})` : ""}
      </div>

      <div style="font-weight:850; margin-bottom:6px;">All partners</div>

      <div class="partnersRow">
        ${list.map(d => `
          <span class="partnerItem">
            <span class="badge ${badgeClass(d.deal_type)}">${dealLetter(d.deal_type)}</span>
            <span class="partnerName">${escapeHTML(d.partner_name)}</span>
          </span>
        `).join("")}
      </div>
    `;
  }

  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  function labelKey(iso2, partner) {
    return `${PROJ_ID}:${iso2}:${partner}`;
  }
  function getIso2(f) {
    return String(f.properties?.iso2 || "").trim().toUpperCase();
  }
  function getName(f) {
    return String(f.properties?.name || "Unknown").trim();
  }

  function normalizeDeals() {
    dealsByIso2 = new Map();

    for (const d of deals) {
      const iso2 = String(d.country_iso2 || "").trim().toUpperCase();
      if (!iso2) continue;

      const type = String(d.deal_type || "").trim().toUpperCase();
      if (!TYPE_RANK.hasOwnProperty(type)) continue;

      // ✅ (5) show_on_map filter: OFF -> don't render on map at all
      const show = (d.show_on_map ?? true) === true;
      if (!show) continue;

      // ✅ (4) per-type filter
      if (!showTypes.has(type)) continue;

      const item = {
        id: d.id,
        deal_type: type,
        partner_name: String(d.partner_name || "").trim(),
      };

      if (!dealsByIso2.has(iso2)) dealsByIso2.set(iso2, []);
      dealsByIso2.get(iso2).push(item);
    }

    for (const [iso2, arr] of dealsByIso2.entries()) {
      arr.sort((a, b) => (TYPE_RANK[a.deal_type] - TYPE_RANK[b.deal_type]) || a.partner_name.localeCompare(b.partner_name));
    }
  }

  function bboxArea(feat) {
    const b = path.bounds(feat);
    const w = Math.max(0, b[1][0] - b[0][0]);
    const h = Math.max(0, b[1][1] - b[0][1]);
    return w * h;
  }
  function isSmallCountry(feat) {
    return bboxArea(feat) < 500;
  }

  function computeDefaultLabelPos(feat, centroid, small) {
    if (!small) return { x: centroid[0], y: centroid[1], mode: "anchor" };
    const geo = window.d3.geoCentroid(feat); // [lon, lat]
    const lon = geo[0], lat = geo[1];
    const dx = (lon > 20 ? 1 : lon < -20 ? -1 : (lon >= 0 ? 0.6 : -0.6));
    const dy = (lat > 20 ? -1 : lat < -20 ? 1 : 0.4);
    const dist = 34;
    return { x: centroid[0] + dx * dist, y: centroid[1] + dy * dist, mode: "line" };
  }

  function updateFilterChipUI() {
    const setChip = (btn, type) => {
      if (!btn) return;
      const on = showTypes.has(type);
      btn.classList.toggle("isOn", on);
      btn.classList.toggle("isOff", !on);
    };
    setChip(btnFltExclusive, "EXCLUSIVE");
    setChip(btnFltMLD, "MLD");
    setChip(btnFltGLD, "GLD");
    setChip(btnFltTBD, "TBD");
  }

  function updateButtons() {
    updateFilterChipUI();

    btnEditLabels?.classList.toggle("chip--primary", editMode);
    btnEditLabels && (btnEditLabels.textContent = editMode ? "Editing…" : "Edit labels");

    const canMutate = authed && editMode;
    if (btnSaveLabels) btnSaveLabels.disabled = !canMutate || dirtyKeys.size === 0;
    if (btnResetLabels) btnResetLabels.disabled = !canMutate;
  }

  async function refreshAuth() {
    try {
      const j = await fetchJSON(HEALTH_API, { credentials: "same-origin" });
      authed = !!j.authed;
    } catch {
      authed = false;
    }
    updateButtons();
  }

  async function loadAll() {
    if (!window.d3) {
      showError("Map init failed (missing library)", ["d3 missing: /vendor/d3.v7.min.js"]);
      return;
    }
    if (!window.topojson) {
      showError("Map init failed (missing library)", ["topojson missing: /vendor/topojson-client.min.js"]);
      return;
    }

    clearError();

    try { topo = await fetchJSON(MAP_JSON); }
    catch { showError("Map init failed", [`TopoJSON not found: ${MAP_JSON}`]); return; }

    try { n3to2 = await fetchJSON(ISO_N3_MAP); }
    catch { showError("Map init failed", [`ISO map not found: ${ISO_N3_MAP}`]); return; }

    try {
      const dj = await fetchJSON(DEALS_API, { credentials: "same-origin" });
      deals = Array.isArray(dj?.data) ? dj.data : [];
    } catch (e) {
      showError("Map init failed", [`Deals API error: ${String(e.message || e)}`]);
      return;
    }

    // load labels
    try {
      const lj = await fetchJSON(LABELS_GET, { credentials: "same-origin" });
      const arr = Array.isArray(lj?.data) ? lj.data : [];
      labelsDB = new Map(arr.map((x) => [x.key, x]));
    } catch {
      labelsDB = new Map();
    }

    normalizeDeals();

    features = window.topojson.feature(topo, topo.objects.countries).features;
    for (const f of features) {
      const n3 = String(f.id || "").trim();
      const iso2 = String(n3to2[n3] || "").trim().toUpperCase();
      f.properties = f.properties || {};
      f.properties.iso2 = iso2 || "";
    }

    render();
    setPanel(null, null, null);
  }

  function render() {
    const d3 = window.d3;

    elMap.innerHTML = "";

    const wrap = elMap.getBoundingClientRect();
    const width = Math.max(860, Math.floor(wrap.width || 1000));
    const vh = Math.max(700, Math.floor(window.innerHeight || 900));
    const height = Math.max(560, Math.min(Math.floor(vh * 0.72), Math.floor(width * 0.62)));

    svg = d3.select(elMap)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    svg.append("rect")
      .attr("x", 0).attr("y", 0)
      .attr("width", width).attr("height", height)
      .attr("fill", "#fbf7ef");

    projection = d3.geoEqualEarth().rotate([-155, 0]); // Americas on the right
    path = d3.geoPath(projection);

    const fitFeatures = features.filter(f => String(f?.properties?.name || "").trim() !== "Antarctica");
    const fc = { type: "FeatureCollection", features: fitFeatures };

    const padX = Math.max(18, Math.round(width * 0.03));
    const padY = Math.max(18, Math.round(height * 0.05));
    const leftPad = padX * 2;
    const rightPad = padX;

    projection.fitExtent([[leftPad, padY], [width - rightPad, height - padY]], fc);

    gCountries = svg.append("g").attr("class", "countries");
    gLabels = svg.append("g").attr("class", "labels");

    gCountries.selectAll("path")
      .data(features)
      .enter()
      .append("path")
      .attr("d", path)
      .attr("fill", (f) => {
        const iso2 = getIso2(f);
        const arr = iso2 ? dealsByIso2.get(iso2) : null;
        const rep = arr ? pickRepresentative(arr) : null;
        return rep ? dealColor(rep.deal_type) : "#e5e7eb";
      })
      .attr("stroke", "rgba(17,24,39,.22)")
      .attr("stroke-width", 0.6)
      .on("mousemove", (event, f) => {
        const name = getName(f);
        const iso2 = getIso2(f);
        const arr = iso2 ? (dealsByIso2.get(iso2) || []) : [];
        setTooltip(event, buildTooltipHTML(name, arr));
      })
      .on("mouseleave", hideTooltip)
      .on("click", (event, f) => {
        const name = getName(f);
        const iso2 = getIso2(f);
        const arr = iso2 ? (dealsByIso2.get(iso2) || []) : [];
        setPanel(name, iso2, arr);
      });

    renderLabels();
    updateButtons();
  }

  // ✅ Auto text side switching (away from centroid)
  function applyTextSide(d, selAnchor) {
    const dx = (d.mode === "line" ? (d.x - d.centroid[0]) : 1); // default right if anchor
    const side = dx >= 0 ? "right" : "left";

    const textSel = selAnchor.select("text.txt");
    if (side === "right") {
      textSel.attr("x", 12).attr("text-anchor", "start");
    } else {
      textSel.attr("x", -12).attr("text-anchor", "end");
    }
  }

  function renderLabels() {
    const d3 = window.d3;
    gLabels.selectAll("*").remove();

    const labelData = [];

    for (const f of features) {
      const iso2 = getIso2(f);
      if (!iso2) continue;

      const arr = dealsByIso2.get(iso2) || [];
      const rep = pickRepresentative(arr);
      if (!rep) continue;

      const c = path.centroid(f);
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;

      const small = isSmallCountry(f);

      const key = labelKey(iso2, rep.partner_name);
      const saved = labelsDB.get(key);

      const base = computeDefaultLabelPos(f, c, small);

      // ✅ v3-offset: saved.x/y are dx/dy offsets from centroid (for line mode)
      const mode = saved?.mode ?? base.mode;

      let x = base.x;
      let y = base.y;

      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        if (mode === "line") {
          x = c[0] + Number(saved.x);
          y = c[1] + Number(saved.y);
        } else {
          x = c[0];
          y = c[1];
        }
      }

      labelData.push({
        key, iso2,
        countryName: getName(f),
        rep,
        centroid: c,
        x, y,
        mode,
        small,
        feature: f,
      });
    }

    // big countries default anchor
    for (const d of labelData) {
      if (!d.small && !labelsDB.has(d.key)) {
        d.mode = "anchor";
        d.x = d.centroid[0];
        d.y = d.centroid[1];
      }
    }

    const grp = gLabels.selectAll("g.lbl")
      .data(labelData, (d) => d.key)
      .enter()
      .append("g")
      .attr("class", "lbl")
      .attr("data-key", (d) => d.key)
      .style("cursor", editMode && authed ? "grab" : "default");

    grp.append("line")
      .attr("class", "lead")
      .attr("x1", (d) => d.centroid[0])
      .attr("y1", (d) => d.centroid[1])
      .attr("x2", (d) => d.mode === "line" ? d.x : d.centroid[0])
      .attr("y2", (d) => d.mode === "line" ? d.y : d.centroid[1])
      .attr("stroke", "rgba(17,24,39,.35)")
      .attr("stroke-width", 1)
      .attr("stroke-linecap", "round")
      .style("display", (d) => d.mode === "line" ? "block" : "none");

    const anchor = grp.append("g")
      .attr("class", "anchor")
      .attr("transform", (d) => `translate(${d.mode === "line" ? d.x : d.centroid[0]},${d.mode === "line" ? d.y : d.centroid[1]})`);

    anchor.append("circle")
      .attr("r", 5)
      .attr("fill", (d) => dealColor(d.rep.deal_type))
      .attr("stroke", "rgba(17,24,39,.15)")
      .attr("stroke-width", 1);

    anchor.append("text")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("font-size", 7)
      .attr("font-weight", 950)
      .attr("fill", (d) => d.rep.deal_type === "TBD" ? "#241a49" : "#fff")
      .text((d) => dealLetter(d.rep.deal_type));

    anchor.append("text")
      .attr("class", "txt")
      .attr("y", 0)
      .attr("dominant-baseline", "central")
      .attr("font-size", 8)
      .attr("font-weight", 800)
      .attr("fill", "#111827")
      .text((d) => d.rep.partner_name);

    // initial text side
    grp.each(function(d){
      const a = window.d3.select(this).select("g.anchor");
      applyTextSide(d, a);
    });

    // drag
    const drag = d3.drag()
      .on("start", function () {
        if (!(editMode && authed)) return;
        d3.select(this).style("cursor", "grabbing");
      })
      .on("drag", function (event, d) {
        if (!(editMode && authed)) return;

        d.x = Math.max(0, Math.min(+svg.attr("width"), event.x));
        d.y = Math.max(0, Math.min(+svg.attr("height"), event.y));
        d.mode = "line";
        dirtyKeys.add(d.key);

        const self = d3.select(this);
        const a = self.select("g.anchor");
        a.attr("transform", `translate(${d.x},${d.y})`);

        // update text side while dragging
        applyTextSide(d, a);

        self.select("line.lead")
          .style("display", "block")
          .attr("x1", d.centroid[0]).attr("y1", d.centroid[1])
          .attr("x2", d.x).attr("y2", d.y);

        updateButtons();
      })
      .on("end", function () {
        if (!(editMode && authed)) return;
        d3.select(this).style("cursor", "grab");
      });

    grp.call(drag);

    grp.on("mousemove", (event, d) => {
      const arr = dealsByIso2.get(d.iso2) || [];
      setTooltip(event, buildTooltipHTML(d.countryName, arr));
    }).on("mouseleave", hideTooltip);
  }

  async function saveLabels() {
    if (!(authed && editMode)) return;

    const items = [];
    gLabels.selectAll("g.lbl").each(function (d) {
      if (!dirtyKeys.has(d.key)) return;

      // ✅ centroid-based offsets (dx,dy)
      const dx = Number(d.x) - Number(d.centroid?.[0] ?? 0);
      const dy = Number(d.y) - Number(d.centroid?.[1] ?? 0);

      items.push({
        key: d.key,
        country_iso2: d.iso2,
        partner_name: d.rep.partner_name,
        x: dx,
        y: dy,
        mode: d.mode || "line",
      });
    });

    if (items.length === 0) return;
    btnSaveLabels.disabled = true;

    try {
      await fetchJSON(LABELS_PUT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items }),
      });

      const lj = await fetchJSON(LABELS_GET, { credentials: "same-origin" });
      const arr = Array.isArray(lj?.data) ? lj.data : [];
      labelsDB = new Map(arr.map((x) => [x.key, x]));
      dirtyKeys.clear();
      updateButtons();
    } catch (e) {
      alert(`Save failed: ${String(e.message || e)}`);
      btnSaveLabels.disabled = false;
    }
  }

  async function resetLabels() {
    if (!(authed && editMode)) return;
    if (!confirm("Reset all saved label positions?")) return;

    try {
      await fetchJSON(LABELS_RESET, { method: "POST", credentials: "same-origin" });
      labelsDB = new Map();
      dirtyKeys.clear();
      render();
    } catch (e) {
      alert(`Reset failed: ${String(e.message || e)}`);
    }
  }

  function wireUI() {
    // filters
    const toggleType = (type) => {
      if (showTypes.has(type)) showTypes.delete(type);
      else showTypes.add(type);
      normalizeDeals();
      render();
    };

    btnFltExclusive?.addEventListener("click", () => toggleType("EXCLUSIVE"));
    btnFltMLD?.addEventListener("click", () => toggleType("MLD"));
    btnFltGLD?.addEventListener("click", () => toggleType("GLD"));
    btnFltTBD?.addEventListener("click", () => toggleType("TBD"));

    // edit mode
    btnEditLabels?.addEventListener("click", () => {
      editMode = !editMode;
      dirtyKeys.clear();
      render();
      updateButtons();
    });

    btnSaveLabels?.addEventListener("click", saveLabels);
    btnResetLabels?.addEventListener("click", resetLabels);

    window.addEventListener("resize", () => {
      clearTimeout(window.__mm_resize_t);
      window.__mm_resize_t = setTimeout(() => render(), 150);
    });
  }

  async function init() {
    wireUI();
    await refreshAuth();
    await loadAll();
  }

  init();
})();
