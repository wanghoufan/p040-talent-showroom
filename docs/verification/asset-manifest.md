# Asset / Prototype Manifest (T004, T005)

- 记录日期：2026-10-02
- 命令：`shasum -a 256 <file>`；尺寸：`sips -g pixelWidth -g pixelHeight <file>`
- 这些资源是开发期视觉 SSOT；原型中的示例封面/人物**不打包进 App**。

## T004 — approved UI prototypes（视觉 SSOT）

| 文件 | 存在 | 尺寸 (px) | sha256 |
|---|---|---|---|
| `reference/ui/prototype-dark-approved.png` | ✅ | 1672 × 941 | `80f11db7cabe314d0b33c29734c3b22700d5bc09276041f34695c11fa8c2aec3` |
| `reference/ui/prototype-light-approved.png` | ✅ | 1536 × 1024 | `e1f791ba103a4715a842bb478c8930c0fb39e8b701607d2e9c64b3edb2448a27` |
| `reference/ui/launch-screen-preview-dark.png` | ✅ | 1080 × 2400 | `49dd892484e3d577d25164396eb54d7bfefc763a4caf49c6a146ae209e4cd3de` |

结论：三张 approved 原型均存在，sha256 已登记，开发时直接作为视觉 SSOT。

## T005 — app icon / splash 源资源

| 文件 | 存在 | 尺寸 (px) | 要求 | 结论 | sha256 |
|---|---|---|---|---|---|
| `assets/app-icon-master.png` | ✅ | 1024 × 1024 | icon 源 ≥ 1024² | 达标（=1024） | `c7b88a64ea05455b5ffd1d0c7c0be037cd97dca4f2906ab4eaf9decf7c584bed` |
| `assets/splash.png` | ✅ | 2732 × 2732 | splash 源 ≥ 2732² | 达标（=2732） | `4e8bbb8ca1159872a928d6233c3c77f19bc37f95733d4ad8a60cde6a1773eef2` |
| `assets/splash-dark.png` | ✅ | 2732 × 2732 | splash 源 ≥ 2732² | 达标（=2732） | `67d717ca37bea081fd0b324081e271ef39e4602bfb321cd43ed21055c1cd507d` |

`@capacitor/assets` 安装版本与实际生成结果见 `docs/verification/android-preflight.md` 与 `docs/verification/foundation.md`（T012）。

结论：三张 master 资源均存在且满足 `@capacitor/assets` 的最小尺寸要求，可作为 T012 生成 Android icon/splash 的输入。
