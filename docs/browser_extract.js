// Installs window.__gexTick — a one-call capture routine for the Quantum
// Terminal GEX matrix. Injected once per tab session (survives until the tab
// navigates/reloads); each tick after that is just `await window.__gexTick()`.
//
// Captures MID/TOP/BOTTOM scroll positions via direct scrollTop manipulation
// (no mouse-wheel simulation, no screenshots), merges them, filters to the
// configured strike range, and triggers the same gex_snapshot.json download
// collect.py already expects. Per-cell fields: text (clean value, badge
// stripped), color, wallOI, wallPct, oiKing, volKing.
(function () {
  const STRIKE_MIN = 700;
  const STRIKE_MAX = 800;

  function classifyStar(svg) {
    if (!svg) return null;
    const c = getComputedStyle(svg).color;
    const m = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return null;
    const r = +m[1], g = +m[2], b = +m[3];
    if (g > r && g > b) return 'oi';
    if (r > g && r > b) return 'vol';
    return null;
  }

  function extractTable() {
    const table = Array.from(document.querySelectorAll('table')).find(t => t.textContent.includes('Strike'));
    if (!table) return null;
    const headerCells = Array.from(table.querySelectorAll('thead th, thead td')).map(c => c.textContent.trim());
    const expiries = headerCells.slice(1);
    const nCol = expiries.length;
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    const rows = [];
    // The matrix is live: during a re-render the <thead> can gain an expiry
    // column a beat before the body cells for it populate. If we read in that
    // gap, a row has fewer values than there are expiries and the last column
    // (e.g. the newest expiration) is silently dropped. Track alignment so the
    // caller can retry until header and every data row agree.
    let aligned = nCol > 0;
    for (const tr of bodyRows) {
      const cells = Array.from(tr.children);
      if (cells.length < 2) continue;
      const strike = parseFloat((cells[0].textContent || '').trim());
      if (isNaN(strike)) continue;
      if (cells.length - 1 !== nCol) aligned = false;
      const values = cells.slice(1).map(td => {
        const overlay = td.querySelector(':scope > div');
        const color = overlay ? (overlay.style.backgroundColor || getComputedStyle(overlay).backgroundColor) : null;
        const valueEl = td.querySelector('div.font-mono.tabular-nums');
        const text = valueEl ? valueEl.textContent.trim() : (td.querySelector('div[class*="z-10"]')?.textContent.trim() || td.textContent.trim());
        const badgeEl = td.querySelector('span.rounded-full');
        let wallOI = null, wallPct = null, wallType = null;
        if (badgeEl) {
          const spans = Array.from(badgeEl.querySelectorAll('span'));
          wallOI = spans[0] ? spans[0].textContent.trim() : null;
          wallPct = spans[1] ? spans[1].textContent.trim() : null;
          wallType = badgeEl.getAttribute('title') || null; // "call top volume" / "put top volume"
        }
        const starSvg = td.querySelector('svg.lucide-star');
        const starType = classifyStar(starSvg);
        return { text, color, wallOI, wallPct, wallType, oiKing: starType === 'oi', volKing: starType === 'vol' };
      });
      rows.push({ strike, values });
    }
    return { expiries, rows, aligned };
  }

  // Read the table, retrying while a live re-render leaves header/body columns
  // misaligned. Returns the last read even if never perfectly aligned; the
  // caller does a final completeness check before publishing.
  async function extractStable(tries, delay) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      last = extractTable();
      if (last && last.aligned && last.expiries.length && last.rows.length) return last;
      await new Promise(r => setTimeout(r, delay));
    }
    return last;
  }

  window.__gexTick = async function () {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('title') || '').includes('king strike'));
    if (!btn) return { error: 'ATM/king-strike button not found' };
    btn.click();
    await new Promise(r => setTimeout(r, 150));

    const scrollContainer = document.querySelector('div[class*="overflow-y-auto"][class*="transform-gpu"]');
    if (!scrollContainer) return { error: 'scroll container not found' };

    const mid = scrollContainer.scrollTop;
    const midData = await extractStable(10, 350);
    if (!midData) return { error: 'table not found' };
    const expiries = midData.expiries;

    scrollContainer.scrollTop = mid - scrollContainer.clientHeight;
    await new Promise(r => setTimeout(r, 120));
    const topData = await extractStable(5, 250);

    scrollContainer.scrollTop = mid + scrollContainer.clientHeight;
    await new Promise(r => setTimeout(r, 120));
    const botData = await extractStable(5, 250);

    scrollContainer.scrollTop = mid; // leave the view centered for next tick / manual viewing

    const merged = {};
    for (const r of (topData && topData.rows) || []) merged[r.strike] = r;
    for (const r of midData.rows) merged[r.strike] = r;
    for (const r of (botData && botData.rows) || []) merged[r.strike] = r;
    const all = Object.values(merged)
      .filter(r => r.strike >= STRIKE_MIN && r.strike <= STRIKE_MAX)
      .sort((a, b) => b.strike - a.strike);

    // Final completeness guard: never publish a snapshot where the header and
    // body disagree on column count (would drop the newest expiration). Better
    // to skip this tick than write a half-row snapshot.
    if (!expiries.length || all.some(r => r.values.length !== expiries.length)) {
      return { error: 'columns not stable (header/body mismatch)', cols: expiries.length, rowCount: all.length };
    }

    const expMatch = document.body.innerText.match(/NET EXPOSURE[\s\S]{0,20}?(-?\$[\d.,]+[KMB]?)\|\$([\d.,]+)/);
    const result = {
      expiries: expiries,
      rows: all,
      capturedAt: new Date().toISOString(),
      netExposure: expMatch ? expMatch[1] : null,
      price: expMatch ? expMatch[2] : null,
    };

    const blob = new Blob([JSON.stringify(result)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gex_snapshot.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    return {
      rowCount: all.length,
      cols: expiries.length,
      expiries: expiries,
      min: all.length ? all[all.length - 1].strike : null,
      max: all.length ? all[0].strike : null,
      netExposure: result.netExposure,
    };
  };

  return 'installed';
})();
