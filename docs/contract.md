# Host ↔ Client 契约

> 本文件描述 `dsh-agents-visualization` 插件 Host 半边（`index.js`）与 Client 半边（`client.js`）之间的接口约定。
> 改动任一边时请同步更新本文件。
>
> 本文件只用于开发参考，**不随 npm 包发布**（不在 `package.json` 的 `files` 中）。

## 1. 作用域与需求边界

| 作用域 | 范围 |
|---|---|
| 项目级 | 所选工作区从项目根到 cwd 的目录链 |
| 全局级 | `~/.dsh/AGENTS.md` 与 `~/.agents/AGENTS.md` |
| 第三方集中 | 各 AI 工具的用户级规则文件（不含项目级），子 Tab 按工具切换 |

不提供删除操作（只做创建 / 编辑 / 修改），也不注册 Agent 工具。

## 2. DSH 真实的 AGENTS.md 加载规则

必须与 `@deepseek-ai/dsh-agent-instructions` 保持一致，否则页面展示的「哪个文件生效」会误导用户。

### 2.1 全局（user-global）

固定文件名 `AGENTS.md`，按优先级从高到低：

1. `<dshHome>/AGENTS.md` —— `dshHome` = `$DSH_HOME`（非空且非纯空白时）否则 `~/.dsh`
2. `<agentsHome>/AGENTS.md` —— `agentsHome` = `$DSH_AGENTS_HOME`（同上）否则 `~/.agents`

两个根**都会被遍历读取**，构成同一个候选组。若两份内容 trim 后相同，只渲染前一份（`~/.dsh` 那份胜出）。
对应实现参考 `dsh-agent-instructions/lib/index.js` 中的 `USER_GLOBAL_DIRECTORIES`、
`userGlobalRoots()` 与 `dedupInstructionFilesByCandidateGroup()`。

### 2.2 项目级

1. 从会话 cwd 向上找第一个含 `.git` 标记的目录 → `projectRoot`；找不到则 `projectRoot = cwd`
2. 目录链 `ancestorChain(projectRoot, cwd)`：从最宽（projectRoot）到最具体（cwd）
3. 链上每个目录按顺序尝试 4 个候选文件名：
   - 普通候选：`AGENTS.md`、`CLAUDE.md`
   - 本地候选：`AGENTS.local.md`、`CLAUDE.local.md`

设置页没有会话 cwd，因此 **cwd 取所选工作区的路径**。

## 3. HTTP 接口

- 前缀路由：`webServer.register({ kind: 'prefix', path: '/dsh-agents-visualization/api' })`
- 同源 `fetch('/dsh-agents-visualization/api/...')`，浏览器自动携带凭据，无需额外请求头
- 所有响应 `content-type: application/json; charset=utf-8`，`cache-control: no-store`
- 接口清单：`GET /state`、`GET /read`、`POST /write`、`GET|POST /user-tools`、`POST /reveal`

### 3.1 信任校验

每个请求先过 `ctx.get('connection')?.requestRejection(req)`：

- 返回 `undefined` → 放行
- 返回 `401` / `403` → 以该状态码结束
- `requestRejection` 自身抛错 → 按 `403` 处理（fail-closed）

`connection` 服务缺失（或没有 `requestRejection` 方法）时**拒绝全部请求**，返回 `503`。

这是刻意的 fail-closed 设计，不要改回「看 Host 是否回环就放行」：

- `Host` 由请求方自己填写，伪造 `Host: 127.0.0.1` 即可绕过；
- 浏览器侧的 DNS rebinding 也能把恶意域名解析到 `127.0.0.1` 后再发请求。

回环地址只说明「连到了本机」，不说明「调用方可信」。校验 Origin 与登录态只有 `connection` 能做，
没有它就没有可信依据 —— 这个接口能读写用户的全局规则文件，宁可不可用也不能被未认证请求打中。

`apply()` 会在启动时输出一条 warn 日志说明该状态。

### 3.2 `GET /state?workspaceId=<可选>`

```jsonc
{
  "ok": true,
  "homes": {
    "dsh":    { "path": "<绝对路径>", "display": "~/.dsh" },
    "agents": { "path": "<绝对路径>", "display": "~/.agents" }
  },
  "selectedWorkspaceId": "<id> | null",
  "workspaces": [
    { "id": "...", "title": "...", "path": "<绝对路径>", "projectRoot": "<绝对路径>" }
  ],
  "globals":   [ FileEntry, FileEntry ],   // 恰好 2 项，顺序固定 [dshHome, agentsHome]
  "project":   [ FileEntry, ... ],         // 目录链展开后的全部候选，从宽到具体
  "thirdParty": [ ToolEntry, ... ],        // 第三方工具及其规则文件
  "userTools": [ { id, name, vendor, targets } ],  // 用户自定义工具
  "userConfigPath": "~/.dsh/agents-visualization.json",
  "notes": ["..."]                          // 展示给用户的说明
}
```

`FileEntry`：

```jsonc
{
  "key": "global:dsh:AGENTS.md",
  "scope": "global" | "project" | "third",
  "group": "user-global" | "agents-global" | "<相对 projectRoot 的目录，根目录为 '.'>" | "<工具 id>",
  "name": "AGENTS.md",
  "displayPath": "~/.dsh/AGENTS.md",
  "exists": true,
  "size": 0,
  "mtime": "<ISO 8601> | null",
  "duplicateOf": null,        // 全局去重：与组内更靠前文件内容相同时填前者 key
  "sharedWith": []            // 第三方：内容与其它工具完全相同时列出它们
}
```

**排序**：先按目录（宽 → 具体），同目录内按 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`。
**不存在的候选也要返回**（`exists: false`），页面靠它提供「创建」入口。

`ToolEntry`：

```jsonc
{
  "id": "cursor",
  "name": "Cursor",
  "vendor": "Anysphere",
  "dir": "~/.cursor/rules",              // 多路径时是数组
  "installed": true,
  "confidence": "high" | "medium" | "low",
  "source": "<出处说明或 URL>",
  "note": null,                          // 工具状态说明（已取代 / 已停维护等）
  "discovered": false,                   // true = 由启发式扫描发现，非内置清单
  "totalRuleFiles": 12,                  // 目录内规则文件总数（可能大于 files.length）
  "files": [ FileEntry, ... ]
}
```

`FileEntry.stats`（注入统计，仅第三方且 exists 时有值，否则为 `null`）：

```jsonc
{
  "injectBytes": 1200,   // 剥 YAML frontmatter + trim 后的有效内容 UTF-8 字节数
  "chars": 320,          // 有效内容的字符数（按码点计，代理对不拆分）
  "tokens": 210          // 启发式估算：CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token
}
```

**注入口径**：`injectBytes` 代表工具真正注入上下文的有效内容（frontmatter 是元数据，
不会注入）。`tokens` 是启发式估算而非精确分词，仅供量级参考；客户端编辑器里的实时
统计（client.js `injectionStats`）与 Host 必须保持同一口径，否则详情与清单对不上。

### 3.3 `GET /read?workspaceId=<可选>&key=<key>`

```jsonc
{ "ok": true, "key": "…", "content": "…", "size": 0, "mtime": "…", "version": "…", "truncated": false }
```

- 文件不存在 → `404` + `code: "NOT_FOUND"`
- 超过 1 MiB（`1048576` 字节，与 DSH 的 `maxSourceBytes` 同值）→ 只返回前 1 MiB，`truncated: true`
- `version` = `${mtimeMs}-${size}`，用于乐观并发
- 读取以实际读到的字节数为准，不按 stat 的 size 预分配（避免文件在此间变化导致静默截断）

### 3.4 `POST /write`

```jsonc
{ "workspaceId": "<id> | null", "key": "…", "content": "…", "expectedVersion": "…" | null }
```

- `expectedVersion` 为空或非字符串 → 无条件写（用于创建或用户确认覆盖）
- `expectedVersion` 为非空字符串 → 写入前比对当前 `version`，不一致返回 `409` + `code: "STALE"`
- 内容超 1 MiB → `413` + `code: "TOO_LARGE"`
- 原子写：同目录临时文件 + `fsync` + rename，UTF-8 无 BOM，父目录不存在时递归创建
- **同一路径的「比对 → 落盘」串行执行**（`serializeByPath`），避免并发请求双双通过校验造成丢更新
- 目标不可写（`EISDIR` / `EPERM` / `EACCES`）→ `409` + `code: "STALE"`，附可读说明

成功：`{ "ok": true, "key": "…", "created": true, "version": "…", "size": 0, "mtime": "…" }`

### 3.5 `GET / POST /user-tools`

`GET` 返回：

```jsonc
{ "ok": true, "path": "~/.dsh/agents-visualization.json", "tools": [ … ], "error": null }
```

`POST` 整体替换，请求体 `{ "tools": [ … ] }`。逐条校验，任何一条非法即整体拒绝（不写入半残配置）。
校验项：`id` / `name` 非空、`id` 不含 `: / \`、`targets` 至少一项、`segments` 非空且无 `..` / 绝对路径、
`id` 不重复、条目数 ≤ 200。

### 3.6 `POST /reveal`

在系统文件资源管理器里定位文件。请求体 `{ "workspaceId": "<id> | null", "key": "…" }`。

- 与 /read、/write 同一安全模型：key 必须命中本次重算的允许集合，否则 `400 BAD_KEY`
- 文件不存在（未创建的候选）→ `404 NOT_FOUND`（「定位」一个不存在的文件没有意义）
- 平台行为：win32 `explorer /select,<file>`；darwin `open -R <file>`；linux `xdg-open <父目录>`
- spawn 参数为固定字面量 + 查表所得路径，数组传递不经 shell，无注入面
- Windows 上 `explorer /select` 在已有实例时以非零码退出属正常行为，不视为失败
- spawn 无法启动 → `500 INTERNAL`

成功：`{ "ok": true }`

### 3.7 错误响应统一形状

```jsonc
{ "ok": false, "code": "BAD_KEY" | "NOT_FOUND" | "STALE" | "TOO_LARGE" | "FORBIDDEN" | "INTERNAL", "error": "人类可读说明" }
```

| code | 状态码 |
|---|---|
| `BAD_KEY` / `FORBIDDEN` | 400 / 403 |
| `NOT_FOUND` | 404 |
| `STALE` | 409 |
| `TOO_LARGE` | 413 |
| `INTERNAL` | 500 |

## 4. key 编码与安全模型

key 只由 Host 生成与校验；**客户端永远不发送绝对路径**。

| 作用域 | 格式 |
|---|---|
| 全局 | `global:<dsh\|agents>:<name>` |
| 项目 | `project:<相对目录\|.>:<name>` |
| 第三方 | `third:<toolId>:<扁平化文件名>` |

注：第三方文件名中的 `/` 用 `~` 替代（如 `memory/MEMORY.md` → `memory~MEMORY.md`），
因为 key 中不允许出现路径分隔符。

**安全做法**：Host 每次请求都用「客户端给的 `workspaceId`」重新计算完整允许集合
（2 个全局 + 该工作区目录链上全部候选 + 全部第三方文件），然后按 key 查表。
表里没有 → `BAD_KEY`。即使 key 被伪造，也只可能命中重算出来的合法路径。

额外硬约束（任一不满足即 `BAD_KEY`）：

1. 第三方路径直接取扫描阶段探到的真实绝对路径，不做「由 key 重建路径」的推理
2. 第三方文件若为符号链接，解析后必须仍在用户主目录内（`isInsideHome`），否则不纳入
3. 项目路径必须落在已注册工作区的 `projectRoot` 之内（含相等）
4. 客户端显式传入的 `workspaceId` 若已失效（工作区被删除/改名）→ 直接 `400 BAD_KEY`，
   **不回退**到第一个工作区（否则会把文件写进用户没预期的项目）

## 5. 第三方工具注册表

形状：`{ id, name, vendor, targets[], confidence, source, note? }`。`targets` 支持三类：

| kind | 含义 | 额外字段 |
|---|---|---|
| `file` | 单个规则文件 | `alternates`：备选路径数组 |
| `dir` | 目录下多个 `.md` / `.mdc` | — |
| `glob` | 目录名含动态 id | `pattern`（内置为 RegExp，用户配置为字符串）/ `files` |

### 5.1 路径来源分级

| confidence | 含义 |
|---|---|
| `high` | 官方文档明确写明 |
| `medium` | 磁盘实测发现 / 社区资料，官方文档未直接说明 |
| `low` | 按同类工具惯例推测，未验证 |

界面上仅在 `low` 时显示徽章；已安装工具把来源放在工具名悬停提示中，
不对「已经扫到真实文件」的路径标注「待核实」（文件存在即已证实，标注只会误导）。

### 5.2 启发式发现

内置清单之外的工具，按以下规则在用户主目录下扫描：

- 只看以 `.` 开头的目录（AI 工具配置几乎都在 `~/.xxx`）
- 排除明显无关的目录（`.cache` / `.npm` / `.git` / `.vscode` 等）
- 目录内**直接**含 `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` 等特征文件，**或**含
  `rules/` / `user_rules/` / `steering/` / `instructions/` 子目录且其中有 `.md`
- `memory/` / `memories/` 里的文件**不算规则**（那是 AI 的运行记录），只在说明里提及数量

### 5.3 跨工具共用检测

按**全文 SHA-256** 比对（不能用前缀，否则只有末尾不同的两份会被误判为相同）。
内容完全相同的文件在 `sharedWith` 中互列，UI 上给行内角标与详情警告。

## 6. Client 结构

- 模块 id 必须等于包名；`inject: ['slots', 'locale']`
- `ctx.effect` 内 `ctx.locale.register('agents-md', { zh, en })`
- 注册 `settings.section`：`{ name: 'settings.section', id: 'agents-md', order: 8, label: () => t('nav') }`
- 注册 `settings.section.icon`（DSH `0.2.2+` 声明的槽）：`{ name: 'settings.section.icon',
  id: 'agents-md', label: 'agents-md icon' }`，组件收 `{ size, active }`，画内联 SVG 文档图标。
  经 `ctx.slots.inject` 注册 —— 该调用对未声明槽是**等待语义**（`0.2.1` 上挂起不安装、不报错），
  升级宿主后自动生效，属渐进增强，无需版本探测
- 三个 Tab：**项目级 / 全局级 / 第三方**
- 第三方 Tab 内部用**子 Tab 切换各 Agent 工具**：已安装工具各占一个子 Tab
  （头部带品牌 Logo、文件数与 token 汇总角标），「自定义工具」固定为最后一个子 Tab；
  未安装的工具仍折叠在底部「未检测到」块。切换工具即切换文件集合（选中态清空）
- 品牌 Logo：`BRAND_PATHS`（内联路径数据，来自 @lobehub/icons static-svg，MIT）+
  `TOOL_BRAND`（工具 id → 品牌键）渲染为 `BrandIcon(toolId, size)`；
  映射外的工具回退通用文件图标。渐变 defs（gemini / codebuddy）用固定 `amv-grad-*` id
- 详情面板内联在选中项下方展开（不堆在页面底部，否则用户点完看不到变化）
- 详情面板展示四项指标：**占用字节 / 注入字节 / 已用字数 / token 占用（估算）**；
  编辑器底栏实时显示注入字节 / 字数 / token（敲键盘即更新，与 Host 同口径）
- 详情面板操作区提供**全屏**：`fixed` 覆盖层（`.amv-fs`，z-index 1100 高于设置模态的 1000）
  渲染同一棵受控组件树（编辑器 / 预览与主区共享 state，双渲染无副作用），
  `Esc` 退出；`resetSelection`（切文件 / 工作区 / Tab）自动退出；「未创建」空态不提供
- 文件路径旁（详情面板 + 全局级卡片）提供**资源管理器定位**按钮（仅 exists 时渲染），
  `POST /reveal` 只发 key；卡片上的按钮 `stopPropagation` 避免触发选中
- 只用 `--dsw-alias-*` 主题 token 着色；不引入任何 Harness Client 包
- 图标用内联 SVG，禁止 emoji
- 所有可见文案走 `t()`，zh / en 两套字典

## 7. 已知限制

- 单文件上限 1 MiB，超出只读不写（避免写回时截断文件）
- 并发保护是**单进程内**按路径串行，多进程同时写仍可能冲突
- `version` 基于 `mtimeMs-size`，等长内容落在同一毫秒时会失去乐观并发语义
- 内置工具路径来自文档与实测，产品更新后可能变化；用户可用「自定义工具」覆盖
