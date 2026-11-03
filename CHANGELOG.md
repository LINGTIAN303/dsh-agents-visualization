# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
