# USER_MODEL_OVERRIDE｜一句话切模型

| 角色 | 模型（精确ID，照抄执行） | 执行通道 | 备用模型 | 备用执行通道 | 调用方式 |
|---|---|---|---|---|---|
| task-manager | 开窗口时定 | 本窗口 | — | — | 本窗口subagent直派，按开窗口时模型执行 |
| supervisor | opencode-go/muse-spark-1.3-contributor | opencode | — | — | 派工基础设施走opencode直调：`opencode run -m opencode-go/muse-spark-1.3-contributor "任务"`；表内记全ID，禁本窗口代做 |
| builder | codebuddy/deepseek-v4.1-flash | codebuddy | codebuddy/glm-5.3-flash | codebuddy | `codebuddy --model deepseek-v4.1-flash --effort high -y -p "任务"`（`deepseek-flash` 别名，实为 `deepseek-v4.1-flash`，非交互必带`-y`，验成功只看正文）；表内记全ID，禁本窗口代做。**超时策略**：codebuddy 常 10 分钟超时，超时先查工作区落盘——已落盘直接验（不重派），未落盘续派或转备通道。限额停工→切 codebuddy/glm-5.3-flash `codebuddy --model glm-5.3-flash --effort high -y -p "任务"`（同形）；再限额→停派喊人。 |
| planner | codex/gpt-6-sol | codex | — | — | 派工基础设施走codex直调；CLI用短名`gpt-6-sol`：`codex exec -m "gpt-6-sol" --skip-git-repo-check "任务" </dev/null`；表内记全ID，禁本窗口代做 |
| code-reviewer | codebuddy/glm-5.3-flash | codebuddy | — | — | `codebuddy --model glm-5.3-flash --effort high -y -p "任务"`（非交互必带`-y`，验成功只看正文）；表内记全ID，禁本窗口代做 |
| qa | codex/gpt-6-luna | codex | — | — | 派工基础设施走codex直调；CLI用短名`gpt-6-luna`，**QA 专用解禁沙箱**：`codex exec -m "gpt-6-luna" -s danger-full-access --skip-git-repo-check "任务" </dev/null`（`-s danger-full-access`＝关闭沙箱、给完整访问权，用于解端口绑定/网络限制，实测可绑 127.0.0.1 端口；仅限 QA 场景，其他角色禁带；表内记全ID，禁本窗口代做）。普通QA（回归/校验/DoD）走 codex Luna；真机QA（adb/Expo）走本窗口 bash 直驱（开窗口模型），note 记分支，supervisor 不记偏离。 |
| product-reviewer | opencode/muse-spark-1.3-contributor-free | 本窗口 | — | — | 本窗口subagent直派 |
| experience-recorder | opencode-go/space-bunny-free | opencode | — | — | 派工基础设施走opencode直调：`opencode run -m opencode-go/space-bunny-free "任务"`（限时免费模型，真调已过）；表内记全ID，禁本窗口代做 |
| neat-freak | volcengine-plan/ark-code-latest | opencode | radeon-mimo/MiMo-V2.6-Flash | Claude Code | 派工基础设施走opencode直调：`opencode run -m volcengine-plan/ark-code-latest "任务"`（ark-code-latest模式，实际模型由控制台管理）；表内记全ID，禁本窗口代做 |
| senior-expert | codex/gpt-6.1-sol | codex | — | — | 派工基础设施走codex直调；CLI用短名`gpt-6.1-sol`：`codex exec -m "gpt-6.1-sol" --skip-git-repo-check "任务" </dev/null`；**需 Codex CLI ≥0.159.2**（0.155.1 拿不到该模型目录，会报 `not supported when using Codex with a ChatGPT account`）；表内记全ID，只接升级任务，禁本窗口代做 |
| db-admin | volcengine-plan/ark-code-latest | opencode | radeon-mimo/MiMo-V2.6-Flash | Claude Code | 派工基础设施走opencode直调：`opencode run -m volcengine-plan/ark-code-latest "任务"`（ark-code-latest模式，实际模型由控制台管理）；表内记全ID；工作区固定本机 000-alw-数据库管理专家仓，禁本窗口代做 |

<!-- 分工表版本：T24（2026-09-29，senior-expert 换 codex/gpt-6.1-sol，真调已过：需 Codex CLI ≥0.159.2，旧版 0.155.1 报 not supported；planner 仍 codex/gpt-6-sol 未动；其余不变；用户回退存档，模型忽略此行） -->
<!-- TM 资格测试候选（A/B，2026-09-26；真调已过）：opencode-go/deepseek-v4.1-flash 与 opencode-go/mimo-v2.6-flash，Runtime=opencode；TM 行仍"开窗口时定"，主备由用户批准后按"改表→真调→记账"处理（见 docs/model/TASK-MANAGER-QUALIFICATION.md）。 -->

## 模型调用档案（2026-09-26，集中记录，便于回溯）
> 本节汇总本项目调用过的所有模型精确 ID 与调用方式，供后续回溯。当前在用标 ✅，历史标 📦。

| # | 状态 | 模型精确 ID（provider/model） | 调用方式 | 用途/角色 | 真调证据 |
|---|---|---|---|---|---|
| 1 | ✅ | `opencode-go/muse-spark-1.3-contributor` | `opencode run -m opencode-go/muse-spark-1.3-contributor "任务"` | supervisor 主用 | — |
| 2 | ✅ | `codebuddy/deepseek-v4.1-flash` | `codebuddy --model deepseek-v4.1-flash --effort high -y -p "任务"` | builder 主用 | — |
| 3 | ✅ | `codex/gpt-6-sol` | `codex exec -m "gpt-6-sol" --skip-git-repo-check "任务" </dev/null` | planner/senior-expert | — |
| 4 | ✅ | `codebuddy/glm-5.3-flash` | `codebuddy --model glm-5.3-flash --effort high -y -p "任务"` | code-reviewer | — |
| 5 | ✅ | `codex/gpt-6-luna` | `codex exec -m "gpt-6-luna" -s danger-full-access --skip-git-repo-check "任务" </dev/null` | qa 普通 QA（解禁沙箱） | — |
| 6 | ✅ | `opencode/muse-spark-1.3-contributor-free` | 本窗口 subagent 直派 | product-reviewer | — |
| 7 | ✅ | `volcengine-plan/ark-code-latest` | `opencode run -m volcengine-plan/ark-code-latest "任务"` | db-admin/neat-freak 主用（ark-code-latest 模式，实际模型由控制台管理） | §56 pong exit 0 |
| 8 | ✅ | `radeon-mimo/MiMo-V2.6-Flash` | `opencode run -m radeon-mimo/MiMo-V2.6-Flash "任务"`（via Claude Code） | db-admin/neat-freak 备用 | §58 pong exit 0 |
| 9 | 📦 | `opencode-go/space-bunny-free` | `opencode run -m opencode-go/space-bunny-free "任务"` | experience-recorder/neat-freak（旧，已切 ark-code-latest） | — |
| 10 | 📦 | `opencode-go/deepseek-v4.1-flash` | `opencode run -m opencode-go/deepseek-v4.1-flash "任务"` | TM 资格候选 A | §53 回「ds ok」 |
| 11 | 📦 | `opencode-go/mimo-v2.6-flash` | `opencode run -m opencode-go/mimo-v2.6-flash "任务"` | TM 资格候选 B | §53 回「mimo ok」 |
| 12 | 📦 | `volcengine-plan/glm-5.3-flash` | `opencode run -m volcengine-plan/glm-5.3-flash "任务"` | 历史（builder 备链等） | §42 回「glm exact ok」 |
| 13 | 📦 | `volcengine-plan/deepseek-flash` | `opencode run -m volcengine-plan/deepseek-flash "任务"` | 历史（不支持 coding plan） | §56 真调失败 |
| 14 | 📦 | `volcengine-plan/deepseek-v4.1-flash` | — | 不存在（opencode 无此 ID） | §56 Model not found |
| 15 | 📦 | `opencode/mimo-v2.5-free` | `opencode run -m opencode/mimo-v2.5-free "任务"` | 历史（HANDOFF-2026-09-11 存档） | — |
| 16 | 📦 | `codex/gpt-5.6-terra` | `codex exec -m "gpt-5.6-terra" --skip-git-repo-check "任务" </dev/null>` | 历史 product-reviewer | — |
| 17 | 📦 | `codex/gpt-5.6-luna` | `codex exec -m "gpt-5.6-luna" --skip-git-repo-check "任务" </dev/null>` | 历史 qa/builder/product-reviewer | — |
| 18 | ✅ | `codex/gpt-6.1-sol` | `codex exec -m "gpt-6.1-sol" --skip-git-repo-check "任务" </dev/null>` | senior-expert（2026-09-29 由 gpt-6-sol 切） | 2026-09-29 真调 exit 0 回 pong（需 CLI ≥0.159.2） |

### 调用通道说明
- **本窗口**：opencode 内 subagent 直派（TM/product-reviewer）
- **opencode**：`opencode run -m <精确ID> "任务"`（supervisor/builder(旧)/db-admin/neat-freak(新)/experience-recorder(旧)）
- **codebuddy**：`codebuddy --model <精确ID> --effort high -y -p "任务"`（builder 主/code-reviewer）
- **codex**：`codex exec -m "<短名>" --skip-git-repo-check "任务" </dev/null>`（planner/senior-expert/qa）
- **Claude Code**：`radeon-mimo/MiMo-V2.6-Flash` 备用经 Claude Code 调用（policy.json `runner_bin: "claude"`）
- **ark-code-latest 模式**：分工表只写 `volcengine-plan/ark-code-latest`，实际模型由火山方舟控制台切换（3-5 分钟生效），不在配置中写具体模型 ID
