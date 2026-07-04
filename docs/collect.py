"""
Moves the freshly-downloaded GEX JSON snapshot (written by the page's own
download-trigger) from Downloads into a date-partitioned data folder, then
refreshes and (hourly) publishes the gex-replay website from that JSON.

The interactive replay rebuilds its heatmap live from the JSON, so no PNG
frames are rendered here — the JSON is the single source of truth.
"""
import json
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SYMBOL = "SPY"
DOWNLOADS = Path(r"C:\Users\jalee\Downloads")
BASE_DIR = Path(r"C:\Users\jalee\gex_snapshots\SPY_GEXOI_700_800")
DATA_DIR = BASE_DIR / "data"
DOWNLOAD_NAME = "gex_snapshot.json"

# Everything is bucketed in Eastern Time, and a "trading day" runs on a rolling
# 24h cycle from 8:00 PM ET the prior evening to 7:59 PM ET — so the overnight
# futures session belongs to the NEXT session's data set.
ET = ZoneInfo("America/New_York")
TRADING_DAY_ROLL_HOUR = 20  # 8 PM ET

# --- gex-replay website mirror ---------------------------------------------
# gex_snapshots stays the source of truth; after each capture we also refresh
# the static replay site's data/ + manifest.json and (optionally) push it live.
REPLAY_REPO = Path(r"C:\Users\jalee\Documents\GitHub\gex-replay")
REPLAY_BUILD_SCRIPT = REPLAY_REPO / "scripts" / "build_manifest.py"
UPDATE_REPLAY = True        # rebuild the replay site's data on every snapshot
PUBLISH_REPLAY = True       # auto commit + push (CLI is authed as shurwatrader)
PUSH_INTERVAL_MINUTES = 7   # publish as often as GitHub Pages allows: its build
                            # limit is ~10/hour, so ~7 min (~8-9/hr) is the safe max

# This machine's git command line is authenticated as a different GitHub
# account (attahj), so we push shurwatrader's repo with a scoped token read
# from REPLAY_TOKEN_FILE — a fine-grained PAT limited to just this one repo
# (Contents: read/write). Keep that file private; it is never committed, and
# the token is redacted from any error output below.
REPLAY_GH_USER = "shurwatrader"
REPLAY_REMOTE = "github.com/shurwatrader/gex-replay.git"
REPLAY_BRANCH = "master"
REPLAY_TOKEN_FILE = Path(r"C:\Users\jalee\gex_snapshots\.gh_token")
REPLAY_GIT_NAME = "shurwatrader"
REPLAY_GIT_EMAIL = "shurwatrader@users.noreply.github.com"


def update_replay(date_str, ts):
    """Refresh the gex-replay site data every snapshot, but only commit + push
    at most once per PUSH_INTERVAL_MINUTES.

    The local data/ is always kept current so nothing is lost; the throttle
    just batches an hour's worth of snapshots into a single push, staying well
    under GitHub Pages' ~10 builds/hour soft limit. The gate is the last
    commit's timestamp, so a failed push self-heals on the next interval.

    Best-effort: any failure here is logged but never fails the capture.
    """
    if not UPDATE_REPLAY:
        return
    if not REPLAY_BUILD_SCRIPT.exists():
        print(f"WARN replay: build script not found at {REPLAY_BUILD_SCRIPT}, skipping mirror")
        return
    try:
        subprocess.run([sys.executable, str(REPLAY_BUILD_SCRIPT)],
                       cwd=str(REPLAY_REPO), check=True,
                       capture_output=True, text=True)
    except Exception as e:
        print(f"WARN replay: build_manifest failed ({e}); site not updated")
        return

    if not PUBLISH_REPLAY:
        print("OK replay: site data updated locally (PUBLISH_REPLAY=False)")
        return

    def git(*args):
        return subprocess.run(["git", *args], cwd=str(REPLAY_REPO),
                              capture_output=True, text=True)

    try:
        has_remote = bool(git("remote").stdout.strip())
        if not has_remote:
            print("OK replay: site data updated (no git remote yet - publish the repo to go live)")
            return

        # Throttle: skip commit/push if the last commit is newer than the interval.
        last = git("log", "-1", "--format=%ct").stdout.strip()
        if last.isdigit():
            age_min = (datetime.now().timestamp() - int(last)) / 60
            if age_min < PUSH_INTERVAL_MINUTES:
                wait = PUSH_INTERVAL_MINUTES - age_min
                print(f"OK replay: data updated; next push in ~{wait:.0f} min")
                return

        git("add", "-A")
        commit = git("-c", f"user.name={REPLAY_GIT_NAME}",
                     "-c", f"user.email={REPLAY_GIT_EMAIL}",
                     "commit", "-m", f"snapshots through {date_str} {ts}")
        if commit.returncode != 0 and "nothing to commit" not in (commit.stdout + commit.stderr):
            print(f"WARN replay: git commit failed: {commit.stderr.strip() or commit.stdout.strip()}")
            return

        token = ""
        if REPLAY_TOKEN_FILE.exists():
            token = REPLAY_TOKEN_FILE.read_text(encoding="utf-8-sig").strip()

        if token:
            # Explicit scoped PAT (works even if the machine's git is another account)
            push = git("push", f"https://{REPLAY_GH_USER}:{token}@{REPLAY_REMOTE}",
                       f"HEAD:{REPLAY_BRANCH}")
        else:
            # Fall back to the machine's stored git credentials — works once that
            # account is a collaborator on the repo (no token to create/rotate).
            push = git("push")

        if push.returncode != 0:
            msg = push.stderr.strip() or push.stdout.strip()
            if token:
                msg = msg.replace(token, "***")
            print(f"WARN replay: git push failed: {msg}")
        else:
            print("OK replay: pushed to GitHub Pages")
    except Exception as e:
        print(f"WARN replay: publish step errored ({e})")


def main():
    src = DOWNLOADS / DOWNLOAD_NAME
    if not src.exists():
        print(f"ERROR: {src} not found")
        sys.exit(1)

    with open(src) as f:
        data = json.load(f)

    captured_at_utc = data.get("capturedAt")
    if captured_at_utc:
        dt_utc = datetime.fromisoformat(captured_at_utc.replace("Z", "+00:00"))
    else:
        dt_utc = datetime.now(timezone.utc)
    dt_et = dt_utc.astimezone(ET)

    # Trading-day boundary: snapshots from 8 PM ET onward belong to the next
    # session's data set (the overnight session leads into it).
    trading_day = dt_et.date()
    if dt_et.hour >= TRADING_DAY_ROLL_HOUR:
        trading_day += timedelta(days=1)
    date_str = trading_day.strftime("%Y-%m-%d")
    ts = dt_et.strftime("%H%M%S")  # ET; chronological order is restored in the
                                   # build via capturedAt, since ts wraps midnight

    date_data_dir = DATA_DIR / date_str
    date_data_dir.mkdir(parents=True, exist_ok=True)

    dest_json = date_data_dir / f"{SYMBOL}_{date_str}_{ts}.json"
    shutil.move(str(src), dest_json)

    rows = data.get("rows", [])
    print(f"OK trading_day={date_str} et={dt_et:%H:%M:%S} rows={len(rows)} "
          f"netExp={data.get('netExposure')} -> {dest_json.name}")

    update_replay(date_str, ts)


if __name__ == "__main__":
    main()
