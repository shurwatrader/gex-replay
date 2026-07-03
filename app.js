/* GEX Replay — interactive frame-by-frame heatmap player.
   The grid is built from the UNION of expiries/strikes across the whole day and
   each frame's values are mapped by expiry name, so frames captured after an
   expiry rolls off the board still line up under the right date headers. */
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
    expiries: [],   // union across the day, chronological
    strikes: [],    // union across the day, descending
    cellEls: [],    // [strikeIdx][expiryIdx] -> { td, wall, starOi, starVol, delta, val }
    strikeEls: [],  // per-row strike <td>
    rowEls: [],     // per-row <tr>
    priceRowEl: null,
    callWallEl: null, putWallEl: null,   // strike <td>s holding wall chips
    posMax: 1,  // color scale anchors, recomputed per frame:
    negMax: 1,  // purple = frame min, yellow = frame max
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

  // Resolve a cell to { display, num, wallOI, wallPct }. Prefers the new scraper
  // fields; for old frames it splits the concatenated badge blob (e.g.
  // "532K0.00%0" -> wall "532K 0.00%", value "0") so nothing shows the blob.
  function parseCell(cell) {
    let text = (cell.text ?? "").trim();
    let wallOI = cell.wallOI ?? null;
    let wallPct = cell.wallPct ?? null;
    if (wallOI == null && wallPct == null) {
      const m = text.match(/^([\d.,]+[KMB]?)(-?\d+(?:\.\d+)?%)(.*)$/);
      if (m) { wallOI = m[1]; wallPct = m[2]; text = m[3].trim(); }
    }
    return { display: text, num: parseCellValue(text), wallOI, wallPct };
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
  const STOPS = [
    [-1.0, 150, 60, 170],
    [-0.5, 70, 90, 180],
    [0.0, 28, 45, 60],
    [0.5, 38, 152, 134],
    [1.0, 245, 215, 60],
  ];
  // { bg, fg } — fg picked dark or light by the background's luminance.
  function styleFor(value) {
    if (!value) return { bg: "rgb(24, 30, 38)", fg: "#5f656e" };
    // Square-root scale: log over-compressed the mid range. sqrt keeps low-mid
    // values blue-green; only the frame's largest values reach yellow.
    let t = value > 0
      ? Math.sqrt(value / state.posMax)
      : -Math.sqrt(-value / state.negMax);
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
  function expiryDate(e) {
    // "07-06-2026" -> sortable timestamp
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(e);
    return m ? new Date(`${m[3]}-${m[1]}-${m[2]}`).getTime() : 0;
  }

  function buildGrid(frames) {
    if (!frames.length) { showEmpty("This day has no frames."); return; }

    // Union of expiries and strikes across every frame of the day, so late
    // frames (after an expiry drops off the board) still map correctly.
    const expirySet = new Set(), strikeSet = new Set();
    frames.forEach((f) => {
      (f.expiries || []).forEach((e) => expirySet.add(e));
      (f.rows || []).forEach((r) => strikeSet.add(r.strike));
    });
    state.expiries = [...expirySet].sort((a, b) => expiryDate(a) - expiryDate(b));
    state.strikes = [...strikeSet].sort((a, b) => b - a);

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    const strikeHead = document.createElement("th");
    strikeHead.className = "strike-col strike-head";
    strikeHead.textContent = "STRIKE";
    htr.appendChild(strikeHead);
    const wallHead = document.createElement("th");
    wallHead.className = "wall-col";
    wallHead.textContent = "WALL";
    htr.appendChild(wallHead);
    state.headerEls = [];
    state.expiries.forEach((e) => {
      const th = document.createElement("th");
      th.textContent = e;
      htr.appendChild(th);
      state.headerEls.push(th);
    });
    thead.appendChild(htr);

    const tbody = document.createElement("tbody");
    state.cellEls = [];
    state.strikeEls = [];
    state.wallColEls = [];
    state.rowEls = [];
    state.strikes.forEach((strike) => {
      const tr = document.createElement("tr");
      const stTd = document.createElement("td");
      stTd.className = "strike-col";
      stTd.textContent = String(strike);
      tr.appendChild(stTd);
      state.strikeEls.push(stTd);
      state.rowEls.push(tr);

      // wall-alert gutter — badges live here, not on top of the data cells
      const wallTd = document.createElement("td");
      wallTd.className = "wall-col";
      const wallPill = document.createElement("span");
      wallPill.className = "wall"; wallPill.hidden = true;
      wallTd.appendChild(wallPill);
      tr.appendChild(wallTd);
      state.wallColEls.push({ td: wallTd, pill: wallPill });

      const rowCells = [];
      state.expiries.forEach(() => {
        const td = document.createElement("td");
        td.className = "cell";
        // flex layout inside the cell: [stars][delta chip] ......... [value]
        const cw = document.createElement("div");
        cw.className = "cw";
        const starOi = document.createElement("span");
        starOi.className = "star oi"; starOi.textContent = "★"; starOi.hidden = true;
        const starVol = document.createElement("span");
        starVol.className = "star vol"; starVol.textContent = "★"; starVol.hidden = true;
        const delta = document.createElement("span");
        delta.className = "delta"; delta.hidden = true;
        const val = document.createElement("span");
        val.className = "val";
        cw.append(starOi, starVol, delta, val);
        td.appendChild(cw);
        tr.appendChild(td);
        rowCells.push({ td, starOi, starVol, delta, val });
      });
      state.cellEls.push(rowCells);
      tbody.appendChild(tr);
    });

    els.grid.innerHTML = "";
    els.grid.appendChild(thead);
    els.grid.appendChild(tbody);
    state.priceRowEl = null;
    state.callWallEl = null;
    state.putWallEl = null;
  }

  // ---------- per-frame render ----------
  // Map a frame to { "strike|expiry": parsedCell }
  function frameMap(frame) {
    const map = new Map();
    if (!frame) return map;
    const exps = frame.expiries || [];
    (frame.rows || []).forEach((row) => {
      (row.values || []).forEach((cell, c) => {
        const exp = exps[c];
        if (exp != null) map.set(row.strike + "|" + exp, parseCell(cell));
      });
    });
    return map;
  }

  function showFrame(idx) {
    const frames = state.bundle.frames;
    if (!frames || !frames.length) return;
    idx = Math.max(0, Math.min(frames.length - 1, idx));
    state.frameIndex = idx;
    const frame = frames[idx];
    const cur = frameMap(frame);
    const prev = idx > 0 ? frameMap(frames[idx - 1]) : new Map();

    // Per-frame color scale anchored to this frame's actual extremes.
    let vmin = 0, vmax = 0;
    cur.forEach((p) => {
      if (p.num < vmin) vmin = p.num;
      if (p.num > vmax) vmax = p.num;
    });
    state.posMax = Math.max(vmax, 1);
    state.negMax = Math.max(-vmin, 1);
    els.legMin.textContent = fmtCompact(vmin);
    els.legMax.textContent = "+" + fmtCompact(vmax);

    // Movers: top 6 |delta| vs previous frame (keyed strike|expiry).
    const moverMap = new Map();
    if (els.moversToggle.checked && prev.size) {
      const deltas = [];
      cur.forEach((p, key) => {
        const pp = prev.get(key);
        if (!pp) return;
        const d = p.num - pp.num;
        if (d !== 0) deltas.push([Math.abs(d), key, d]);
      });
      deltas.sort((a, b) => b[0] - a[0]);
      deltas.slice(0, 6).forEach(([, key, d]) => moverMap.set(key, d));
    }

    // Drop expiry columns that aren't on the board in this frame (e.g. already
    // expired) instead of showing a blank column.
    const present = new Set(frame.expiries || []);
    state.expiries.forEach((exp, c) => {
      const show = present.has(exp) ? "" : "none";
      state.headerEls[c].style.display = show;
      state.cellEls.forEach((rowCells) => { rowCells[c].td.style.display = show; });
    });

    // Row totals for call/put wall detection.
    const rowSum = new Map();
    const price = frame.price != null ? Number(frame.price) : null;

    state.strikes.forEach((strike, r) => {
      const rowWalls = [];
      state.expiries.forEach((exp, c) => {
        const key = strike + "|" + exp;
        const el = state.cellEls[r][c];
        const p = cur.get(key);

        if (!p) {
          el.td.className = "cell absent";
          el.td.style.background = "";
          el.td.style.color = "";
          el.val.textContent = "";
          el.starOi.hidden = el.starVol.hidden = el.delta.hidden = true;
          el.td.title = "";
          delete el.td.dataset.dir;
          return;
        }
        rowSum.set(strike, (rowSum.get(strike) || 0) + p.num);

        el.td.className = "cell" + (p.num ? "" : " zero");
        el.val.textContent = p.display;
        const { bg, fg } = styleFor(p.num);
        el.td.style.background = bg;
        el.td.style.color = fg;

        const raw = frameCell(frame, strike, exp);
        if (p.wallOI || p.wallPct) {
          rowWalls.push({ exp, wallOI: p.wallOI, wallPct: p.wallPct,
                          wallType: raw && raw.wallType });
        }

        // king stars
        el.starOi.hidden = !(raw && raw.oiKing);
        el.starVol.hidden = !(raw && raw.volKing);

        // mover delta chip (green up / red down)
        const d = moverMap.get(key);
        if (d != null) {
          el.td.classList.add("mover");
          el.td.dataset.dir = d < 0 ? "down" : "up";
          el.delta.hidden = false;
          el.delta.textContent = (d < 0 ? "▼ " : "▲ ") + fmtCompact(Math.abs(d));
          el.delta.className = "delta " + (d < 0 ? "down" : "up");
        } else {
          el.delta.hidden = true;
          delete el.td.dataset.dir;
        }

        // tooltip
        let tip = `${exp} · ${strike}\n${p.display || "0"}`;
        const pp = prev.get(key);
        if (pp) {
          const dd = p.num - pp.num;
          tip += `\nΔ ${dd >= 0 ? "+" : ""}${fmtCompact(dd)} vs prev`;
        }
        if (raw && raw.oiKing) tip += `\n★ GEX OI king`;
        if (raw && raw.volKing) tip += `\n★ GEX Vol king`;
        el.td.title = tip;
      });

      // wall-alert gutter for this strike
      const g = state.wallColEls[r];
      if (rowWalls.length) {
        const w = rowWalls[0];
        g.pill.hidden = false;
        g.pill.textContent = [w.wallOI, w.wallPct].filter(Boolean).join(" ");
        // side: scraper's wallType when available, else derived from spot
        g.td.title = rowWalls.map((x) => {
          let side = x.wallType
            ? String(x.wallType).replace(/[-_]/g, " ")
            : (price != null ? (strike >= price ? "call top volume" : "put top volume") : "top volume");
          return `${side} — ${[x.wallOI, x.wallPct].filter(Boolean).join(" ")} (${x.exp})`;
        }).join("\n");
        g.td.classList.toggle("side-call", price != null && strike >= price);
        g.td.classList.toggle("side-put", price != null && strike < price);
      } else {
        g.pill.hidden = true;
        g.td.title = "";
        g.td.classList.remove("side-call", "side-put");
      }
    });

    markPriceRow(frame);
    markWalls(rowSum);
    updateClocks(frame.capturedAt);
    els.scrubber.value = String(idx);
    els.frameLabel.textContent = `${idx + 1} / ${frames.length}`;
  }

  // raw cell object (for star flags) by strike + expiry name
  function frameCell(frame, strike, exp) {
    const c = (frame.expiries || []).indexOf(exp);
    if (c < 0) return null;
    const row = (frame.rows || []).find((r) => r.strike === strike);
    return row ? (row.values || [])[c] : null;
  }

  function markPriceRow(frame) {
    if (state.priceRowEl) {
      state.priceRowEl.classList.remove("price-row");
      const wc = state.priceRowEl.querySelector("td.wall-col");
      if (wc) delete wc.dataset.spot;
      state.priceRowEl = null;
    }
    if (frame.price == null) return;
    let bestR = -1, bestD = Infinity;
    state.strikes.forEach((s, r) => {
      const d = Math.abs(s - frame.price);
      if (d < bestD) { bestD = d; bestR = r; }
    });
    if (bestR < 0) return;
    const tr = state.rowEls[bestR];
    tr.classList.add("price-row");
    state.wallColEls[bestR].td.dataset.spot = "$" + Number(frame.price).toFixed(2);
    state.priceRowEl = tr;
  }

  // Call wall = strike with the largest positive total GEX across expiries;
  // put wall = most negative. Marked with a chip + dashed row line, like the
  // source terminal.
  function markWalls(rowSum) {
    [["call", state.callWallEl], ["put", state.putWallEl]].forEach(([kind, el]) => {
      if (el) {
        el.parentElement.classList.remove(kind + "-wall");
        const chip = el.querySelector(".wallchip");
        if (chip) chip.remove();
      }
    });
    state.callWallEl = state.putWallEl = null;

    let callStrike = null, callV = 0, putStrike = null, putV = 0;
    rowSum.forEach((v, s) => {
      if (v > callV) { callV = v; callStrike = s; }
      if (v < putV) { putV = v; putStrike = s; }
    });

    [["call", callStrike, "Call Wall"], ["put", putStrike, "Put Wall"]].forEach(([kind, strike, label]) => {
      if (strike == null) return;
      const r = state.strikes.indexOf(strike);
      if (r < 0) return;
      const tr = state.rowEls[r];
      tr.classList.add(kind + "-wall");
      const chip = document.createElement("span");
      chip.className = "wallchip " + kind;
      chip.textContent = label;
      state.wallColEls[r].td.appendChild(chip);
      if (kind === "call") state.callWallEl = state.wallColEls[r].td;
      else state.putWallEl = state.wallColEls[r].td;
    });
  }

  // Center the spot-price row in view (once per date load).
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
