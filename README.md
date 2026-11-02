# 规则（AGENTS.md 可视化）

> DSH 插件：在「设置」里集中查看、创建与编辑 AGENTS.md 等 AI 规则文件。
> 中文为主，English section below.

## 这个插件解决什么问题

AI 编码工具的规则文件散落在各处：DSH 自己读 `~/.dsh/AGENTS.md` 和项目里的 `AGENTS.md`，而 Cursor、Claude Code、Codex、TRAE、CodeBuddy 等又各有各的位置。想改一条规则，得先想清楚「哪个文件生效」、再翻到对应目录、还得担心改错地方。

这个插件把三件事放进同一个设置页：

| Tab | 管什么 |
|---|---|
| **项目级** | 当前工作区从项目根到 cwd 的整条目录链（`AGENTS.md` / `CLAUDE.md` / `.local` 变体） |
| **全局级** | `~/.dsh/AGENTS.md` 与 `~/.agents/AGENTS.md` |
| **第三方集中** | 25+ 个 AI 工具的用户级规则文件 |

## 功能

- **真实反映 DSH 的加载规则** —— 与 `@deepseek-ai/dsh-agent-instructions` 同源：向上找 `.git` 定项目根、目录链展开、候选文件名按加载优先级排序，不是「猜一个路径」。
- **渲染态预览** —— Markdown 直接排版显示（标题 / 列表 / 表格 / 代码块），可切「源码」看原文。`.mdc` 的 YAML frontmatter 会自动剥离。
- **就地编辑** —— 等宽编辑器、字节计数、未保存标记、`Ctrl/Cmd + S` 保存。
- **并发保护** —— 文件被外部改过时提示冲突，让你选「覆盖」或「重新读取」，不会静默覆盖。
- **跨工具共用检测** —— 多个工具用同一份内容时标出「内容与 … 完全相同」，避免改一处以为全都改了。
- **自动发现** —— 内置清单之外的工具，只要目录里有 `AGENTS.md` 或 `rules/`，也会被扫出来。
- **可自定义** —— 设置页内直接编辑 JSON 追加工具，或点「填入模板」。

## 安装

```bash
# 通过 DSH 插件管理器（推荐）
dsh plugin --profile <你的 profile> add dsh-agents-visualization
```

或在 DSH 设置 → 内置插件 里搜索安装。

本地开发时用 link：

```bash
dsh plugin --profile <profile> add "link:C:\\path\\to\\dsh-agents-visualization"
```

## 使用

1. 打开 DSH → **设置** → 左侧 **「规则」**
2. 选 Tab，点任意文件即可就地展开详情
3. 要新建：在「未创建」分组里点对应条目 → 点「创建」
4. 第三方工具不在清单里？展开「自定义工具」，按模板改值后保存

### 自定义工具的配置格式

保存到 `~/.dsh/agents-visualization.json`：

```json
[
  {
    "id": "mytool",
    "name": "我的工具",
    "vendor": "自定义",
    "targets": [
      { "kind": "dir",  "segments": [".mytool", "rules"] },
      { "kind": "file", "segments": [".mytool", "AGENTS.md"] }
    ]
  }
]
```

`kind` 三种形态：

| kind | 含义 | 额外字段 |
|---|---|---|
| `file` | 单个规则文件 | `alternates`：备选路径数组 |
| `dir` | 目录下多个 `.md` / `.mdc` | — |
| `glob` | 目录名含动态 id（如 `user-<id>`） | `pattern`：匹配子目录名的正则字符串；`files`：固定文件名数组 |

`segments` 是相对用户主目录的路径分段，不接受绝对路径与 `..` 上跳。

## 支持的第三方工具

内置 25 个，常见的有：

Claude Code · Codex CLI · Gemini CLI · Cursor · TRAE / TRAE CN · CodeBuddy / CodeBuddy CN · WorkBuddy · OpenCode · Windsurf / Devin · Cline · GitHub Copilot · Kiro · Qoder / Qoder CN / QoderWork · Augment Code · Roo Code · ZCode · CodeArts Doer · CatPaw · AutoClaw · Hanako · JoyCode

> 每个工具的路径来源在界面上悬停工具名即可看到：**官方文档** / **本机磁盘实测** / **推测**。
> 内置清单来自官方文档与本机实测，但产品更新频繁，路径可能变化 —— 发现不对时用「自定义工具」覆盖。

## 安全说明

- 插件只在本机回环地址上提供 HTTP 接口，并经过 DSH 的 `connection.requestRejection` 信任校验。
- 前端只发送文件 key，**不发绝对路径**；服务端每次请求重新计算允许集合再按 key 查表，因此无法通过伪造 key 读到白名单之外的文件。
- 写入走「同目录临时文件 + rename」原子替换，UTF-8 无 BOM。
- 单文件上限 1 MiB；符号链接若指向用户主目录之外，不会纳入可编辑范围。

## 兼容性

- DSH `0.2.x`（在 `0.2.1-rc.5` 上验证）
- Node.js `>= 20`

## 许可

[MIT](./LICENSE)

---

# Rules (AGENTS.md Viewer)

> A DSH plugin that views, creates and edits AGENTS.md and other AI rule files from the Settings page.

## Why

AI coding tools scatter their rule files everywhere: DSH reads `~/.dsh/AGENTS.md` and project `AGENTS.md`, while Cursor, Claude Code, Codex, TRAE and CodeBuddy each use their own location. Editing one rule means figuring out *which* file actually takes effect, navigating to it, and hoping you did not break something else.

This plugin puts three scopes on one settings page:

| Tab | Scope |
|---|---|
| **Project** | The directory chain from project root down to cwd (`AGENTS.md` / `CLAUDE.md` / `.local` variants) |
| **Global** | `~/.dsh/AGENTS.md` and `~/.agents/AGENTS.md` |
| **Third-party** | User-level rule files of 25+ AI tools |

## Features

- **Mirrors how DSH really loads instructions** — same discovery as `@deepseek-ai/dsh-agent-instructions`: walk up to the `.git` marker, expand the ancestor chain, order candidates by loading priority.
- **Rendered preview** — Markdown is typeset (headings, lists, tables, code blocks); switch to "Source" for the raw text. YAML frontmatter in `.mdc` files is stripped automatically.
- **Inline editing** — monospace editor, byte counter, unsaved marker, `Ctrl/Cmd + S`.
- **Conflict protection** — when the file changed on disk you get a conflict prompt and choose to overwrite or reload.
- **Cross-tool duplicate detection** — flags files whose content is identical to another tool's, so you do not assume one edit propagates everywhere.
- **Auto-discovery** — tools outside the built-in list are picked up when their directory contains `AGENTS.md` or a `rules/` folder.
- **Customizable** — edit a JSON list in the settings page to add your own tools.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-agents-visualization
```

Or install it from DSH Settings → Plugins.

## Usage

1. DSH → **Settings** → **"Rules"** in the sidebar
2. Pick a tab; click any file to expand its detail inline
3. To create: open the "not created" group and click **Create**
4. Tool not listed? Expand **Custom tools**, edit the template, save

### Custom tool format

Persisted to `~/.dsh/agents-visualization.json`:

```json
[
  {
    "id": "mytool",
    "name": "My Tool",
    "vendor": "Custom",
    "targets": [
      { "kind": "dir",  "segments": [".mytool", "rules"] },
      { "kind": "file", "segments": [".mytool", "AGENTS.md"] }
    ]
  }
]
```

`kind` is one of `file` (single file, optional `alternates`), `dir` (many `.md` / `.mdc`), or `glob` (dynamic directory names, with `pattern` and `files`).

## Security

- The HTTP endpoint listens on loopback only and passes DSH's `connection.requestRejection` trust check.
- The browser sends **file keys, never absolute paths**; the server recomputes the allow-list on every request, so a forged key cannot reach arbitrary files.
- Writes are atomic (temp file + rename), UTF-8 without BOM, capped at 1 MiB per file.
- Symlinks pointing outside the user's home directory are excluded from the editable set.

## Compatibility

- DSH `0.2.x` (verified on `0.2.1-rc.5`)
- Node.js `>= 20`

## License

[MIT](./LICENSE)
