"""Synchronous real-SQLite bridge for jest (adversarial data-sync suites).

Protocol: one JSON object per line on the request FIFO, one JSON object per
line on the response FIFO. Requests:
  {"op":"exec","sql":"...","params":[...]}  -> {"ok":true,"rows":[{col:val}]}
                                            | {"ok":false,"error":"<sqlite message>"}
  {"op":"close"}                            -> {"ok":true}
Params encode non-JSON floats as {"$float":"nan"|"inf"|"-inf"} so a test can
bind an IEEE NaN exactly the way a native driver would (sqlite3_bind_double).

The connection runs in autocommit mode (isolation_level=None) so BEGIN /
COMMIT / ROLLBACK issued by the code under test are the ONLY transaction
boundaries — exactly like op-sqlite's executeSync.
"""

import json
import math
import sqlite3
import sys


def decode_param(value):
    if isinstance(value, dict) and "$float" in value:
        tag = value["$float"]
        if tag == "nan":
            return math.nan
        if tag == "inf":
            return math.inf
        if tag == "-inf":
            return -math.inf
        raise ValueError("unknown $float tag %r" % tag)
    return value


def encode_value(value):
    if isinstance(value, float):
        if math.isnan(value):
            return {"$float": "nan"}
        if math.isinf(value):
            return {"$float": "inf" if value > 0 else "-inf"}
    if isinstance(value, bytes):
        return {"$blob": value.hex()}
    return value


def main():
    db_path, req_path, res_path = sys.argv[1], sys.argv[2], sys.argv[3]
    conn = sqlite3.connect(db_path, isolation_level=None)
    # Open order matters for FIFOs: the node side opens the request FIFO for
    # writing first, then the response FIFO for reading.
    with open(req_path, "r") as req, open(res_path, "w") as res:
        def reply(obj):
            res.write(json.dumps(obj))
            res.write("\n")
            res.flush()

        reply({"ok": True, "hello": sqlite3.sqlite_version})
        for line in req:
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            op = msg.get("op")
            if op == "close":
                conn.close()
                reply({"ok": True})
                return
            if op != "exec":
                reply({"ok": False, "error": "unknown op %r" % op})
                continue
            params = [decode_param(p) for p in msg.get("params") or []]
            try:
                cur = conn.execute(msg["sql"], params)
                if cur.description is None:
                    rows = []
                else:
                    cols = [d[0] for d in cur.description]
                    rows = [
                        {col: encode_value(val) for col, val in zip(cols, row)}
                        for row in cur.fetchall()
                    ]
                reply({"ok": True, "rows": rows})
            except sqlite3.Error as error:  # surface the exact sqlite text
                reply({"ok": False, "error": str(error)})
            except Exception as error:  # noqa: BLE001 - bridge must never die silently
                reply({"ok": False, "error": "%s: %s" % (type(error).__name__, error)})


if __name__ == "__main__":
    main()
