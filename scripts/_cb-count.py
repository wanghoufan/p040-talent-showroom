#!/usr/bin/env python3
"""读出可用 codebuddy 账号数。"""
import json, os, sys
f = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.wb-switch/accounts.json")
try:
    d = json.load(open(f, encoding="utf-8"))
    accs = d if isinstance(d, list) else d.get("accounts", [])
    print(len(accs))
except Exception:
    print(0)
