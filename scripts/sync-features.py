#!/usr/bin/env python3
"""Refresh tests/fixtures/features/{mainnet,devnet}.json.

For every feature id known to the pinned runtime crate (tests/fixtures/features/
ids.json, written by `cargo test -p fade-testkit --test dump_feature_ids -- --ignored`),
ask the cluster whether its feature account exists and when it activated.
Only the runtime crate's list is trusted: the CLI's `feature status` table can
lag behind it.

    python3 scripts/sync-features.py mainnet devnet
"""
import base64, json, sys, urllib.request
from pathlib import Path

RPC = {"mainnet": "https://api.mainnet-beta.solana.com", "devnet": "https://api.devnet.solana.com"}
ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "features"

def rpc(url, method, params):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["result"]

def main(clusters):
    ids = json.loads((FIX / "ids.json").read_text())
    known = ids["features"]
    for cluster in clusters:
        url = RPC[cluster]
        slot = rpc(url, "getSlot", [{"commitment": "finalized"}])
        active, inactive = [], []
        for i in range(0, len(known), 100):
            chunk = known[i:i + 100]
            infos = rpc(url, "getMultipleAccounts", [[f["id"] for f in chunk], {"encoding": "base64", "commitment": "finalized"}])["value"]
            for f, info in zip(chunk, infos):
                if info is None:
                    inactive.append({"id": f["id"], "name": f["name"]}); continue
                data = base64.b64decode(info["data"][0])
                # Feature account: 1 byte Option tag, then u64 LE activation slot.
                at = int.from_bytes(data[1:9], "little") if data and data[0] == 1 else None
                (active if at is not None else inactive).append({"id": f["id"], "name": f["name"], "activated_at": at})
        out = {
            "cluster": cluster, "rpc": url, "queried_at_slot": slot,
            "agave_feature_set": ids["agave_feature_set"],
            "active": sorted(active, key=lambda f: f["activated_at"]),
            "inactive": sorted(inactive, key=lambda f: f["name"]),
        }
        (FIX / f"{cluster}.json").write_text(json.dumps(out, indent=1) + "\n")
        print(f"{cluster}: {len(active)} active, {len(inactive)} inactive, slot {slot}")

if __name__ == "__main__":
    main(sys.argv[1:] or ["mainnet", "devnet"])
