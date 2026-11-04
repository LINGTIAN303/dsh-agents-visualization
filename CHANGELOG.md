# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.8] - 2026-11-05

### 功能

- **设置导航图标**：DSH `0.2.2+` 下，设置左侧导航的「规则」行显示专属文档图标
  （选中态用品牌色），不再回退为通用齿轮。通过新增的 `settings.section.icon`
  槽注册；`slots.inject` 对未声明槽是等待语义，`0.2.1` 上挂起不安装、不报错，
  属于渐进增强。
- **「第三方集中」Tab 改名「第三方」**：名称更短，含义不变（英文本就是 Third-party）。
- **工具品牌图标**：「第三方」Tab 的子 Tab 与工具卡头部显示各工具的官方 Logo
  （Claude / OpenAI / Gemini / Cursor / TRAE / CodeBuddy / WorkBuddy / Windsurf / Cline /
  GitHub Copilot / Kiro / Qoder / Roo Code / Z.ai / 华为云 等品牌）。图标取自
  [@lobehub/icons](https://github.com/lobehub/lobe-icons) static-svg（MIT）并内联为
  路径数据 —— 无运行时 CDN 依赖；mono 图标跟随主题色，彩色变体保留官方品牌色，
  唯三使用渐变的 Gemini / CodeBuddy 用固定 `amv-grad-*` id 避免同页冲突
  （WorkBuddy 彩色版因含 mask+filter 结构改用其 mono 版）。
  无官方 Logo 的工具（Augment / CatPaw / JoyCode / AutoClaw / Hanako 等）用
  「品牌色圆角方块 + 工具名首字母」占位（Avatar 风格）；经探测 Dashboard Icons
  聚合站也无这些工具的独立图标。
- **编辑/预览全屏**：详情面板新增「全屏」控件，把编辑器或预览放大到设置页允许的
  最大区域（覆盖层带半透明遮罩，相当于清屏），专注浏览与编辑；再点一次或按
  `Esc` 退出。切换文件 / 工作区 / Tab 时自动退出全屏；「未创建」的空态不提供该控件。
- **资源管理器定位**：详情面板文件路径与全局级卡片路径旁新增「在资源管理器中显示」
  按钮，点击后由 Host 调起系统文件管理器定位到该文件（Windows `explorer /select`、
  macOS `open -R`、Linux `xdg-open` 父目录）。与 /read、/write 同一安全模型：
  客户端只发 key，路径由 Host 从允许集合解析，参数以数组传递不经 shell。
  文件未创建时按钮不出现。

### 兼容性

- `package.json` 的 `dsh.compatibility.dshReleases` 追加 `0.2.2-rc.1`（已实测：
  依赖的 `webServer.register` / `connection.requestRejection` / `workspaceRegistry` /
  slots / locale 接口均为增量式变更，无破坏）。

## [0.1.4] - 2026-11-04

### 功能

- **第三方集中改为子 Tab 切换**：不再纵向铺开全部工具。已安装工具各占一个子 Tab
  （带文件数与 token 汇总角标），「自定义工具」编辑区固定为最后一个子 Tab；
  未安装的工具仍折叠在底部「未检测到」块。切换工具即切换文件集合。
- **注入统计（四项指标）**：详情面板展示 占用字节 / 注入字节 / 已用字数 / token 占用；
  工具头部汇总「N 个文件 · 注入 X · ≈Y token」；编辑器底栏实时显示注入字节 / 字数 / token。
  - 注入字节口径：剥离 YAML frontmatter、去首尾空白后的有效内容 UTF-8 字节数
    （即工具真正注入上下文的部分）。
  - token 为启发式估算：CJK 字符 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token，仅供量级参考。
  - Host 在扫描阶段（跨工具共用检测的全文读取环节）顺手计算，不增加额外 IO。

## [0.1.2] - 2026-11-03

### 安全修复

- **`connection` 服务缺失时不再放行请求，改为 fail-closed（返回 503）。**
  此前会退化为「Host 头是回环地址就放行」。但 `Host` 由请求方自行填写，
  伪造 `Host: 127.0.0.1` 即可绕过；浏览器侧的 DNS rebinding 同样能把恶意域名
  解析到回环地址后发起请求。回环只说明「连到了本机」，不说明「调用方可信」。
  本插件能读写用户的全局规则文件，因此宁可不可用也不能接受未认证请求。
  感谢 [@polang233](https://github.com/polang233) 在 dshopen.org 收录审核中指出该问题。

- 移除随之失去用途的 `isLoopbackHostname` / `hostnameOf`。

## [0.1.1] - 2026-11-02

首个可发布版本。

### 功能

- 设置页新增「规则」入口，含 **项目级 / 全局级 / 第三方集中** 三个 Tab。
- 项目级：按 DSH 的真实加载规则展开项目根到 cwd 的目录链，列出 `AGENTS.md`、`CLAUDE.md` 及 `.local` 变体。
- 全局级：`~/.dsh/AGENTS.md` 与 `~/.agents/AGENTS.md`，并检测两者内容是否重复。
- 第三方集中：内置 25 个 AI 工具的用户级规则路径（Claude Code / Codex / Cursor / TRAE / CodeBuddy / WorkBuddy / OpenCode / Windsurf / Cline / Copilot / Kiro / Qoder / Augment / Roo 等）。
- Markdown 渲染态预览，支持标题、列表、表格、代码块、引用；`.mdc` 的 YAML frontmatter 自动剥离。
- 就地编辑：等宽编辑器、字节计数、未保存标记、`Ctrl/Cmd + S` 保存、冲突时可选覆盖或重新读取。
- 跨工具共用检测：内容完全相同的规则文件互相标注。
- 启发式发现：内置清单之外、目录内含 `AGENTS.md` 或 `rules/` 的工具会被自动扫出。
- 自定义工具：设置页内以 JSON 编辑并落盘到 `~/.dsh/agents-visualization.json`，编辑器预填模板。

### 修复

- 第三方「未创建」条目点击创建必然返回 `BAD_KEY`（白名单只收录已存在文件）。
- 并发保存时的丢更新：同一路径的「比对版本 → 落盘」改为串行执行。
- 读取期间文件大小变化时静默截断或读出 `\0` 填充。
- 恰好 1 MiB 的文件被误标为已截断。
- `connection` 服务缺失时安全栅栏静默降级，现改为显式告警。
- 共用检测用前 4000 字符当摘要导致误判，改为 SHA-256 全文哈希。
- 失效 `workspaceId` 静默回退到第一个工作区，可能把文件写进其它项目。
- 符号链接的规则文件被忽略；放开后增加 realpath 归属校验，指向主目录外的软链不纳入。
- 畸形 URL 返回 500 而非 400；`expectedVersion` 为空串时陷入 409 循环。

### 变更

- 设置入口名由「AGENTS.md」改为「规则」。
- 详情面板由页面底部统一渲染改为跟随文件块内联展开。
- 移除误导性的「路径待核实」徽章 —— 已安装工具的路径来源改为在工具名悬停提示中展示。
