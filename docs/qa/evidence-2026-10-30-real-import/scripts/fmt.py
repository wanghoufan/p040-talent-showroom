import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_ERROR")
    raise SystemExit
rows = []
for j in d.get("jobs", []):
    rows.append("%s|%s|%s|%s|a=%s|err=%s" % (
        j.get("title", "")[:14], j.get("status"), j.get("importMode"),
        j.get("stage"), j.get("attempts"), j.get("lastErrorCode")))
print("  ".join(rows))
