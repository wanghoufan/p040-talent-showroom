# Research / Official Baseline - 2026-10-02

## Conclusions

1. GitHub Spec Kit 当前模板仍采用 Constitution / Specification / Plan / Tasks 的 SDD 分层；SPEC 用户故事按优先级且可独立验收；Tasks 格式要求 task ID、可并行标记和 story label。
2. Capacitor 当前稳定 docs 为 v8；v9 位于 `next`/prerelease，因此本项目锁定 stable 8.x。
3. Capacitor 8 Android 对应 minSdk 24、compileSdk 36、targetSdk 36；Node 22+。
4. Google Play 自 2026-08-31 要求新应用和更新 target Android 16 / API 36+。
5. Android 官方推荐交互控件触控目标至少 48dp × 48dp。
6. Android 12+ 使用系统 SplashScreen；Capacitor 官方 `@capacitor/assets` 要求 icon source ≥1024²、splash source ≥2732²。
7. Android adaptive icon 按 108×108dp layer 设计，核心可视 mark 位于 66×66dp 安全区思路内，并应提供 monochrome layer 以支持 themed icons。
8. Android ACTION_SEND/intent-filter 是接收其他 App 分享文本/媒体的官方路径；不使用 `*/*` 泛接收。
9. Capacitor 8 `cap run android` 支持 `--live-reload`，ADB reverse 可让 USB 真机使用 localhost 开发服务。

## Official sources

- GitHub Spec Kit templates: https://github.com/github/spec-kit/tree/main/templates
- Capacitor v8 docs: https://capacitorjs.com/docs
- Capacitor Android: https://capacitorjs.com/docs/android
- Capacitor cap run: https://capacitorjs.com/docs/cli/commands/run
- Capacitor splash/icons: https://capacitorjs.com/docs/guides/splash-screens-and-icons
- Google Play target API: https://support.google.com/googleplay/android-developer/answer/11926878
- Android SplashScreen: https://developer.android.com/develop/ui/views/launch/splash-screen
- Android adaptive icons: https://developer.android.com/develop/ui/compose/system/icon_design_adaptive
- Android receive share: https://developer.android.com/develop/ui/compose/sharing/receive
- Android accessibility: https://developer.android.com/guide/topics/ui/accessibility/apps
