#!/usr/bin/env python3
"""切换 codebuddy 当前账号（供 codebuddy-auto.sh 调用）。只改 active 指针，不碰凭据本身。"""
import json, os, sys, time

acc_file = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.wb-switch/accounts.json")
state = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/.codebuddy-rotate/state.json")
idx = int(sys.argv[3]) if len(sys.argv) > 3 else 0

d = json.load(open(acc_file, encoding="utf-8"))
accs = d if isinstance(d, list) else d.get("accounts", [])
if not accs:
    sys.exit(0)
idx %= len(accs)
s = json.load(open(state, encoding="utf-8")) if os.path.exists(state) else {}
s["active"] = idx
s["activeAccountId"] = accs[idx].get("id")
s["updatedAt"] = int(time.time() * 1000)
json.dump(s, open(state, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
print(idx)
