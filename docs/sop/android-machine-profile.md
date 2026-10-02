# Android 本机环境基线

本文件只记录当前机器已经安装或已经验证的 Android 构建能力，不构成所有项目的版本要求。

## 1. 机器信息

    操作系统：macOS，具体版本待复测
    CPU 架构：待复测
    环境安装事实记录日期：2026-09-19
    构建、adb 真机连接和兼容性能力：待复测

不得记录真实用户名、完整私密项目路径、keystore 路径、密码、Token 或其他敏感信息。

## 2. 公共工具链路径

    工具链根目录：$HOME/android-toolchain
    Android SDK：$HOME/android-toolchain/sdk
    JAVA_HOME：$HOME/android-toolchain/jdk-17.0.20.1+1/Contents/Home
    ANDROID_HOME：$HOME/android-toolchain/sdk
    ANDROID_SDK_ROOT：$HOME/android-toolchain/sdk

ANDROID_HOME 与 ANDROID_SDK_ROOT 当前指向同一 SDK；后者仅作为兼容变量保留。

## 3. 已安装组件

    JDK：Temurin 17.0.20.1+1
    Android Platform：android-36
    Build Tools：35.0.0、36.0.0
    NDK：27.1.12297006
    CMake：3.22.1
    platform-tools：37.0.1
    Command-line Tools revision：待复测

已知现象：

    sdkmanager --list_installed：报告 SDK XML 版本兼容性警告，需后续复测。
    android sdk list：当前未成功执行，需先确认 android 命令来源、版本和官方 CLI 身份。

## 4. 待复测能力

以下能力尚未随本档案提供可复核的实测证据，列为待复测，不得视为当前已验证事实：

- 使用本机 JDK 和 Android SDK 执行 Gradle 构建；
- 使用 platform-tools / adb 成功连接真机。

重新确认前，其他项目必须根据自身 JDK、SDK、NDK、CMake 和 Gradle 要求独立判断。

本档案不代表已安装模拟器、system image、Flutter SDK 或所有 JDK 版本。

## 5. 兼容性样本规则

本文件不默认记录任何 Expo、React Native、Gradle、AGP、Kotlin、compileSdk、targetSdk 或 minSdk 项目版本。

如需记录兼容性样本，必须同时记录：

- 项目标识；
- Git revision；
- 验证日期；
- 执行命令；
- JDK、Gradle Wrapper、AGP、框架版本；
- compileSdk、targetSdk、minSdk、NDK、CMake；
- 产物路径和大小；
- 签名类型；
- 验证结论。

没有完整证据时，不得把项目版本写入本机环境档案。

## 6. 更新规则

更新前重新实测，并记录精确版本、实测命令、验证日期、构建结果和产物证据。

本文件不记录某个特定 APK 的签名结果，也不记录任何密钥、密码、Token 或私密项目路径。
