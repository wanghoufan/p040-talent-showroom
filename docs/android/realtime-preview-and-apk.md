# Android 实时预览与 APK 预构建

## 1. Preflight

```bash
source "$HOME/android-toolchain/android-env.zsh" 2>/dev/null || true
java -version
printf 'ANDROID_HOME=%s\n' "$ANDROID_HOME"
adb version
adb devices -l
```

本项目要求 Java 21；共享环境文件若仍指向 Java 17，应在本次终端显式设置可用的 JDK 21，不修改用户 shell 配置。先检查端口占用，不关闭其他项目服务。真机固定 USB serial `IN9LZTAYV4UGU4JF`，将 `ANDROID_SERIAL` 设置为它。

## 2. USB real-time preview

```bash
npm run dev -- --host 127.0.0.1 --port 5173
HOST=127.0.0.1 PORT=8791 npm run server:dev
adb -s "$ANDROID_SERIAL" reverse tcp:5173 tcp:5173
adb -s "$ANDROID_SERIAL" reverse tcp:8791 tcp:8791
npx cap run android --target "$ANDROID_SERIAL" --live-reload --host 127.0.0.1 --port 5173
```

API 从 `HOST` / `PORT` 环境变量读取配置，不读取 `--host` / `--port` 参数。以上 live reload 仅用于开发预览；最终交付需重新 build/sync，移除 `server.url` 后用 bundled APK 验收。当前包与安装证据以 [HANDOFF](../handoff/HANDOFF.md) 为准。

如 `--target` ID 与 adb serial 不同，先 `npx cap run android --list` 映射；不要通过卸载 App“解决”。

## 3. Early installable APK

```bash
npm run build
npx cap sync android
cd android
./gradlew :app:assembleDebug
ls -lh app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
```

必须记录：build variant、APK exact path/size、debug signature、device package path。

## 4. Final buildability

```bash
./gradlew :app:assembleDebug
./gradlew :app:assembleRelease
```

未配置正式 keystore 时，release 产物只表示 buildability，不能称为“可发布签名 APK”。不得擅自创建/替换用户正式 signing key。
