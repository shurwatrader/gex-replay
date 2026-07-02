/* GEX Replay — interactive frame-by-frame heatmap player.
   Rebuilds the heatmap grid live from each snapshot's JSON (every cell already
   carries its own text + color), so the replay is fully interactive. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $("title"),
    seriesSelect: $("seriesSelect"),
    dateSelect: $("dateSelect"),
    statPrice: $("statPrice"),
    statNet: $("statNet"),
    statTime: $("statTime"),
    grid: $("grid"),
    gridScroll: $("gridScroll"),
    empty: $("empty"),
    sparkline: $("sparkline"),
    sparkNow: $("sparkNow"),
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
    series: null,      // current series object from manifest
    bundle: null,      // { slug, date, frames: [...] }
    frameIndex: 0,
    playing: false,
    timer: null,
    cellEls: [],       // 2D array [row][col] of <td> for in-place updates
    strikeEls: [],     // per-row strike <td>
    priceRowTd: null,  // <td>s currently marked as the price row
    moverKeys: new Set(),
  };

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

  function fmtMoney(v) {
    if (v == null || isNaN(v)) return "—";
    const sign = v < 0 ? "-" : "";
    const a = Math.abs(v);
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
    return `${sign}$${a.toFixed(0)}`;
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

    els.seriesSelect.innerHTML = series
      .map((s, i) => `<option value="${i}">${s.title}</option>`).join("");
    els.seriesSelect.onchange = () => selectSeries(+els.seriesSelect.value);
    selectSeries(0);
  }

  function selectSeries(i) {
    state.series = state.manifest.series[i];
    els.title.textContent = state.series.title;
    const dates = state.series.dates || [];
    els.dateSelect.innerHTML = dates
      .map((d, j) => `<option value="${j}">${d.date} · ${d.frames} frames</option>`).join("");
    els.dateSelect.onchange = () => selectDate(+els.dateSelect.value);
    // default to the most recent date
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
    drawSparkline();
    showFrame(0);
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

    // Header
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

    // Body — build cells once, update contents per frame.
    const tbody = document.createElement("tbody");
    state.cellEls = [];
    state.strikeEls = [];
    rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      tr.dataset.strike = row.strike;
      const stTd = document.createElement("td");
      stTd.className = "strike-col";
      stTd.textContent = formatStrike(row.strike);
      tr.appendChild(stTd);
      state.strikeEls.push(stTd);

      const rowCells = [];
      (row.values || []).forEach((_, c) => {
        const td = document.createElement("td");
        td.className = "cell";
        td.title = `${expiries[c] || ""} · ${formatStrike(row.strike)}`;
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

  function formatStrike(s) {
    return Number.isInteger(s) ? String(s) : String(s);
  }

  // ---------- movers ----------
  function computeMovers(frame, prevFrame, count = 6) {
    const keys = new Set();
    if (!prevFrame) return keys;
    const prev = new Map();
    (prevFrame.rows || []).forEach((row) => {
      (row.values || []).forEach((cell, c) => {
        prev.set(row.strike + "|" + c, parseCellValue(cell.text));
      });
    });
    const deltas = [];
    (frame.rows || []).forEach((row) => {
      (row.values || []).forEach((cell, c) => {
        const key = row.strike + "|" + c;
        if (!prev.has(key)) return;
        const d = Math.abs(parseCellValue(cell.text) - prev.get(key));
        if (d > 0) deltas.push([d, row, c]);
      });
    });
    deltas.sort((a, b) => b[0] - a[0]);
    for (let i = 0; i < Math.min(count, deltas.length); i++) {
      deltas[i] && keys.add(deltas[i][1].strike + "|" + deltas[i][2]);
    }
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

    (frame.rows || []).forEach((row, r) => {
      const rowCells = state.cellEls[r];
      if (!rowCells) return;
      (row.values || []).forEach((cell, c) => {
        const td = rowCells[c];
        if (!td) return;
        td.textContent = cell.text ?? "";
        td.style.background = cell.color || "transparent";
        const isMover = movers.has(row.strike + "|" + c);
        td.classList.toggle("mover", isMover);
      });
    });

    markPriceRow(frame);

    // stats
    els.statPrice.textContent = frame.price != null ? frame.price.toFixed(2) : "—";
    els.statNet.textContent = frame.netExposure || fmtMoney(frame.netExposureValue);
    els.statNet.classList.toggle("neg", (frame.netExposureValue ?? 0) < 0);
    els.statNet.classList.toggle("pos", (frame.netExposureValue ?? 0) > 0);
    els.statTime.textContent = frame.ts || "—";

    els.scrubber.value = String(idx);
    els.frameLabel.textContent = `${idx + 1} / ${frames.length}  ·  ${frame.ts || ""}`;
    els.sparkNow.textContent = fmtMoney(frame.netExposureValue);
    updateSparkCursor(idx);
  }

  function markPriceRow(frame) {
    // clear old marker
    if (state.priceRowEl) {
      state.priceRowEl.classList.remove("price-row");
      const td = state.priceRowEl.querySelector("td.strike-col");
      if (td) td.removeAttribute("data-price");
      state.priceRowEl = null;
    }
    if (frame.price == null) return;
    const rows = frame.rows || [];
    // find the row whose strike is closest to the current price
    let bestR = -1, bestD = Infinity;
    rows.forEach((row, r) => {
      const d = Math.abs(row.strike - frame.price);
      if (d < bestD) { bestD = d; bestR = r; }
    });
    if (bestR < 0) return;
    const tr = state.strikeEls[bestR] && state.strikeEls[bestR].parentElement;
    if (!tr) return;
    tr.classList.add("price-row");
    state.strikeEls[bestR].setAttribute("data-price", frame.price.toFixed(2));
    state.priceRowEl = tr;
  }

  // ---------- sparkline ----------
  function drawSparkline() {
    const svg = els.sparkline;
    svg.innerHTML = "";
    const frames = state.bundle.frames || [];
    const pts = frames.map((f, i) => [i, f.netExposureValue]).filter((p) => p[1] != null);
    if (pts.length < 2) return;

    const W = 1000, H = 100, padY = 10;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const xs = frames.length - 1;
    const vals = pts.map((p) => p[1]);
    let vmin = Math.min(...vals), vmax = Math.max(...vals);
    if (vmin === vmax) { vmin -= 1; vmax += 1; }
    const span = vmax - vmin;
    const X = (i) => (i / xs) * W;
    const Y = (v) => H - padY - ((v - vmin) / span) * (H - 2 * padY);

    // zero line
    if (vmin < 0 && vmax > 0) {
      const zy = Y(0);
      addSvg("line", { x1: 0, y1: zy, x2: W, y2: zy, stroke: "#3a4049", "stroke-width": 1 });
    }
    // area + line
    const line = pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
    const area = `0,${H} ` + line + ` ${W},${H}`;
    addSvg("polyline", { points: area, fill: "rgba(0,200,210,0.12)", stroke: "none" });
    addSvg("polyline", { points: line, fill: "none", stroke: "#00c8d2", "stroke-width": 2 });

    // cursor (updated separately)
    const cursor = addSvg("line", { x1: 0, y1: 0, x2: 0, y2: H, stroke: "#ffd600", "stroke-width": 1.5, id: "sparkCursor" });
    state._sparkX = X;
    state._sparkCursor = cursor;
  }

  function updateSparkCursor(idx) {
    if (!state._sparkCursor || !state._sparkX) return;
    const x = state._sparkX(idx);
    state._sparkCursor.setAttribute("x1", x);
    state._sparkCursor.setAttribute("x2", x);
  }

  function addSvg(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    els.sparkline.appendChild(el);
    return el;
  }

  // ---------- playback ----------
  function fps() { return 2 * parseFloat(els.speedSelect.value); } // base 2fps × speed
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
      if (next >= state.bundle.frames.length) next = 0; // loop
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
