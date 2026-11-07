# 地图按播放位置选段｜定向修复与出包核验

日期：2026-10-31（Asia/Shanghai）
范围：`src/components/VocalStructureStudio.tsx`（地图抽屉）、`tests/browser/vocal-structure-studio.test.tsx`、`docs/handoff/HANDOFF.md`
**未做**：未碰手机、未出声、未做伴奏/音源分离、未写正式结构库、未改原音频、未重启服务、未 commit/push、未跑全量回归。

## 1. 问题来源

`docs/qa/evidence-2026-10-31-prototype-phone-v114/QA_RESULT.md` §地图只读检查：
播放器停在约 0:49 的主歌，打开地图后默认选中的是「前奏 0:00–0:16」，与播放位置不一致。

## 2. 只读探针（确认问题，不写任何数据）

临时探针（`tests/browser/probe-map-autoselect.test.tsx`，跑完已删除，源码见 §7）：
抽屉形式渲染工作室，正式结构 = 前奏 0:00–0:16、A1 主歌 0:16–1:19，`audio.timeMs = 49000`、`playing=false`。

修复前输出（红）：

```text
PROBE pressed = 选择 前奏，前奏，0:00 到 0:16=true | 选择 A1，主歌，0:16 到 1:19=false
AssertionError: expected ... aria-pressed="false"  →  期望 A1 主歌 = true
```

结论：选中项与播放位置无关，来源是三处「取第一段」的硬编码：

| 位置（修复前） | 行为 |
|---|---|
| `selectedId` 初始化 `sections[0]?.id` | 首屏永远第一段 |
| 首次读取草稿后 `setSelectedId(next[0]?.id)` ×3 分支 | 读取完成又拉回第一段 |
| `switchSource` / `applyLoadedDraft` / `dropReference` / `restoreReference` 的 `[0]?.id` | 切数据同样拉回第一段 |

修复后同一探针：`Test Files 1 passed`。

## 3. 修复口径（只读显示，不改数据）

统一入口 `followPlayhead(next, { force })`（`VocalStructureStudio.tsx:127`）：

| 场景 | 行为 |
|---|---|
| 打开地图（含暂停、播放中） | 按打开那一刻的 `audio.timeMs` 用 `sectionAtTime`（半开区间 `[start,end)`）选段 |
| 读取草稿/参考返回后 | 按读取完成时的实际位置重选，不再退回第一段 |
| 显式切换数据（参考候选 ⇄ 正式结构、载入参考、放弃参考、取回上次参考） | `force` 重选；旧 id 在新数据集里不存在本来就是无效选中 |
| 位置不落在任何一段 | 保持「无选中」（不显示第 ②③ 步），并在段卡下方 `role="status"` 写明「当前播放位置 m:ss 不在任何一段内，没有自动选段；点上面任一段可手动选择。」 |
| 用户手动选段/点循环 | 打 `manualPick` 标记；之后播放位置推进不再覆盖（仅当该 id 仍存在于当前数据集时保留） |
| 无任何段落 | 仍走原空态文案，不编造选中，也不弹提示 |
| 自动选段副作用 | 只 `setSelectedId`；不 `seek`、不 `toggle`、不写草稿/正式结构 |

顺带一处防死路：`tapAtPlayhead` 在「位置无归属且无选中」时原本静默 return，现改为提示「当前位置不在任何一段里：先点上面选一段，再打点。」

## 4. 回归口径

- 原有用例 14 条全保留（参考候选展示、争议不定型、撤销、显式保存 manual、身份核验拒绝、重复关系、抽屉层次、试听、循环、删空后撤销、来源切换）。
- 新增 6 条行为用例（`tests/browser/vocal-structure-studio.test.tsx`）：
  1. 打开地图 0:49（暂停）→ A1 主歌选中、前奏未选、未调用 `seek`
  2. 播放中 0:40 打开 → 仍按位置选中 A1，未调用 `toggle`
  3. 手动选「前奏」后位置推进到 0:60 重渲染 → 仍选前奏，`seek` 只调 1 次（手动那一次）
  4. 位置在曲尾之外 → 无任何选中 + 「不在任何一段内」提示 + 不显示第 ②③ 步；手动点段后提示消失
  5. 载入参考候选（读草稿完成）→ 0:60 选 U1，不退回前奏，未 `seek`
  6. 结构为空 → 保留「这首歌还没有段落」空态，不出现选中与提示

结果：

```text
vocal-structure-studio            20/20
5 个定向文件合计（studio / practice-player / immersive-catalog / performance / unit-vocal-structure） 99/99
npx tsc -b                        exit 0
```

## 5. 出包核验（1.1.15 / versionCode 18，debug）

| 项 | 结果 |
|---|---|
| JDK | Temurin 21.0.12.1+1（`~/android-toolchain/jdk-21.0.12.1+1`），JDK17 未使用 |
| 构建 | `npm run build` → `npx cap sync android` → `./gradlew :app:assembleDebug`，`BUILD SUCCESSFUL` |
| aapt2 badging | `package name='com.wanghoufan.dancelibrary.dev' versionCode='18' versionName='1.1.15'` |
| APK | `android/app/build/outputs/apk/debug/app-debug.apk`，14,303,703 B |
| APK SHA-256 | `76a0b6791878cd19d77e2994e7942551a33604e442c32a813e904c687d0fd300` |
| 资源一致性 | `dist/` 205 个文件 ↔ `android/app/src/main/assets/public/` ↔ APK `assets/public/` 三方 SHA-256 逐一相同，**0 处不一致**（另 2 个 Capacitor 占位 `cordova.js`/`cordova_plugins.js` 各 0 B） |
| 新代码进包 | APK 内 `assets/public/assets/index-DkO7qQZh.js` 命中「没有自动选段」1 次 |
| 关键资源 | `index.html` 42942c29…、`index-DkO7qQZh.js` eacee088…、`index-CIXvh_pW.css` 006d696b…、`ScoreReader-DB3l_ak9.js` 82629049… |

明细见同目录 `assets-summary.json`，核验脚本 `verify-assets.mjs`（在项目根执行 `node <脚本>`）。

## 6. 未完成 / 边界（不称通过）

- **1.1.15(18) 未装真机**（本轮禁碰手机）：真机安装、关于页版本、WebView 实际选中观感仍 OPEN。
- 未在真机上复验「播放中打开地图」的时延（读草稿返回前显示正式结构、返回后按位置重选，理论上有一次可见切换）。
- 未跑全量回归；未测地图内的写操作（保存/打点/拖波形仍由既有用例覆盖，本轮未动其逻辑）。
- 未提交、未推送、未部署。

## 7. 探针源码（临时文件，已删除；需要复现时放回 `tests/browser/`）

```tsx
it('探针：0:49 打开地图应选中 A1 主歌', async () => {
  cacheRepertoire([item()]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/structure-waveform')) return new Response('{}', { status: 503 });
    if (String(url).endsWith('/structure-draft')) {
      return new Response(JSON.stringify({ draft: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }));
  render(<VocalStructureStudio presentation="drawer" item={item()} audio={{ timeMs: 49000, playing: false, seek: vi.fn(), toggle: vi.fn() }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);
  await waitFor(() => expect(within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button')).toHaveLength(2));
  const chips = within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button');
  console.log('PROBE pressed =', chips.map((chip) => `${chip.getAttribute('aria-label')}=${chip.getAttribute('aria-pressed')}`).join(' | '));
  expect(screen.getByRole('button', { name: /选择 A1，主歌/ })).toHaveAttribute('aria-pressed', 'true');
});
```

`item()` 的正式结构为 `前奏 0–16000`、`A1 主歌 16000–79000`，`durationMs=195036`。
