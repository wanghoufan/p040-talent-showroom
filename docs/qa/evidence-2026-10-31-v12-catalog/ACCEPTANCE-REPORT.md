# P040 V1.2：内置参考一键载入 + 沉浸练歌与地图抽屉（2026-10-31）

## 结论

原闭环不成立的两点已补上：

1. **不用再找文件**：练歌页打开后直接显示「本机已有《Papillon》参考候选 10 段（身份五项已核对一致）」，
   点「载入参考候选」即进工作室逐段核对。原计划包 `papillon-candidates.json` 缺 `schema`、`audioSha256`、
   `artistAliases`，会被 schema/hash 校验拒绝——现在服务端内置了同一份参考的结构信息（只有类型/秒数/标签，
   没有任何歌词正文），用户不需要转换文件。
2. **沉浸练歌 + 地图抽屉**：练歌页新增「沉浸练歌」（直链 `?immersive=1` 也可进）与「地图抽屉」；
   抽屉里复用同一个 `VocalStructureStudio`（波形拖动、播放位置打点、歌词行定界、改类型、整段循环、试听、保存）。
   **没有第二个 `<audio>`，没有改其它页面或底部 Tab。**

## 改动位置

先核对现状：仓库里**没有 V1.2 沉浸页**（`grep 沉浸` 只命中治理文档与工作室注释），练歌页是
`TalentDetailPage → VocalPracticePlayer`，结构编辑只有一个 `VocalStructureStudio` 弹层。
因此本轮在现有练歌组件内增量实现沉浸模式与抽屉，没有新建路由、没有改底部 Tab、没有第二个播放器。

| 文件 | 作用 |
|---|---|
| `server/vocal-structure/reference-catalog.mjs`（新） | 内置 Papillon 参考（10 段、2 段争议、3 个重复候选），只有结构信息 |
| `server/vocal-structure/service.mjs` | `listStructureReferences` / `setStructureReferenceFromCatalog`；载入前用当前曲目元数据 + 现算文件 SHA 复核五项 |
| `server/vocal-structure/routes.mjs` | `GET/POST /api/repertoire/:id/structure-draft/reference/catalog` |
| `src/lib/vocal/structure-api.ts` | `readReferenceCatalog` / `loadCatalogReference` |
| `src/lib/vocal/reference.ts` | `snapBoundaryToLyrics`（1.5 秒内吸附歌词行首） |
| `src/components/VocalStructureStudio.tsx` | 内置参考卡片、身份不匹配只显示原因、冲突一键「用参考 / 保留人工」、`presentation="drawer"` |
| `src/components/VocalPracticePlayer.tsx` | 参考横幅、一键载入、沉浸模式、地图抽屉 |
| `src/styles/vocal-practice.css` | 沉浸层、抽屉、参考卡片样式 |

## 实测结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 内置目录 + 身份 + 从零打点 + 路由路径 | `node --test tests/vocal-structure-catalog.test.mjs` | **8/8 PASS** |
| 真实音频波形（本机 ffmpeg 解码自造 WAV：1s 静音 / 1s 满幅 / 1s 半幅） | `node --test tests/vocal-structure-waveform.test.mjs` | **4/4 PASS** |
| 结构相关 node 定向回归 | `node --test tests/vocal-structure-reference.test.mjs tests/vocal-structure-map.test.mjs tests/vocal-structure-service.test.mjs tests/vocal-structure-legacy-boundary.test.mjs` | **61/61 PASS** |
| 界面定向（工作室/结构编辑/练歌/译文/结构单测/新沉浸用例） | `npx vitest run tests/browser/vocal-structure-studio.test.tsx tests/browser/vocal-structure-editor.test.tsx tests/browser/vocal-practice-player.test.tsx tests/browser/vocal-practice-translation.test.tsx tests/unit/vocal-structure.test.ts tests/browser/vocal-immersive-catalog.test.tsx` | **59/59 PASS（6 文件）** |
| 类型检查 | `npx tsc -b` | 通过 |
| Web 构建 | `npm run build` | 通过，`dist/index.html` SHA256 `c1fe6c650d0fdd0efa2b260d53bcb192e3419664b1756bf3b3065471bf9bfc48` |
| 同步 | `npx cap sync android` | 通过 |
| APK | `./gradlew assembleDebug`（JDK 21） | **1.1.11 (14)**；`app-debug.apk` 14,098,673 bytes，SHA256 `dea04be9236d555cb053d37d8ee6bb635a4ad94bdd8d16cb62625cac896be9e1` |
| 产物核对 | `aapt dump badging` + `unzip -p … assets/public/index.html \| shasum -a 256` | 包 `com.wanghoufan.dancelibrary.dev`、`versionCode=14`、`versionName=1.1.11`；包内 `index.html` 哈希与 `dist` 相同 |

### 关键实测值

- 载入后 10 段起点：`0, 12180, 34650, 57150, 68560, 79870, 103260, 125290, 136400, 147450`
  （9 段锚到用户 LRC 行，0ms 是文件起点，不是歌词锚点）。
- 争议 2 段：`U1@57150`、`U2@125290` 保持 `unknown` + `alternates=[refrain, verse]`，载入/展示/保存三阶段都不自动定型。
- 重复只作 `repeatCandidateOf`（B2→B1、A2→A1、B3→B1），保存后 `repeatOf` 为空。
- 身份拒绝：同名/不同歌手/版本/时长/文件 SHA 任一不符 → 409 `IDENTITY_MISMATCH`，`draft=null`。
- BABE 空结构（`sections=[]`）：播放位置打点 → 1 段，再打点切分 → 2 段，保存后全部 `manual`，没有冒出任何参考候选。
- 波形：静音段峰值全 0、满幅段 >0.95、半幅段 0.45–0.55；`durationMs≈3000`；缺文件报 `AUDIO_NOT_FOUND`，ffmpeg 缺失报 `FFMPEG_UNAVAILABLE`，不返回假波形。

## 真实限制（不得当成已通过）

1. **没有出声**：全程未播放任何音频。听感、边界是否落在真实乐句线、整段循环发声都未验。
2. **没有上手机**：未执行任何 adb；沉浸层在真机上的安全区、返回键、底栏遮挡、抽屉滚动手感未验；
   Android WebView 的 `<input type=file>` 仍未实测（该路径现在只是兜底）。
3. **没有做浏览器视觉走查**：只有组件测试断言，没有截图；字号/间距按现有 CSS 变量沿用，未做像素级检查。
4. **内置参考只有 Papillon 一首**：其它歌要么用参考文件（仍在），要么手动打点；没有为其它歌编造参考。
5. **只认这一份原曲**：内置参考声明的是本机曲目元数据指纹（时长 195036ms、SHA `057306bf…`）。
   换文件、重新编码、Live/Remaster 版本都会被拒（这是有意的，不是缺陷）。
6. **构建环境**：Capacitor 8 的 Gradle 需要 **JDK 21**；只设 JDK 17 会在
   `capacitor-filesystem` 的 toolchain 解析阶段失败（`languageVersion=21`）。本轮用
   `~/android-toolchain/jdk-21.0.12.1+1/Contents/Home` 构建。
7. **保存路径未加「已有手工结构须二次确认」硬闸门**：界面保存仍走曲目更新接口（`editLocally` → `/api/sync/operations`），
   「逐段确认」闸门只在草稿 apply 接口上；冲突条给了「用参考 / 保留人工」的一键选择，但不等同于逐段看过。
   这与上一轮 `ACCEPTANCE-REPORT.md` 的审慎声明一致，需产品决定是否加硬闸门。
8. **未跑全量回归、未重跑音频分析器、未改生产库/原 MP3/LRC、未动手机、未 commit/push。**

## 复现方式（只跑定向）

```bash
node --test tests/vocal-structure-catalog.test.mjs
node --test tests/vocal-structure-waveform.test.mjs
npx vitest run tests/browser/vocal-immersive-catalog.test.tsx tests/browser/vocal-structure-studio.test.tsx
```
