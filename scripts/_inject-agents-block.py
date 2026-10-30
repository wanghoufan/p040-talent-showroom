#!/usr/bin/env python3
# _inject-agents-block.py｜在老项目 AGENTS.md 注入/更新「ORCA 规则增量」区块（只增不删，幂等）
# 用法：python3 _inject-agents-block.py <AGENTS.md 路径> <STAMP> <RULES_VERSION>
# 规则：区块已存在 → 原地替换区块内容；不存在 → 插到首行标题之后。**绝不删除区块外的任何一行。**
import sys, io, re

path, stamp, version = sys.argv[1], sys.argv[2], sys.argv[3]
PKG_AGENTS = sys.argv[4] if len(sys.argv) > 4 else None
BEGIN = "<!-- ORCA-RULES-BLOCK:BEGIN -->"
END = "<!-- ORCA-RULES-BLOCK:END -->"

BLOCK = f"""{BEGIN}
<!-- 本区块由治理母版 scripts/sync-old-projects.sh 于 {stamp} 注入；只增不删，可重复运行原地更新。 -->
<!-- 本项目 AGENTS.md 的其余内容（项目专属规矩）保持原样，冲突时以本区块为准。 -->
## ORCA 规则增量（母版 {version}）

> 本区块只写**对外通用**的机制增量；派工细节见 `docs/roles/`，账本口径见下方条目。
{{BODY}}
{END}"""


def _load_body(pkg_agents):
    """区块正文从**老项目迁移模板包的 AGENTS.md** 自动提取，不再手写副本。

    2026-10-12 实测根因：正文原是硬编码在这份脚本里 ⇒ 母版新增机制（单智能体口径、
    Episode 防重复计分、升级触发机器校验等）时，改 AGENTS.md 不会改这份脚本，
    老项目**永远拿不到**新机制 —— STAMP 只是区块标题里的日期，不影响正文。
    这正是「规则改了但老项目没生效」的真正原因。改为单一真源，杜绝第二份副本漂移。
    """
    try:
        src = io.open(pkg_agents, encoding="utf-8").read()
    except OSError:
        return ""
    # 老项目包的 AGENTS.md 本身就是「只写对外通用机制增量」的精简版（母版完整版
    # 有大量母版本机专属章节：两包、对外概览、母版自检），整份取用即可。
    # 只去掉首行 H1 标题（区块自带标题）。
    body = re.sub(r"\A#\s+[^\n]*\n+", "", src).strip()
    return body


with io.open(path, "r", encoding="utf-8") as f:
    text = f.read()

# 区块正文一次算好，两个分支共用。
# 2026-10-12 实测：原先只在「已存在区块」分支里算 blk，「首次插入」分支直接引用
# 未定义的 blk ⇒ NameError。表现为部分项目报 BLOCK-UPDATED、部分静默失败。
body = _load_body(PKG_AGENTS) if PKG_AGENTS else ""
if not body:
    sys.exit("BLOCK-EMPTY: 未能从老项目包 AGENTS.md 提取区块正文，拒绝写入空区块（宁可不注入也不覆盖成空）")
blk = BLOCK.replace("{BODY}", body)

if BEGIN in text and END in text:
    new = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END), blk.replace("\\", "\\\\"), text, flags=re.S)
    if new == text:
        print("BLOCK-UNCHANGED")
    else:
        with io.open(path, "w", encoding="utf-8") as f:
            f.write(new)
        print("BLOCK-UPDATED")
else:
    lines = text.split("\n")
    # 插到首行标题之后；若无标题则插到最前
    idx = 1 if lines and lines[0].strip() else 0
    new = "\n".join(lines[:idx] + ["", blk, ""] + lines[idx:])
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(new)
    print("BLOCK-INSERTED")
