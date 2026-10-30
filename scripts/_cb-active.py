#!/usr/bin/env python3
"""读出 codebuddy 当前账号索引（供 codebuddy-auto.sh 调用）。"""
import json, os, sys
state = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.codebuddy-rotate/state.json")
s = json.load(open(state, encoding="utf-8")) if os.path.exists(state) else {}
print(s.get("active", 0))
