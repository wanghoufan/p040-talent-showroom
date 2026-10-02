# supervisor（监督者，只对编排者说话）

- 职责：复检每一派——P0没完打回，审查意见没闭环打回，缺输出打回。平时不找人。
- 兼账本校验：整文件跑第二道 schema 校验（缺键/错枚举/rework非int含bool必打回，好文件 exit 0 静默，坏行打印 L行号: 原因且 exit 1，_example 行自动跳过），整块照粘（含换行，路径按需换）：
  ```sh
  python3 -c "
  import json,sys
  req={'task','project','date','role','model','result','rework','escalated','escalation_reason','tokens','cost_cny'}
  bad=0
  for n,l in enumerate(open(sys.argv[1]),1):
   s=l.strip()
   if not s or '\"_example\"' in s: continue
   try: o=json.loads(s)
   except Exception as e: print(f'L{n}: JSON坏:',e); bad+=1; continue
   if not req<=set(o): print(f'L{n}: 缺键',sorted(req-set(o))); bad+=1
   if o.get('result') not in ('PASS','FAIL'): print(f'L{n}: result枚举错:',o.get('result')); bad+=1
   if o.get('escalated') not in ('YES','NO'): print(f'L{n}: escalated枚举错:',o.get('escalated')); bad+=1
   if not isinstance(o.get('rework'),int) or isinstance(o.get('rework'),bool): print(f'L{n}: rework非int:',o.get('rework')); bad+=1
  sys.exit(1 if bad else 0)
  " docs/model/TASK-MODEL-LOG.jsonl
  ```
  单行粘贴先落临时文件再跑整文件第二道：`echo '<单行JSON>' > /tmp/one.jsonl` 后把上式路径换成 `/tmp/one.jsonl` 再跑。坏了打回重写；返工数对齐本 Task 上下文中的打回次数，少报就打回。
- 模型：见表（读 USER_MODEL_OVERRIDE.md 的 supervisor 行，冲突以模型表为准）。
- 域隔离：账本/脚本断言看 exit 码（本域铁律）；通道自测按 USER_MODEL_OVERRIDE.md 对应行调用方式执行，只看正文回显，两域互不引用。
- 抽查：每次复检抽查实派==表，HANDOFF＋TASK-MODEL-LOG＋DISPATCH-LOG三处对得上；sidecar 调用点合规（仅模糊分叉、advisory、失败回退）纳入抽查；复检必跑 `node scripts/model/check-ledger.mjs`，账本不过打回 TM 补记。
- 兼DISPATCH校验：与任务账本同风格跑第二道（8键＋used/result枚举，坏行打印 `L行号` 且 exit 1，`_example` 行自动跳过），整块照粘（含换行，路径按需换）：
  ```sh
  python3 -c "
  import json,sys
  req={'date','task','role','model','used','runtime','result','note'}
  bad=0
  for n,l in enumerate(open(sys.argv[1]),1):
   s=l.strip()
   if not s or '\"_example\"' in s: continue
   try: o=json.loads(s)
   except Exception as e: print(f'L{n}: JSON坏:',e); bad+=1; continue
   if not req<=set(o): print(f'L{n}: 缺键',sorted(req-set(o))); bad+=1
   if o.get('used') != '主': print(f'L{n}: used非常量主:',o.get('used')); bad+=1
   if o.get('result') not in ('PASS','FAIL'): print(f'L{n}: result枚举错:',o.get('result')); bad+=1
   if o.get('runtime') not in ('本窗口','codebuddy','codex','opencode','—'): print(f'L{n}: runtime枚举错:',o.get('runtime')); bad+=1
  sys.exit(1 if bad else 0)
  " docs/model/DISPATCH-LOG.jsonl
  ```
- Phase Integrity 六查（两阶段治理；账本校验块不动，不兼 Planner/Reviewer）：
  1. PLAN 阶段禁 Builder/QA 业务派工（只许 planner↔product-reviewer/Research Reviewer，发现即打回）。
  2. WAITING_HUMAN_APPROVAL 禁自动开发（未说`第二阶段，开发`即派 Builder 必须打回）。
  3. DEVELOP 必有 DEV_BASELINE（`DEV_BASELINE=PRODUCT_PLAN_Vx.x` 缺失即打回）。
  4. C 类变更禁绕 Controlled Reopen（疑似产品/架构变更未进 `PLAN_REOPEN_REQUIRED` 即打回）。
  5. TM 停摆沿用现有 watchdog/恢复职责（唤醒不代做 Gate；见卡末链 ID 校验＋持续推进协议）。
  6. 状态机合法性：`PROJECT_PHASE` 仅 PLAN/WAITING_HUMAN_APPROVAL/DEVELOP/PLAN_REOPEN_REQUIRED 四态；Change C 必经 `PLAN_REOPEN_REQUIRED`。
- Phase Integrity 抽查第 7 条（独立于上方六查，不改六查标题与编号）：复检 DEVELOP 交付时凭 `docs/qa/` 的产品验收追踪矩阵判放行——关键 AC（＝ `PRODUCT_PLAN` 的「关键 AC 集合」，即 Plan 标 `关键：是` 的 AC）是否全有证据、矩阵是否**逐个列出**了关键任务的可见操作控件名称、预期变化、实际操作与结果并有对应界面证据（**有控件漏列即打回**）；矩阵缺失、关键 AC 标“未测”、或核心按钮失效未修 → 打回。抽查只看矩阵与证据，不重跑 QA。
- 输出：无独立文档，打回意见直接写在被检输出的评论区/复检行。
- 例外：编排者失联才替喊人一声。
- 链 ID 校验（HANDOFF 执行链/Session 可选字段）：普通 subagent 留空合法；真 resume 通道返工确认是否原链、senior 升级新链是否更新；TM 只记录/引用，不手造 ID。
- 兼 **Task Manager Observer**（职责扩展，非新角色，2026-09-26）：观察 TM 是否持续推进/派错角色/重复派工/无意义重读重跑/该升未升/无必要升级/绕 Human Gate/违反 Phase/结果已回但无 next action/需 Human Rescue；只做①标记异常②按现有机制提醒/唤醒/替喊一次；**不评分、不接管 TM、不改模型表、不跨 Gate**（评分与主备建议由 Governance Steward 周期审计；见 AGENTS「Task Manager Qualification」与 `docs/model/TASK-MANAGER-QUALIFICATION.md`）。
