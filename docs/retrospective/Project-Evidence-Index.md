# 040 才艺展示厅 · 证据索引（Project-Evidence-Index）

> 本文件为 6 份复盘文档的证据锚点集，供主审抽样回查。每条结论标注：主张来源 / 原始证据（相对路径·Git hash·行号·日期）/ 证实状态。
> 取证铁律：推断一律标「推断」；Git 提交说明只证明"记录了此变更"，不能自动证明用户当时为何要求。

---

## A 路文档
- `A-Day1-Reconstruction-V1.0.md`（52,059 B / 601 行）— 第一轮独立取证（未读 B）
- `A-Day1-Reconstruction-V1.1.md`（80,994 B / 761 行）— 第二轮交叉修订，§12 交叉审查 + §13 终审素材包（418 字）

## B 路文档
- `B-Gap-RootCause-V1.0.md`（50,871 B / 523 行）— 第一轮独立取证（未读 A）
- `B-Gap-RootCause-V1.1.md`（74,804 B / 720 行）— 第二轮交叉修订，§12 交叉审查 + §10 终审摘要（335 字）

## 主开发者终审
- `Project-Lessons-V1.0.md` — 本判例中 9 条跨项目可复用教训 + 责任归属 + 体检表

---

## 关键结论证据锚点

| # | 结论 | 证据 | 证实状态 |
|---|---|---|---|
| E1 | 四态脱节：工作树 78 项未提交 / versionCode 15，HEAD 仅 9 / 1.1.6 | `git status --short`（现 78 项）；`android/app/build.gradle` HEAD 最高版本=9；`git rev-list HEAD -- android/app/build.gradle` 实测 3 提交（2ca15cd/784da4f/eb748f7） | 已证实（B V1.1 实测） |
| E2 | 已部署 APK 1.1.10/1.1.11 由未提交树构建 | B V1.0 G10 / A V1.1 升级为"可复现性治理失效" | 已证实 |
| E3 | "伴奏/音源分离"非 Day 1 硬约束，V3.2 才新指令不做 | Day1/001 无约束（`e198c06`）；`tool/run_separation.py` 已提交 `eb748f7`（V3.1 SDD:4/77 设计）；V3.2 SDD:3、HANDOFF:13 首次"不做" | 已证实（两路共识降级） |
| E4 | V2.1 五首为原创 demo，真实节目单五首从未出声 | V2.1 README:14-17、SDD:35/74；HANDOFF:10/18/21 | 已证实（A/B 共识） |
| E5 | 立项方向待定，首形态为"个人舞蹈曲库 V1.5" | `e198c06` README"具体产品方向待后续明确"；`2ca15cd` 舞蹈曲库 SDD | 已证实 |
| E6 | 多才艺分三次规格迭代叠加（001→002→003） | `specs/001`/`002`/`003` 规格分支；`003`"不硬改 DanceItem" | 已证实 |
| E7 | 002/003 无形式化 spec.md（B 独有贡献 G2） | `ls specs/002`、`ls specs/003` 实测无 `spec.md`（001 有） | 已证实 |
| E8 | UI 未真机验收，应统标"待验证"（B 独有贡献 G6） | HANDOFF V1.2"未上手机/未视觉走查"；001 spec SC-008 真机视觉检查未执行 | 已证实 |
| E9 | 译文"AI 出稿+人工抽审"边界（B 独有贡献 G8） | HANDOFF"语义未全面人工审核（首批292行改73行；第二批895行未逐句复核）"；`.env.example` API_KEY 空 | 已证实 |
| E10 | 生产库迁移挂起：代码依赖 0010、生产 DB 仍 0006 | HEAD migrations 0001–0008、工作树 0001–0010；生产库 0006（HANDOFF） | 已证实 |
| E11 | 应用名"舞蹈曲库"≠项目名"才艺展示厅"（B G14） | 立项 README 与首发应用名不一致 | 已证实 |

---

## 未证实 / 推断（诚实留痕）

- **A V1.1 子论断错误**：称"仅 `eb748f7` 触碰 build.gradle"，实测为 3 个提交。核心结论（HEAD 版本=9、更高版本来自脏树）正确，子论断不实——以 B V1.1 实测为准。
- **离线视频非目标被推翻（B G13）**：`a03dcdf` 推翻"离线视频非目标"；证据链见 B V1.1，归入 L4 边界会被推翻的佐证。
- **访客点歌验收未单列（B G15）**：归入 L2 验收口径细化，无独立硬证据标注，待后续项目验证。

---

## 复现命令（只读）

```bash
cd /Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅
git rev-list --count HEAD                 # 25 提交
git rev-list HEAD -- android/app/build.gradle   # 触碰 build.gradle 的 3 个提交
git status --short | wc -l                # 当前未提交项数（约 78）
git show eb748f7 -- android/app/build.gradle   # HEAD 最高版本 1.1.6/code9
ls specs/002 specs/003                    # 确认无 spec.md
```
