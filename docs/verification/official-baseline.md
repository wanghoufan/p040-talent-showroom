# Official Baseline (T002)

- 记录日期：2026-10-02
- 任务：T002 读取 `specs/001-personal-dance-library/research.md` 并记录实际安装的 Node/Capacitor/JDK/SDK/adb 版本；不得擅自升级共享 SDK。
- 来源：`specs/001-personal-dance-library/research.md`（Capacitor 8 stable、Android API 36、Node 22+、48dp、System SplashScreen、adaptive icon）。

## 本机实际版本（本轮实测）

| 组件 | 实际值 | 命令/位置 |
|---|---|---|
| Node.js | `v24.19.0`（满足 research.md 的 Node 22+） | `node -v` |
| npm | `11.17.0` | `npm -v` |
| JDK | Temurin `17.0.20.1+1` | `java -version` / `JAVA_HOME=$HOME/android-toolchain/jdk-17.0.20.1+1/Contents/Home` |
| Android SDK | `$HOME/android-toolchain/sdk`（`ANDROID_HOME`） | `echo $ANDROID_HOME` |
| SDK Platform | `android-36`（另有 34/35 已装，未改动） | `ls $ANDROID_HOME/platforms` |
| Build Tools | `36.0.0`（另有 34/35 已装，未改动） | `ls $ANDROID_HOME/build-tools` |
| platform-tools / adb | `37.0.1` | `adb version`（`/opt/homebrew/bin/adb`） |
| NDK | `27.1.12297006`（未使用于 Capacitor 壳） | `ls $ANDROID_HOME/ndk` |
| command-line tools | `latest` | `ls $ANDROID_HOME/cmdline-tools` |
| 全局 Gradle | 未安装（**必须使用项目自带 Gradle Wrapper**） | `which gradle` → not found |

## 计划锁定基线（来自 plan.md / research.md）

- Capacitor **8.x stable**（不用 9 prerelease）；Node 22+。
- Android：`minSdk 24 / compileSdk 36 / targetSdk 36`。
- 触控目标 ≥ 48dp；Android 12+ 使用系统 SplashScreen；adaptive icon（foreground/background/monochrome）。
- `@capacitor/assets` 要求 icon 源 ≥1024²、splash 源 ≥2732²。

## 变更声明

- 本轮**未升级/未删除**任何共享 SDK、JDK、Build Tools 或 Gradle 缓存。
- 计划要求的 SDK Platform 36 与 Build Tools 36.0.0 本机已存在，无需补装。

## 结论

本机环境满足 plan.md 所锁定的 Capacitor 8 + API 36 + Node 22+ 基线；Gradle 需由项目自带 Wrapper 提供。
