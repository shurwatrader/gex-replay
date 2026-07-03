/* GEX Replay — interactive frame-by-frame heatmap player.
   The scraped per-cell colors are near-uniform, so we color each cell from its
   numeric value using a diverging scale (purple = negative, teal/green/yellow =
   positive), matching the source terminal's heatmap. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $("title"),
    seriesSelect: $("seriesSelect"),
    dateSelect: $("dateSelect"),
    clkET: $("clkET"), clkCT: $("clkCT"), clkPT: $("clkPT"),
    tzET: $("tzET"), tzCT: $("tzCT"), tzPT: $("tzPT"),
    grid: $("grid"),
    gridScroll: $("gridScroll"),
    empty: $("empty"),
    legMin: $("legMin"), legMax: $("legMax"),
    firstBtn: $("firstBtn"),
    prevBtn: $("prevBtn"),
    playBtn: $("playBtn"),
    nextBtn: $("nextBtn"),
    lastBtn: $("lastBtn"),
    scrubber: $("scrubber"),
    frameLabel: $("frameLabel"),
    speedSelect: $("speedSelect"),
    moversToggle: $("moversToggle"),
  };

  const state = {
    manifest: null,
    series: null,
    bundle: null,
    frameIndex: 0,
    playing: false,
    timer: null,
    cellEls: [],
    strikeEls: [],
    priceRowEl: null,
    logPos: Math.log1p(1),  // color scale anchors, recomputed per frame:
    logNeg: Math.log1p(1),  // purple = frame min, yellow = frame max
    expiries: [],
  };

  // ---------- number parsing ----------
  const NUM_RE = /-?[\d,]*\.?\d+[KMB]?/g;
  function parseCellValue(text) {
    if (!text) return 0;
    const tokens = text.replace(/\$/g, "").match(NUM_RE);
    if (!tokens) return 0;
    const tok = tokens[tokens.length - 1].replace(/,/g, "");
    const m = /(-?[\d.]+)([KMB]?)$/.exec(tok);
    if (!m) return 0;
    const mult = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[m[2]];
    return parseFloat(m[1]) * mult;
  }

  function fmtCompact(v) {
    if (v == null || isNaN(v)) return "—";
    const sign = v < 0 ? "-" : "";
    const a = Math.abs(v);
    if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`;
    return `${sign}${a.toFixed(0)}`;
  }

  // ---------- diverging color scale ----------
  // stops keyed on t in [-1, 1]
  const STOPS = [
    [-1.0, 150, 60, 170],
    [-0.5, 70, 90, 180],
    [0.0, 28, 45, 60],
    [0.5, 38, 152, 134],
    [1.0, 245, 215, 60],
  ];
  // Returns { bg, fg } — fg (text) is chosen dark or light by the background's
  // luminance so numbers stay readable on both bright and dark cells.
  function styleFor(value) {
    if (!value) return { bg: "rgb(24, 30, 38)", fg: "#5f656e" };
    let t = value > 0
      ? Math.log1p(value) / state.logPos
      : -Math.log1p(-value) / state.logNeg;
    t = Math.max(-1, Math.min(1, t));
    let r = 28, g = 45, b = 60;
    for (let i = 0; i < STOPS.length - 1; i++) {
      const [t0, r0, g0, b0] = STOPS[i];
      const [t1, r1, g1, b1] = STOPS[i + 1];
      if (t >= t0 && t <= t1) {
        const f = (t - t0) / (t1 - t0);
        r = Math.round(r0 + (r1 - r0) * f);
        g = Math.round(g0 + (g1 - g0) * f);
        b = Math.round(b0 + (b1 - b0) * f);
        break;
      }
    }
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return { bg: `rgb(${r},${g},${b})`, fg: lum > 150 ? "#0a0d11" : "#ffffff" };
  }

  // ---------- timezone clocks ----------
  const TZ = {
    ET: "America/New_York",
    CT: "America/Chicago",
    PT: "America/Los_Angeles",
  };
  function zoneParts(date, tz) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit",
      hour12: true, timeZoneName: "short",
    });
    const parts = fmt.formatToParts(date);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
    const time = `${get("hour")}:${get("minute")}:${get("second")} ${get("dayPeriod")}`;
    return { time, abbr: get("timeZoneName") };
  }
  function updateClocks(capturedAt) {
    const d = capturedAt ? new Date(capturedAt) : null;
    if (!d || isNaN(d)) {
      els.clkET.textContent = els.clkCT.textContent = els.clkPT.textContent = "—";
      return;
    }
    [["ET", els.clkET, els.tzET], ["CT", els.clkCT, els.tzCT], ["PT", els.clkPT, els.tzPT]]
      .forEach(([k, clkEl, tzEl]) => {
        const { time, abbr } = zoneParts(d, TZ[k]);
        clkEl.textContent = time;
        tzEl.textContent = abbr || k;
      });
  }

  // ---------- data loading ----------
  async function loadManifest() {
    try {
      const res = await fetch("data/manifest.json", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      state.manifest = await res.json();
    } catch (e) {
      showEmpty("Could not load data/manifest.json. Run the build script and serve over http (see README).");
      return;
    }
    const series = state.manifest.series || [];
    if (!series.length) { showEmpty("Manifest has no series yet. Run scripts/build_manifest.py."); return; }
    els.seriesSelect.innerHTML = series.map((s, i) => `<option value="${i}">${s.title}</option>`).join("");
    els.seriesSelect.onchange = () => selectSeries(+els.seriesSelect.value);
    selectSeries(0);
  }

  function selectSeries(i) {
    state.series = state.manifest.series[i];
    els.title.textContent = state.series.title;
    const dates = state.series.dates || [];
    els.dateSelect.innerHTML = dates.map((d, j) => `<option value="${j}">${d.date} · ${d.frames} frames</option>`).join("");
    els.dateSelect.onchange = () => selectDate(+els.dateSelect.value);
    els.dateSelect.value = String(dates.length - 1);
    selectDate(dates.length - 1);
  }

  async function selectDate(j) {
    stop();
    const meta = state.series.dates[j];
    try {
      const res = await fetch(meta.file, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      state.bundle = await res.json();
    } catch (e) {
      showEmpty(`Could not load ${meta.file}.`);
      return;
    }
    els.empty.hidden = true;
    buildGrid(state.bundle.frames);
    els.scrubber.max = String(Math.max(0, state.bundle.frames.length - 1));
    state.frameIndex = 0;
    els.scrubber.value = "0";
    showFrame(0);
    scrollToSpot();
  }

  function showEmpty(msg) {
    els.empty.textContent = msg;
    els.empty.hidden = false;
    els.grid.innerHTML = "";
  }

  // ---------- grid construction (once per date) ----------
  function buildGrid(frames) {
    if (!frames.length) { showEmpty("This day has no frames."); return; }
    const expiries = frames[0].expiries || [];
    const rows = frames[0].rows || [];
    state.expiries = expiries;

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    const strikeHead = document.createElement("th");
    strikeHead.className = "strike-col strike-head";
    strikeHead.textContent = "STRIKE";
    htr.appendChild(strikeHead);
    expiries.forEach((e) => {
      const th = document.createElement("th");
      th.textContent = e;
      htr.appendChild(th);
    });
    thead.appendChild(htr);

    const tbody = document.createElement("tbody");
    state.cellEls = [];
    state.strikeEls = [];
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      const stTd = document.createElement("td");
      stTd.className = "strike-col";
      stTd.textContent = fmtStrike(row.strike);
      tr.appendChild(stTd);
      state.strikeEls.push(stTd);

      const rowCells = [];
      (row.values || []).forEach(() => {
        const td = document.createElement("td");
        td.className = "cell";
        const wall = document.createElement("span");   // wall-alert badge (left)
        wall.className = "wall"; wall.hidden = true;
        const val = document.createElement("span");     // the GEX value (right)
        val.className = "val";
        td.appendChild(wall);
        td.appendChild(val);
        tr.appendChild(td);
        rowCells.push(td);
      });
      state.cellEls.push(rowCells);
      tbody.appendChild(tr);
    });

    els.grid.innerHTML = "";
    els.grid.appendChild(thead);
    els.grid.appendChild(tbody);
  }

  function fmtStrike(s) { return Number.isInteger(s) ? String(s) : String(s); }

  // ---------- movers (biggest change vs previous frame) ----------
  function computeMovers(frame, prevFrame, count = 6) {
    const keys = new Set();
    if (!prevFrame) return keys;
    const prev = new Map();
    (prevFrame.rows || []).forEach((row) => (row.values || []).forEach((cell, c) =>
      prev.set(row.strike + "|" + c, parseCellValue(cell.text))));
    const deltas = [];
    (frame.rows || []).forEach((row) => (row.values || []).forEach((cell, c) => {
      const key = row.strike + "|" + c;
      if (!prev.has(key)) return;
      const d = Math.abs(parseCellValue(cell.text) - prev.get(key));
      if (d > 0) deltas.push([d, key]);
    }));
    deltas.sort((a, b) => b[0] - a[0]);
    for (let i = 0; i < Math.min(count, deltas.length); i++) keys.add(deltas[i][1]);
    return keys;
  }

  // ---------- per-frame render ----------
  function showFrame(idx) {
    const frames = state.bundle.frames;
    if (!frames || !frames.length) return;
    idx = Math.max(0, Math.min(frames.length - 1, idx));
    state.frameIndex = idx;
    const frame = frames[idx];
    const prevFrame = idx > 0 ? frames[idx - 1] : null;
    const movers = els.moversToggle.checked ? computeMovers(frame, prevFrame) : new Set();

    // Per-frame color scale: anchor the palette to this frame's actual extremes
    // so the legend's ends equal the lowest/highest GEX numbers on screen.
    let vmin = 0, vmax = 0;
    (frame.rows || []).forEach((row) => (row.values || []).forEach((c) => {
      const v = parseCellValue(c.text);
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }));
    state.logPos = Math.log1p(Math.max(vmax, 1));
    state.logNeg = Math.log1p(Math.max(-vmin, 1));
    els.legMin.textContent = fmtCompact(vmin);
    els.legMax.textContent = "+" + fmtCompact(vmax);

    // prev-frame lookup for per-cell delta tooltips
    const prevMap = new Map();
    if (prevFrame) (prevFrame.rows || []).forEach((row) => (row.values || []).forEach((cell, c) =>
      prevMap.set(row.strike + "|" + c, parseCellValue(cell.text))));

    (frame.rows || []).forEach((row, r) => {
      const rowCells = state.cellEls[r];
      if (!rowCells) return;
      (row.values || []).forEach((cell, c) => {
        const td = rowCells[c];
        if (!td) return;
        const text = cell.text ?? "";
        const num = parseCellValue(text);
        const wallEl = td.firstChild, valEl = td.lastChild;
        valEl.textContent = text;
        const { bg, fg } = styleFor(num);
        td.style.background = bg;
        td.style.color = fg;
        td.classList.toggle("zero", !num);

        // wall-alert badge (new scraper field; absent on old frames)
        const wallText = [cell.wallOI, cell.wallPct].filter(Boolean).join(" ");
        if (wallText) {
          wallEl.hidden = false;
          wallEl.textContent = wallText;
        } else if (!wallEl.hidden) {
          wallEl.hidden = true;
          wallEl.textContent = "";
        }
        // GEX OI king (green ★) / Vol king (red ★)
        td.classList.toggle("oi-king", !!cell.oiKing);
        td.classList.toggle("vol-king", !!cell.volKing);

        const isMover = movers.has(row.strike + "|" + c);
        td.classList.toggle("mover", isMover);
        if (isMover) {
          const pv = prevMap.get(row.strike + "|" + c);
          td.dataset.dir = pv != null && num < pv ? "down" : "up";
        } else if (td.dataset.dir) {
          delete td.dataset.dir;
        }
        // hover: value + delta + wall + king
        const key = row.strike + "|" + c;
        let tip = `${state.expiries[c] || ""} · ${fmtStrike(row.strike)}\n${text || "0"}`;
        if (prevMap.has(key)) {
          const d = num - prevMap.get(key);
          tip += `\nΔ ${d >= 0 ? "+" : ""}${fmtCompact(d)} vs prev`;
        }
        if (wallText) tip += `\nWall: ${wallText}`;
        if (cell.oiKing) tip += `\n★ GEX OI king`;
        if (cell.volKing) tip += `\n★ GEX Vol king`;
        td.title = tip;
      });
    });

    markPriceRow(frame);
    updateClocks(frame.capturedAt);
    els.scrubber.value = String(idx);
    els.frameLabel.textContent = `${idx + 1} / ${frames.length}`;
  }

  function markPriceRow(frame) {
    if (state.priceRowEl) {
      state.priceRowEl.classList.remove("price-row");
      const st = state.priceRowEl.querySelector("td.strike-col");
      if (st) delete st.dataset.spot;
      state.priceRowEl = null;
    }
    if (frame.price == null) return;
    let bestR = -1, bestD = Infinity;
    (frame.rows || []).forEach((row, r) => {
      const d = Math.abs(row.strike - frame.price);
      if (d < bestD) { bestD = d; bestR = r; }
    });
    if (bestR < 0) return;
    const stEl = state.strikeEls[bestR];
    const tr = stEl && stEl.parentElement;
    if (!tr) return;
    tr.classList.add("price-row");
    stEl.dataset.spot = "$" + Number(frame.price).toFixed(2);
    state.priceRowEl = tr;
  }

  // Center the spot-price row in view (called once when a date loads, so it
  // doesn't fight the user's scrolling during playback).
  function scrollToSpot() {
    const tr = state.priceRowEl;
    if (!tr) return;
    const sc = els.gridScroll;
    sc.scrollTop = Math.max(0, tr.offsetTop - sc.clientHeight / 2 + tr.offsetHeight / 2);
  }

  // ---------- playback ----------
  function fps() { return 2 * parseFloat(els.speedSelect.value); }
  function play() {
    if (!state.bundle || state.bundle.frames.length < 2) return;
    state.playing = true;
    els.playBtn.textContent = "⏸";
    els.playBtn.classList.add("playing");
    scheduleTick();
  }
  function scheduleTick() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (!state.playing) return;
      let next = state.frameIndex + 1;
      if (next >= state.bundle.frames.length) next = 0;
      showFrame(next);
      scheduleTick();
    }, 1000 / fps());
  }
  function stop() {
    state.playing = false;
    clearTimeout(state.timer);
    els.playBtn.textContent = "▶";
    els.playBtn.classList.remove("playing");
  }
  function togglePlay() { state.playing ? stop() : play(); }

  // ---------- wiring ----------
  els.playBtn.onclick = togglePlay;
  els.nextBtn.onclick = () => { stop(); showFrame(state.frameIndex + 1); };
  els.prevBtn.onclick = () => { stop(); showFrame(state.frameIndex - 1); };
  els.firstBtn.onclick = () => { stop(); showFrame(0); };
  els.lastBtn.onclick = () => { stop(); showFrame(state.bundle.frames.length - 1); };
  els.scrubber.oninput = () => { stop(); showFrame(+els.scrubber.value); };
  els.speedSelect.onchange = () => { if (state.playing) scheduleTick(); };
  els.moversToggle.onchange = () => showFrame(state.frameIndex);

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.code === "ArrowRight") { stop(); showFrame(state.frameIndex + 1); }
    else if (e.code === "ArrowLeft") { stop(); showFrame(state.frameIndex - 1); }
    else if (e.code === "Home") { stop(); showFrame(0); }
    else if (e.code === "End") { stop(); showFrame(state.bundle.frames.length - 1); }
  });

  loadManifest();
})();
