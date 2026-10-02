# webqa｜Web QA 标准通道 V1（基础设施规范位，真源）

> 2026-09-21 本机实测冻结：BROWSEROS_WEB_QA=READY／ORCA_INTEGRATION=READY。
> 中央 `~/.agents/rules/webqa.md` 为软链指本文件；改本文件即全侧同步。
> 散兵与 Orca 编排链用同一套；不另起 Browser Use／Steel／VM。

## 一、标准链路

- Web／PWA／localhost → BrowserOS neo → MCP → QA Agent。
- Orca 下实际桥接：Orca → OpenCode CLI → BrowserOS MCP（Orca 无原生 MCP 配置面，禁写成“原生已验证”）。
- dev 不自选、不更换浏览器 QA 基础设施。

## 二、后台静默

- BrowserOS 默认后台运行。
- 禁：无提示 `open -a` 弹前台；系统鼠标／键盘做常规 Web QA；碰用户主 Chrome；无故抢焦点。
- 需用户观察窗口时，先通知再显示。

## 三、动态端口

- MCP endpoint 禁硬编码（实测重启 9210→9211）。
- 每会话／连失败重读 `~/Library/Application Support/BrowserClaw/.browseros/config.json`，取 ports.server（MCP）／ports.cdp（CDP）。

## 四、操作口径

- initialize → notifications/initialized → tools/list → tabs new 取 session＋page，后续调用必带。
- run 报 -32600 类错转细粒度工具，不硬试。
- React 受控输入优先 type（fill 不稳不硬试），press Enter 提交。

## 五、认证安全

- Agent 不输密码／不动 MFA／不绕风控／不导密码／不导入主 Chrome Profile；登录异常人工做，认证失效需复登不算异常。
- Profile／Cookie／Token／认证状态禁入 Git。

## 六、QA 输出

- QA_RESULT=PASS／DEGRADED／FAIL＋对象／步骤／实际结果／失败步骤／截图日志／可复现性／是否需修复。
- PASS 放行，FAIL 回修回归；DEGRADED＝仅在核心用户路径可用、且非阻塞异常已明确记录时才可。

## 七、故障分层

- 业务页面 → Tool → MCP → Bridge → 编排链逐层定位。
- 禁单点故障自动装其他体系；结构性阻塞才由治理管理者定备用方案。

## 八、Gate

- 不新增 Gate；BrowserOS 只是执行工具，走原 开发→QA→修复→回归→MVP／V1 链。
