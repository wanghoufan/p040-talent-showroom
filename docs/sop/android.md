# Android 本地编译与共享工具链接入规范

## 1. 适用范围与边界

适用于 Expo / React Native、Capacitor、原生 Android 及其他基于 Gradle 的 Android 项目。

本机可以共享 JDK、Android SDK、SDK Platform、Build Tools、NDK、CMake、platform-tools 及 Gradle 缓存。项目必须独立维护 Gradle Wrapper、AGP、Kotlin、compileSdk、targetSdk、minSdk、NDK/CMake 配置、Node/Expo/React Native/Capacitor 依赖、包名、版本号和签名配置。

不得把完整 SDK、JDK 或 Gradle 缓存复制进项目。

## 2. SDK 与 Java 环境

默认工具链根目录：

    ANDROID_TOOLCHAIN_ROOT="${ANDROID_TOOLCHAIN_ROOT:-$HOME/android-toolchain}"

ANDROID_HOME 是 Android SDK 目录的推荐环境变量。ANDROID_SDK_ROOT 已废弃；如为兼容旧工具而保留，必须与 ANDROID_HOME 指向同一 SDK，不能指向不同目录。

终端运行 Gradle 时，Java 通常由 JAVA_HOME、PATH 中的 java，或项目/Gradle 参数决定。Android Studio 触发 Gradle 时可能使用 IDE 的 Gradle JDK 设置，不一定继承终端 JAVA_HOME。建议二者使用同一版本，但不得假定仅设置 JAVA_HOME 就会改变 IDE 的 Gradle JDK。

推荐由用户级文件设置环境：

    $ANDROID_TOOLCHAIN_ROOT/android-env.zsh

该文件必须可重复 source、不得重复追加 PATH，路径缺失时只告警，不阻断 shell。

生效范围：

- macOS/Linux 交互式非 login shell：通常读取 ~/.zshrc 或对应交互配置。
- macOS/Linux 交互式 login shell：通常读取 ~/.zprofile、~/.bash_profile 等。
- 非交互式 shell / CI：必须显式 source 或设置 CI 环境变量。
- GUI 启动的 IDE：必须检查 IDE 的 JDK、SDK 和环境配置，不得假定继承 ~/.zshrc。
- Windows：使用系统环境变量、PowerShell/CMD 和 gradlew.bat，不能直接套用 zsh 示例。

未经用户明确批准，不修改 ~/.zshrc、~/.zprofile 或 IDE 设置。

## 3. 构建前检查

先识别项目类型和真实入口，再读取项目实际要求：JDK、Gradle、AGP、compileSdk、targetSdk、minSdk、Build Tools、NDK 和 CMake。不得因为本机已有某版本而强制项目升级。

至少检查：

    echo "$JAVA_HOME"
    echo "$ANDROID_HOME"
    java -version
    which adb

SDK 管理工具检查必须显式指定 SDK，并且不得吞掉错误：

    if command -v sdkmanager >/dev/null 2>&1; then
      SDKMANAGER="$(command -v sdkmanager)"
      "$SDKMANAGER" --sdk_root="${ANDROID_HOME:?}" --list_installed
    else
      echo "未找到 sdkmanager"
    fi

若存在 android 命令，不得直接执行 android sdk list。先检查其实际路径、版本、帮助信息、来源和是否使用当前 ANDROID_HOME；只有确认是官方 Android CLI 且命令格式匹配当期官方文档后，才执行查询。

当前官方文档处于 sdkmanager 向 Android CLI 迁移的过渡状态。新环境参考当期官方文档，现有机器以本机实测和构建结果为准。

## 4. Gradle Wrapper

优先使用项目自带 Wrapper，不依赖系统全局 Gradle：

    ./gradlew <task>

普通原生 Android、纯 React Native 和 Capacitor 项目应提交完整 Wrapper 文件集：

    gradlew
    gradlew.bat
    gradle/wrapper/gradle-wrapper.jar
    gradle/wrapper/gradle-wrapper.properties

升级 Wrapper 使用官方 Wrapper 方式。升级后检查 distributionUrl、Wrapper JAR、官方 SHA-256 和 distributionSha256Sum。不得把用户名、密码或 Token 写入 Wrapper URL。

Expo CNG 项目若忽略 android/，Wrapper 是否进入仓库取决于项目的 CNG 策略；不得假定被忽略的 android/ 中的 Wrapper 会永久存在。

## 5. Expo CNG 与三种构建流程

任何 expo prebuild 都是写入项目的操作。它可能生成或更新 android/、ios/ 原生目录，也可能调整 package.json 的 scripts/dependencies。

除非用户明确要求生成或更新原生目录，否则不得执行任何 expo prebuild。

如果用户明确要求生成原生目录，执行前必须检查 Git 状态、CNG 策略、android/ 和 ios/ 是否被忽略、config plugin、原生手工修改、package.json 和 lockfile。执行后检查 Git diff、package.json、lockfile 和生成目录。

如果 android/ 不存在：

仅在用户明确要求生成或更新 Android 原生目录后，才可执行：

    npx expo prebuild -p android

如果 android/ 已存在，不得无条件执行：

    npx expo prebuild --clean

--clean 会删除并重建原生目录，属于更高风险操作，必须单独征得用户确认。

三种流程必须区分：

1. Expo CLI 本地开发构建：

       npx expo run:android

2. 已有原生目录的直接 Gradle 任务：

       cd android
       ./gradlew :app:assembleRelease

3. EAS 本地构建：

       eas build --platform android --local

EAS local 是在本机执行接近 EAS 的流程，不等同普通 Gradle。eas.json 的部分工具版本字段、缓存和 Secret 环境变量存在本地限制，执行前读取当期 Expo 官方说明。

## 6. SDK、Build Tools、NDK 和 CMake

JDK、Android SDK、SDK Platform、Build Tools、NDK 和 CMake 是可安装在本机、供多个项目共享的机器级组件。

具体版本由项目的 compileSdk、targetSdk、minSdk、buildToolsVersion（如明确指定）、ndkVersion、CMake 配置和 AGP 兼容默认值决定。Build Tools 优先使用项目和 AGP 的默认选择，只有项目明确声明或构建错误明确要求时才补装指定版本。

NDK 和 CMake 可在同一 SDK 下并存多个版本。缺少组件时先报告组件、版本、下载量、目标 SDK 路径、license 影响和对其他项目的影响，再按授权补装。

不得因为发现多个 SDK 就直接删除其中任何一个。

## 7. 签名与发布

必须区分：

- debug key：本地调试和测试，不能用于正式发布；
- upload key：开发者签名上传到 Google Play 的 APK/AAB，必须由开发者保管；
- Play app signing key：启用 Play App Signing 后由 Google 管理并用于最终分发；
- EAS credentials：由 EAS 项目和构建配置管理，不能与上述密钥混为一谈。

使用 Play App Signing 时，开发者用 upload key 签名上传 AAB，Google 管理 app signing key 并签署最终分发 APK。开发者不需要直接保管 Google 托管的 app signing key。

release 构建不等于正式发布包。发布前必须检查 release 签名、包名、版本号、keystore 安全和是否误用 signingConfigs.debug。keystore、密码和 Token 不得进入 Git。

## 8. 真机、验证与高风险操作

每 session 真机 QA 前先过能力预检（scan→deps→preflight→smoke），预检不过不进正式，不计入账本；真机直驱走本窗口 bash（codex 沙箱必 BLOCKED），Maestro 为备用通道，scrcpy 只看屏。
多设备在线时指定：

    export ANDROID_SERIAL=<设备序列号>

遇到签名不一致时先解释原因，不得擅自卸载正式应用。

必须先征得用户确认的操作：

- 修改 ~/.zshrc、~/.zprofile 或 IDE 设置；
- 删除 SDK、JDK、安装包或 Gradle 缓存；
- 执行任何 expo prebuild，除非用户明确要求生成或更新原生目录；
- 执行 expo prebuild --clean；该操作还必须单独确认，因为它会删除并重建原生目录；
- 修改正式签名或 keystore；
- 删除设备中的应用；
- Git commit 或 Git push。

构建后必须确认工具链、Gradle 任务和产物真实存在，不能只报告 BUILD SUCCESSFUL。交付报告至少包含项目类型、工具链版本、执行命令、构建变体、产物路径和大小、签名类型、新增下载、风险及后续建议。CI 云端打包仅为备用，默认本地出包（`android/app/build/outputs/`），未附本地产物路径+大小+签名类型视为未交付，supervisor 打回。

## 9. 机器档案边界

本规范只引用机器档案中的已安装能力，不把机器档案中的项目版本称为所有项目的通用基线。新项目必须读取自身版本要求，再与机器档案比较。
