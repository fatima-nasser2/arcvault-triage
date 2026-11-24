"""Send the sample messages to the n8n intake webhook and collect the structured records.

    python scripts/run_samples.py                       # all samples (5 required + 3 edge cases)
    python scripts/run_samples.py --only-required       # just the 5 from the brief
    python scripts/run_samples.py --repeat 3            # run each sample 3x to check label consistency

Writes output/records.json (one record per sample) and prints a check against the expected labels.
Standard library only.
"""
import argparse
import collections
import json
import os
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_URL = os.environ.get("WEBHOOK_URL", "http://localhost:5678/webhook/arcvault/intake")


def post(url: str, payload: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--only-required", action="store_true")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--out", default=str(ROOT / "output" / "records.json"))
    args = ap.parse_args()

    samples = json.loads((ROOT / "data" / "samples.json").read_text())
    if args.only_required:
        samples = [s for s in samples if s["id"].startswith("sample-")]

    records, runs = [], collections.defaultdict(list)
    for s in samples:
        for i in range(args.repeat):
            rec = post(args.url, {"id": s["id"] if i == 0 else f"{s['id']}-r{i}", "source": s["source"], "message": s["message"]})
            runs[s["id"]].append(rec)
            if i == 0:
                records.append(rec)

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(records, indent=2, ensure_ascii=False))

    print(f"\n{'id':<30}{'category':<20}{'pri':<8}{'conf':<6}{'queue':<13}{'esc':<5}check")
    ok_all = True
    for s in samples:
        r, exp = runs[s["id"]][0], s["expected"]
        ok = r["destination_queue"] == exp["final_queue"] and r["escalation_flag"] == exp["escalated"] and \
            (exp["category"] is None or r["category"] == exp["category"])
        ok_all &= ok
        print(f"{s['id']:<30}{str(r['category']):<20}{r['priority']:<8}{r['confidence']:<6}{r['destination_queue']:<13}"
              f"{'Y' if r['escalation_flag'] else 'N':<5}{'OK' if ok else 'MISMATCH (expected ' + json.dumps(exp) + ')'}")
        if args.repeat > 1:
            cats = collections.Counter(x["category"] for x in runs[s["id"]])
            confs = [x["confidence"] for x in runs[s["id"]]]
            print(f"{'':<30}consistency: {dict(cats)}  confidence range {min(confs)}-{max(confs)}")
    print(f"\nWrote {len(records)} records to {out}")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
