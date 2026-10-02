# Android 实时预览与 APK 预构建

## 1. Preflight

```bash
source "$HOME/android-toolchain/android-env.zsh" 2>/dev/null || true
java -version
printf 'ANDROID_HOME=%s\n' "$ANDROID_HOME"
adb version
adb devices -l
```

## 2. USB real-time preview

```bash
npm run dev -- --host 127.0.0.1 --port 5173
npm run server:dev -- --host 127.0.0.1 --port 8791
adb -s "$ANDROID_SERIAL" reverse tcp:5173 tcp:5173
adb -s "$ANDROID_SERIAL" reverse tcp:8791 tcp:8791
npx cap run android --target "$ANDROID_SERIAL" --live-reload --host 127.0.0.1 --port 5173
```

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
