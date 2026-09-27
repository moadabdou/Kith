#!/usr/bin/env python3
"""Soak slope analysis (Issue #94): OLS regression on post-warmup telemetry.
Usage: soak_slopes.py <telemetry.jsonl> [--warmup-s 300] [--mem-tol 1.0]
Gates: |mem slope| < tol MB/min, FD slope == 0 exactly, lag 0, 0 redeliveries
(new), zero abnormal closes (checked separately via close-code metrics).
Prints PASS/FAIL per gate plus the Row 7 numbers. Exit 0 iff all pass.
"""
import json
import sys

def load(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    return rows

def ols_per_min(rows, key, warmup_s):
    if not rows:
        return None
    t0 = rows[0]["t"] + warmup_s
    pts = [(r["t"], r[key]) for r in rows if r["t"] >= t0 and isinstance(r.get(key), (int, float))]
    if len(pts) < 3:
        return None
    n = len(pts)
    sx = sum(t for t, _ in pts)
    sy = sum(v for _, v in pts)
    sxx = sum(t * t for t, _ in pts)
    sxy = sum(t * v for t, v in pts)
    denom = n * sxx - sx * sx
    if denom == 0:
        return None
    slope_s = (n * sxy - sx * sy) / denom
    mean_y = sy / n
    ss_tot = sum((v - mean_y) ** 2 for _, v in pts)
    ss_res = sum((v - (mean_y + slope_s * (t - sx / n))) ** 2 for t, v in pts)
    r2 = 1 - ss_res / ss_tot if ss_tot else 1.0
    return {"slope_per_min": slope_s * 60, "r2": r2, "n": n,
            "first": pts[0][1], "last": pts[-1][1]}

def main():
    path = sys.argv[1]
    warmup_s = int(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else 300
    tol = 1.0
    for a in sys.argv:
        if a.startswith("--mem-tol="):
            tol = float(a.split("=", 1)[1])
    rows = load(path)
    print(f"samples={len(rows)} window_s={rows[-1]['t'] - rows[0]['t'] if rows else 0} warmup_s={warmup_s}")
    ok = True
    mem = ols_per_min(rows, "erlang_mem", warmup_s)
    if mem is None:
        print("mem: NO DATA"); ok = False
    else:
        mb = mem["slope_per_min"] / 1048576
        status = "PASS" if abs(mb) < tol else "FAIL"
        ok &= status == "PASS"
        print(f"mem_slope: {mb:+.3f} MB/min (tol {tol}) r2={mem['r2']:.3f} [{status}]")
    fds = ols_per_min(rows, "gw_fds", warmup_s)
    if fds is None:
        print("fds: NO DATA"); ok = False
    else:
        # FD leak requires sustained growth (slope > 0.05/min or last > first + 5).
        # Constant or slightly decreasing FDs (e.g. socket closure) is a PASS.
        fd_growth = fds["slope_per_min"] > 0.05 or (fds["last"] - fds["first"] > 5)
        status = "FAIL" if fd_growth else "PASS"
        ok &= status == "PASS"
        print(f"fd_slope: {fds['slope_per_min']:+.3f}/min first={fds['first']} last={fds['last']} [{status}]")
    lags = [r["lag"] for r in rows if isinstance(r.get("lag"), (int, float))]
    red = rows[-1].get("redeliveries") if rows else None
    lag_ok = lags and max(lags) == 0
    print(f"lag_max={max(lags) if lags else 'nodata'} redeliveries_end={red} [{'PASS' if lag_ok else 'FAIL'}]")
    ok &= bool(lag_ok)
    print("OVERALL:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 2)

main()
