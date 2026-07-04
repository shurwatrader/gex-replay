/* GEX Replay — interactive frame-by-frame heatmap player.
   The grid is built from the UNION of expiries/strikes across all loaded frames
   and each frame's values map by expiry name, so a date range (or a day where
   an expiry rolls off the board) still lines up under the right headers. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $("title"),
    seriesSelect: $("seriesSelect"),
    datePick: $("datePick"),
    datePickEnd: $("datePickEnd"),
    tradingDay: $("tradingDay"), snapET: $("snapET"),
    clkCT: $("clkCT"), clkPT: $("clkPT"),
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
    stepSelect: $("stepSelect"),
    moversToggle: $("moversToggle"),
  };

  const state = {
    manifest: null,
    series: null,
    frames: [],
    frameIndex: 0,
    playing: false,
    timer: null,
    expiries: [],   // union across loaded frames, chronological
    strikes: [],    // union across loaded frames, descending
    cellEls: [],
    strikeEls: [],
    wallColEls: [],
    rowEls: [],
    priceRowEl: null,
    callWall: null, putWall: null,   // row indices of the wall rows
    posMax: 1, negMax: 1,            // color scale anchors, per frame
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

  // Prefer new scraper fields; split the old "532K0.00%0" blob for legacy frames.
  function parseCell(cell) {
    let text = (cell.text ?? "").trim();
    if (cell.wallOI == null && cell.wallPct == null) {
      const m = text.match(/^([\d.,]+[KMB]?)(-?\d+(?:\.\d+)?%)(.*)$/);
      if (m) text = m[3].trim();
    }
    return { display: text, num: parseCellValue(text) };
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
  // { bg, fg, shadow } — fg + a matching outline keep the value legible on any cell.
  function styleFor(value) {
    if (!value) return { bg: "rgb(24, 30, 38)", fg: "#5f656e", shadow: "none" };
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
    const light = lum <= 150;
    return {
      bg: `rgb(${r},${g},${b})`,
      fg: light ? "#ffffff" : "#0a0d11",
      shadow: light ? "0 1px 2px rgba(0,0,0,.8)" : "0 1px 1px rgba(255,255,255,.45)",
    };
  }

  // ---------- trading day + snapshot clocks ----------
  const TZ = { ET: "America/New_York", CT: "America/Chicago", PT: "America/Los_Angeles" };
  function zoneParts(date, tz) {
    // HH:MM only — seconds dropped for a cleaner snapshot display
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, month: "2-digit", day: "2-digit",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
    });
    const parts = fmt.formatToParts(date);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
    return {
      date: `${get("month")}/${get("day")}`,
      time: `${get("hour")}:${get("minute")} ${get("dayPeriod")}`,
      abbr: get("timeZoneName"),
    };
  }
  function fmtTradingDay(td) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(td || "");
    return m ? `${m[2]}/${m[3]}/${m[1]}` : (td || "—");
  }
  // Trading Day = the assigned session (8 PM ET roll); Snapshot = exact ET
  // date+time, so overnight data reads e.g. "Trading Day 7/6 · Snapshot 7/5 8:00 PM".
  function updateClocks(capturedAt, tradingDay) {
    els.tradingDay.textContent = fmtTradingDay(tradingDay);
    const d = capturedAt ? new Date(capturedAt) : null;
    if (!d || isNaN(d)) {
      els.snapET.textContent = els.clkCT.textContent = els.clkPT.textContent = "—";
      return;
    }
    const et = zoneParts(d, TZ.ET);
    els.snapET.textContent = `${et.date}, ${et.time} ${et.abbr}`;
    els.clkCT.textContent = zoneParts(d, TZ.CT).time;
    els.clkPT.textContent = zoneParts(d, TZ.PT).time;
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
    const dates = (state.series.dates || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    state.series.dates = dates;
    if (!dates.length) { showEmpty("This series has no dates."); return; }
    const min = dates[0].date, max = dates[dates.length - 1].date;
    els.datePick.min = els.datePickEnd.min = min;
    els.datePick.max = els.datePickEnd.max = max;
    els.datePick.value = max;
    els.datePickEnd.value = "";
    loadRange();
  }

  async function loadRange() {
    stop();
    const start = els.datePick.value;
    let end = els.datePickEnd.value || start;
    if (end < start) { end = start; els.datePickEnd.value = ""; }
    const inRange = state.series.dates.filter((d) => d.date >= start && d.date <= end);
    if (!inRange.length) {
      state.frames = [];
      showEmpty(`No data for ${start}${end !== start ? " … " + end : ""}.`);
      return;
    }
    const bundles = await Promise.all(inRange.map(async (d) => {
      try { const r = await fetch(d.file, { cache: "no-store" }); if (!r.ok) throw 0; return await r.json(); }
      catch { return null; }
    }));
    const frames = [];
    bundles.filter(Boolean).forEach((b) => frames.push(...(b.frames || [])));
    frames.sort((a, b) => (a.capturedAt || "").localeCompare(b.capturedAt || ""));
    if (!frames.length) { state.frames = []; showEmpty("No frames in that range."); return; }

    state.frames = frames;
    els.empty.hidden = true;
    buildGrid(frames);
    els.scrubber.max = String(Math.max(0, frames.length - 1));
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

  // ---------- grid construction ----------
  function expiryDate(e) {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(e);
    return m ? new Date(`${m[3]}-${m[1]}-${m[2]}`).getTime() : 0;
  }

  function buildGrid(frames) {
    if (!frames.length) { showEmpty("No frames."); return; }
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
      th.className = "exp-col";
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

      // wall gutter — holds a Call/Put Wall badge on the wall strikes
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
    state.callWall = state.putWall = null;
  }

  // ---------- per-frame render ----------
  function frameMap(frame) {
    const map = new Map();
    if (!frame) return map;
    const exps = frame.expiries || [];
    (frame.rows || []).forEach((row) => {
      (row.values || []).forEach((cell, c) => {
        const exp = exps[c];
        if (exp != null) map.set(row.strike + "|" + exp, { cell, parsed: parseCell(cell) });
      });
    });
    return map;
  }

  function showFrame(idx) {
    const frames = state.frames;
    if (!frames || !frames.length) return;
    idx = Math.max(0, Math.min(frames.length - 1, idx));
    state.frameIndex = idx;
    const frame = frames[idx];
    const cur = frameMap(frame);
    const prev = idx > 0 ? frameMap(frames[idx - 1]) : new Map();

    let vmin = 0, vmax = 0;
    cur.forEach(({ parsed }) => {
      if (parsed.num < vmin) vmin = parsed.num;
      if (parsed.num > vmax) vmax = parsed.num;
    });
    state.posMax = Math.max(vmax, 1);
    state.negMax = Math.max(-vmin, 1);
    els.legMin.textContent = fmtCompact(vmin);
    els.legMax.textContent = "+" + fmtCompact(vmax);

    // movers: top 6 |delta| vs previous frame
    const moverMap = new Map();
    if (els.moversToggle.checked && prev.size) {
      const deltas = [];
      cur.forEach(({ parsed }, key) => {
        const pp = prev.get(key);
        if (!pp) return;
        const d = parsed.num - pp.parsed.num;
        if (d !== 0) deltas.push([Math.abs(d), key, d]);
      });
      deltas.sort((a, b) => b[0] - a[0]);
      deltas.slice(0, 6).forEach(([, key, d]) => moverMap.set(key, d));
    }

    // drop expiry columns not on the board this frame
    const present = new Set(frame.expiries || []);
    state.expiries.forEach((exp, c) => {
      const show = present.has(exp) ? "" : "none";
      state.headerEls[c].style.display = show;
      state.cellEls.forEach((rowCells) => { rowCells[c].td.style.display = show; });
    });

    const rowSum = new Map();

    state.strikes.forEach((strike, r) => {
      state.expiries.forEach((exp, c) => {
        const key = strike + "|" + exp;
        const el = state.cellEls[r][c];
        const entry = cur.get(key);

        if (!entry) {
          el.td.className = "cell absent";
          el.td.style.background = "";
          el.td.style.color = "";
          el.val.textContent = "";
          el.val.style.textShadow = "none";
          el.starOi.hidden = el.starVol.hidden = el.delta.hidden = true;
          el.td.title = "";
          delete el.td.dataset.dir;
          return;
        }
        const { cell, parsed } = entry;
        rowSum.set(strike, (rowSum.get(strike) || 0) + parsed.num);

        el.td.className = "cell" + (parsed.num ? "" : " zero");
        el.val.textContent = parsed.display;
        const { bg, fg, shadow } = styleFor(parsed.num);
        el.td.style.background = bg;
        el.td.style.color = fg;
        el.val.style.textShadow = shadow;

        el.starOi.hidden = !cell.oiKing;
        el.starVol.hidden = !cell.volKing;

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

        let tip = `${exp} · ${strike}\n${parsed.display || "0"}`;
        const pp = prev.get(key);
        if (pp) {
          const dd = parsed.num - pp.parsed.num;
          tip += `\nΔ ${dd >= 0 ? "+" : ""}${fmtCompact(dd)} vs prev`;
        }
        if (cell.oiKing) tip += `\n★ GEX OI king`;
        if (cell.volKing) tip += `\n★ GEX Vol king`;
        el.td.title = tip;
      });
    });

    markPriceRow(frame);
    markWalls(rowSum);
    updateClocks(frame.capturedAt, frame.tradingDay);
    els.scrubber.value = String(idx);
    els.frameLabel.textContent = `${idx + 1} / ${frames.length}`;
  }

  function markPriceRow(frame) {
    if (state.priceRowEl) {
      state.priceRowEl.classList.remove("price-row");
      state.priceRowEl = null;
    }
    if (frame.price == null) return;
    let bestR = -1, bestD = Infinity;
    state.strikes.forEach((s, r) => {
      const d = Math.abs(s - frame.price);
      if (d < bestD) { bestD = d; bestR = r; }
    });
    if (bestR < 0) return;
    state.rowEls[bestR].classList.add("price-row");
    state.priceRowEl = state.rowEls[bestR];
  }

  // Call wall = strike with the largest positive total GEX across expiries;
  // put wall = most negative. Badge lives in the gutter; a dashed line marks
  // the row (below the call wall, above the put wall).
  function markWalls(rowSum) {
    [state.callWall, state.putWall].forEach((r) => {
      if (r == null) return;
      state.rowEls[r].classList.remove("call-wall", "put-wall");
      const g = state.wallColEls[r];
      g.pill.hidden = true; g.pill.className = "wall";
    });
    state.callWall = state.putWall = null;

    let callStrike = null, callV = 0, putStrike = null, putV = 0;
    rowSum.forEach((v, s) => {
      if (v > callV) { callV = v; callStrike = s; }
      if (v < putV) { putV = v; putStrike = s; }
    });

    const set = (strike, kind, label, abbr) => {
      if (strike == null) return;
      const r = state.strikes.indexOf(strike);
      if (r < 0) return;
      state.rowEls[r].classList.add(kind + "-wall");
      const g = state.wallColEls[r];
      g.pill.hidden = false;
      g.pill.textContent = label;
      g.pill.dataset.abbr = abbr;  // shown instead of the label on mobile
      g.pill.className = "wall " + kind;
      if (kind === "call") state.callWall = r; else state.putWall = r;
    };
    set(callStrike, "call", "Call Wall", "CW");
    set(putStrike, "put", "Put Wall", "PW");
  }

  function scrollToSpot() {
    const tr = state.priceRowEl;
    if (!tr) return;
    const sc = els.gridScroll;
    sc.scrollTop = Math.max(0, tr.offsetTop - sc.clientHeight / 2 + tr.offsetHeight / 2);
  }

  // ---------- playback ----------
  // Frames are captured every 2 min, so the step select maps time → frame jump:
  // 2m=+1, 10m=+5, 30m=+15, 1h=+30.
  function step() { return parseInt(els.stepSelect.value, 10) || 1; }
  function fps() { return 2 * parseFloat(els.speedSelect.value); }
  function play() {
    if (!state.frames || state.frames.length < 2) return;
    state.playing = true;
    els.playBtn.textContent = "⏸";
    els.playBtn.classList.add("playing");
    scheduleTick();
  }
  function scheduleTick() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (!state.playing) return;
      let next = state.frameIndex + step();
      if (next >= state.frames.length) next = 0;
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
  els.nextBtn.onclick = () => { stop(); showFrame(state.frameIndex + step()); };
  els.prevBtn.onclick = () => { stop(); showFrame(state.frameIndex - step()); };
  els.firstBtn.onclick = () => { stop(); showFrame(0); };
  els.lastBtn.onclick = () => { stop(); showFrame(state.frames.length - 1); };
  els.scrubber.oninput = () => { stop(); showFrame(+els.scrubber.value); };
  els.speedSelect.onchange = () => { if (state.playing) scheduleTick(); };
  els.stepSelect.onchange = () => {};
  els.moversToggle.onchange = () => showFrame(state.frameIndex);
  els.datePick.onchange = loadRange;
  els.datePickEnd.onchange = loadRange;

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.code === "ArrowRight") { stop(); showFrame(state.frameIndex + step()); }
    else if (e.code === "ArrowLeft") { stop(); showFrame(state.frameIndex - step()); }
    else if (e.code === "Home") { stop(); showFrame(0); }
    else if (e.code === "End") { stop(); showFrame(state.frames.length - 1); }
  });

  loadManifest();
})();
