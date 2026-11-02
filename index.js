/**
 * dsh-agents-visualization —— Host 半边实现。
 *
 * 职责：在 `/dsh-agents-visualization/api` 前缀上提供三个只面向本地设置页的接口：
 *   · GET  /state  —— 全局根 + 工作区列表 + 目录链上的全部候选（含缺失项）
 *   · GET  /read   —— 按 key 读取一个候选（1 MiB 截断）
 *   · POST /write  —— 按 key 原子写入（乐观并发校验）
 *
 * 契约唯一真相：docs/contract.md。
 * 路径解析规则与 `@deepseek-ai/dsh-home-paths` 逐字对齐（resolveDshHome / resolveAgentsHome /
 * dshHomeDisplay / agentsHomeDisplay），保证页面展示的根就是 DSH 真正会读取的根。
 *
 * 安全模型（见契约 §3）：
 *   客户端只发 key，永远不发绝对路径。Host 每次请求都用「客户端给的 workspaceId」重算完整
 *   允许集合（2 个全局 + 该工作区目录链 × 4 个候选），再按 key 查表；表里没有 → BAD_KEY。
 *   因此即使 key 被伪造，也只可能命中重算出来的合法路径，无法穿越到任意文件。
 */

import { createHash } from 'node:crypto'
import { mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 插件名：必须与包名一致，DSH 用它在日志与诊断里标识本插件。 */
const PLUGIN_NAME = 'dsh-agents-visualization'

/** 前缀路由。请求到达 handler 时 req.url 仍带此前缀（见文件末尾的路由匹配说明）。 */
const API_PREFIX = '/dsh-agents-visualization/api'

/** 单文件字节上限：与 DSH 的 maxSourceBytes 默认值同值（1 MiB）。 */
const MAX_CONTENT_BYTES = 1_048_576

/** 请求体上限：正文上限 + JSON 结构开销。超出直接 413，避免无上限缓冲内存。 */
const MAX_BODY_BYTES = MAX_CONTENT_BYTES + 262_144

/** 全局级固定文件名：DSH 的 user-global 作用域只认 AGENTS.md。 */
const GLOBAL_FILE = 'AGENTS.md'

/** 普通候选（AGENTS.md / CLAUDE.md），顺序即 DSH 的加载优先级。 */
const BASE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']

/** 本地覆盖候选，在同一目录内排在普通候选之后加载。 */
const LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']

/** 项目级候选：同目录内按此顺序探测（与 DSH 的 candidate 顺序一致）。 */
const PROJECT_CANDIDATES = [...BASE_CANDIDATES, ...LOCAL_CANDIDATES]

/** 项目根标记：从 cwd 向上找第一个含该条目的目录。 */
const ROOT_MARKER = '.git'

// ============================================================================
// 第三方智能体工具的全局规则文件注册表（「第三方集中」Tab 的数据源）
// ============================================================================
//
// 每一项描述「一个工具的用户级（全局）规则文件/目录在哪里」。
// `segments` 是相对用户主目录的路径分段，避免硬编码盘符与用户名。
// `kind`：
//   · 'file'  —— 单个文件（如 ~/.claude/CLAUDE.md）
//   · 'dir'   —— 目录下的多个规则文件（如 ~/.codebuddy/rules/*.mdc），由扫描函数展开
// `confidence`：high = 官方文档明确写明；medium = 官方仓库/社区一致但非文档正文。
// `source`：出处 URL，便于日后核对（离线不请求，仅作注释留存）。
//
// 注意：这些路径只用于「用户级」规则。项目级规则跟随具体项目，不属于本 Tab。
const THIRD_PARTY_TOOLS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    // 两层用户级：CLAUDE.md 是用户记忆，rules/ 是拆分的主题规则
    targets: [
      { kind: 'file', segments: ['.claude', 'CLAUDE.md'] },
      { kind: 'dir', segments: ['.claude', 'rules'] },
    ],
    confidence: 'high',
    source: 'https://code.claude.com/docs/en/memory',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    // AGENTS.override.md 存在时优先于 AGENTS.md，两个都要露出
    targets: [{ kind: 'file', segments: ['.codex', 'AGENTS.md'], alternates: [['.codex', 'AGENTS.override.md']] }],
    confidence: 'high',
    source: 'https://developers.openai.com/codex/guides/agents-md',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    targets: [{ kind: 'file', segments: ['.gemini', 'GEMINI.md'] }],
    note: '已被 Antigravity CLI 取代，旧路径仍有效',
    confidence: 'high',
    source: 'https://geminicli.com/docs/cli/gemini-md/',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    // 只有 ~/.cursor/rules 是本地文件；账户级 User Rules 存在云端，无文件可编辑
    targets: [{ kind: 'dir', segments: ['.cursor', 'rules'] }],
    note: '账户级 User Rules 存于 Cursor 云端，本地无文件，需在 Cursor 设置里改',
    confidence: 'high',
    source: 'https://cursor.com/help/customization/rules',
  },
  {
    id: 'trae',
    name: 'TRAE',
    vendor: '字节跳动',
    // 旧版是单文件 user_rules.md，新版是目录 —— 两种都探测
    targets: [
      { kind: 'dir', segments: ['.trae', 'user_rules'] },
      { kind: 'file', segments: ['.trae', 'user_rules.md'] },
    ],
    confidence: 'high',
    source: 'https://docs.trae.ai/ide/rules',
  },
  {
    id: 'trae-cn',
    name: 'TRAE CN（国内版）',
    vendor: '字节跳动',
    targets: [
      { kind: 'dir', segments: ['.trae-cn', 'user_rules'] },
      { kind: 'file', segments: ['.trae-cn', 'user_rules.md'] },
    ],
    confidence: 'medium',
    source: 'https://docs.trae.ai/ide/rules',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    vendor: '腾讯云',
    targets: [{ kind: 'dir', segments: ['.codebuddy', 'rules'] }],
    confidence: 'high',
    source: 'https://cloud.tencent.com/document/product/1831/137462',
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    vendor: '腾讯云',
    // WorkBuddy 是办公智能体（非编码工具），它的身份/规则文件放在
    // ~/.workbuddy/user-<id>-personal/ 下 —— 中间那段是动态用户 id，
    // 所以用 globTarget 在运行时枚举，不能写死路径。
    targets: [{ kind: 'glob', segments: ['.workbuddy'], pattern: /^user-.*-personal$/, files: ['RULES.md', 'MEMORY.md', 'IRONLAW.md', 'SOUL.md', 'USER.md', 'IDENTITY.md'] }],
    note: '办公智能体；文件位于 user-<id>-personal 目录（随账号变化）',
    confidence: 'medium',
    source: 'https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Memory',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'SST',
    targets: [{ kind: 'file', segments: ['.config', 'opencode', 'AGENTS.md'] }],
    confidence: 'high',
    source: 'https://opencode.ai/docs/rules',
  },
  {
    id: 'windsurf',
    name: 'Windsurf / Devin',
    vendor: 'Cognition',
    // 产品已并入 Devin Desktop：新路径 ~/.devin，旧路径 ~/.codeium 仍会被自动导入。
    // 两条都探测，否则升级后用户会以为规则丢了。
    targets: [
      { kind: 'file', segments: ['.devin', 'global_rules.md'] },
      { kind: 'dir', segments: ['.devin', 'rules'] },
      { kind: 'dir', segments: ['.codeium', 'windsurf', 'memories'] },
    ],
    confidence: 'high',
    source: 'https://docs.devin.ai/desktop/cascade/memories',
  },
  {
    id: 'cline',
    name: 'Cline',
    vendor: 'Cline',
    // 官方给的是 Documents 下的位置，不是点目录
    targets: [{ kind: 'dir', segments: ['Documents', 'Cline', 'Rules'] }],
    confidence: 'high',
    source: 'https://docs.cline.bot/customization/cline-rules',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    vendor: 'GitHub / Microsoft',
    targets: [{ kind: 'dir', segments: ['.copilot', 'instructions'] }],
    note: 'VS Code 扩展；Visual Studio 另有 %USERPROFILE%/copilot-instructions.md',
    confidence: 'high',
    source: 'https://code.visualstudio.com/docs/copilot/customization/custom-instructions',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    vendor: 'AWS',
    targets: [{ kind: 'dir', segments: ['.kiro', 'steering'] }],
    confidence: 'high',
    source: 'https://kiro.dev/docs/steering',
  },
  {
    id: 'qoder',
    name: 'Qoder',
    vendor: '阿里',
    targets: [
      { kind: 'dir', segments: ['.qoder', 'rules'] },
      { kind: 'file', segments: ['.qoder', 'AGENTS.md'] },
    ],
    confidence: 'high',
    source: 'https://docs.qoder.com/zh/user-guide/rules',
  },
  {
    id: 'augment',
    name: 'Augment Code',
    vendor: 'Augment',
    targets: [
      { kind: 'dir', segments: ['.augment', 'rules'] },
      { kind: 'file', segments: ['.augment', 'user-guidelines.md'] },
    ],
    confidence: 'high',
    source: 'https://docs.augmentcode.com/cli/rules',
  },
  {
    id: 'roo',
    name: 'Roo Code',
    vendor: 'Roo',
    targets: [{ kind: 'dir', segments: ['.roo', 'rules'] }],
    note: '项目已停止维护',
    confidence: 'high',
    source: 'https://docs.roocode.com/features/custom-instructions',
  },
  // ── 以下为按本机实际安装情况补充的工具（路径来自磁盘扫描，非文档推测）──
  {
    id: 'zcode',
    name: 'ZCode',
    vendor: 'Z.ai',
    targets: [{ kind: 'file', segments: ['.zcode', 'AGENTS.md'] }],
    confidence: 'medium',
    source: '本机实测：~/.zcode/AGENTS.md',
  },
  {
    id: 'codearts-doer',
    name: 'CodeArts Doer',
    vendor: '华为云',
    targets: [{ kind: 'dir', segments: ['.codeartsdoer', 'rule'] }],
    confidence: 'medium',
    source: '本机实测：~/.codeartsdoer/rule/global-rules.md',
  },
  {
    id: 'catpaw',
    name: 'CatPaw（美团）',
    vendor: '美团',
    // 目录名是动态用户 id（如 1429420521），同 WorkBuddy 的处理方式
    targets: [{ kind: 'glob', segments: ['.meituan-catpaw'], pattern: /^\d+$/, files: ['memory/MEMORY.md', 'memory/collaboration-communication.md', 'memory/delivery-quality.md', 'memory/session-resilience.md'] }],
    note: '规则放在 memory/ 目录，与其它工具命名不同',
    confidence: 'medium',
    source: '本机实测：~/.meituan-catpaw/<uid>/memory/',
  },
  {
    id: 'qoderwork',
    name: 'QoderWork CN',
    vendor: '阿里',
    // 实际结构是 ~/.qoderworkcn/awareness/main/{AGENTS,MEMORY,SOUL,USER}.md
    targets: [{ kind: 'dir', segments: ['.qoderworkcn', 'awareness', 'main'] }],
    confidence: 'medium',
    source: '本机实测：~/.qoderworkcn/awareness/main/',
  },
  {
    id: 'autoclaw',
    name: 'AutoClaw',
    vendor: '开源',
    targets: [{ kind: 'file', segments: ['.openclaw-autoclaw', 'workspace', 'AGENTS.md'] }],
    confidence: 'medium',
    source: '本机实测：~/.openclaw-autoclaw/workspace/AGENTS.md',
  },
  {
    id: 'hanako',
    name: 'Hanako',
    vendor: '—',
    targets: [{ kind: 'dir', segments: ['.hanako', 'agents', 'hanako'] }],
    note: '人格/规则为 ishiki.md（意识）等分片文件',
    confidence: 'medium',
    source: '本机实测：~/.hanako/agents/hanako/',
  },
  {
    id: 'codebuddy-cn',
    name: 'CodeBuddy CN',
    vendor: '腾讯云',
    targets: [{ kind: 'dir', segments: ['.codebuddycn', 'rules'] }],
    confidence: 'medium',
    source: '本机实测（与 CodeBuddy 国际版分目录存放）',
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    vendor: '阿里',
    targets: [
      // 本机实测文件名是小写 agents.md（Windows 大小写不敏感，但为了在大小写敏感的
      // 文件系统上也能命中，两个拼写都要试）
      { kind: 'file', segments: ['.qoder-cn', 'AGENTS.md'] },
      { kind: 'file', segments: ['.qoder-cn', 'agents.md'] },
      { kind: 'dir', segments: ['.qoder-cn', 'rules'] },
    ],
    confidence: 'medium',
    source: '本机实测：~/.qoder-cn/agents.md',
  },
  {
    id: 'joycode',
    name: 'JoyCode',
    vendor: '京东',
    // 本机实测：规则存在 teams/<id>/rules.json 里，且当前为空数组；
    // 目录下没有任何 .md 规则文件，所以仍然列出（让用户知道它被检测到了），
    // 但没有可编辑项 —— UI 会显示「已安装但还没有规则文件」。
    targets: [{ kind: 'dir', segments: ['.joycode', 'rules'] }],
    note: '规则存于 teams/<id>/rules.json（JSON 格式），暂无 Markdown 规则文件',
    confidence: 'low',
    source: '本机实测：~/.joycode/',
  },
]
/** 第三方规则文件允许的扩展名：.md / .mdc（Cursor 系带 frontmatter 的 Markdown）。 */
const THIRD_PARTY_EXTENSIONS = ['.md', '.mdc']

/** 单个工具目录下最多扫描多少个规则文件，避免异常目录把响应撑爆。 */
const THIRD_PARTY_MAX_FILES = 200

/** 统一响应头：契约要求所有响应都是 JSON + UTF-8。 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

// ============================================================================
// 用户自定义工具（发布后仍需覆盖清单外的工具）
// ============================================================================
//
// 存到 `~/.dsh/agents-visualization.json`：跟 DSH 自己的用户数据放一起，
// 卸载插件时不会散落；用户也能手工编辑。
// 结构：{ version: 1, tools: [{ id, name, vendor, targets: [...] }] }
// targets 与内置清单同构（file / dir / glob），因此完全复用扫描逻辑。

/** 用户自定义配置的文件名（位于 dshHome 下）。 */
const USER_CONFIG_FILE = 'agents-visualization.json'

/**
 * 解析用户配置文件的绝对路径。
 * @param {() => { dsh: { path: string } }} homes - 已解析的全局根。
 * @returns {string} 配置文件绝对路径。
 */
function userConfigPath(homes) {
  return join(homes.dsh.path, USER_CONFIG_FILE)
}

/**
 * 校验一个用户自定义工具条目，返回规范化后的副本；非法时返回 null。
 *
 * 安全考虑：用户配置里可以写任意 segments，等于「允许读 home 下任意
 * 指定路径」。这是合理的（用户自己配的），但仍要拦住明显的越权写法：
 * 绝对路径、`..` 上跳、非字符串分段。
 * @param {unknown} raw - 原始条目。
 * @returns {any | null} 合法条目或 null。
 */
function normalizeUserTool(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const item = /** @type {any} */ (raw)
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (id === '' || name === '') return null
  // id 会进 key，不能含分隔符
  if (/[:\/\\]/.test(id)) return null
  if (!Array.isArray(item.targets)) return null

  const targets = []
  for (const t of item.targets) {
    if (t === null || typeof t !== 'object') continue
    const kind = t.kind
    const segments = Array.isArray(t.segments) ? t.segments.filter((s) => typeof s === 'string' && s.length > 0) : []
    if (segments.length === 0) continue
    // 拒绝绝对路径与上跳：用户配置也不该能把扫描带到 home 之外
    if (segments.some((s) => s.includes('..') || /^[a-zA-Z]:/.test(s) || s.startsWith('/') || s.startsWith('\\'))) continue
    if (kind === 'file') {
      const target = { kind: 'file', segments }
      if (Array.isArray(t.alternates)) {
        const alts = t.alternates.filter((a) => Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === 'string' && s.length > 0 && !s.includes('..')))
        if (alts.length > 0) target.alternates = alts
      }
      targets.push(target)
    } else if (kind === 'dir') {
      targets.push({ kind: 'dir', segments })
    } else if (kind === 'glob') {
      // 正则不能从 JSON 直接来，用字符串 + 白名单化的字符类，避免 ReDoS
      const pattern = typeof t.pattern === 'string' ? t.pattern : ''
      if (pattern === '' || pattern.length > 200) continue
      const files = Array.isArray(t.files) ? t.files.filter((f) => typeof f === 'string' && f.length > 0 && !f.includes('..')) : []
      if (files.length === 0) continue
      targets.push({ kind: 'glob', segments, patternSource: pattern, files })
    }
  }
  if (targets.length === 0) return null

  return {
    id,
    name,
    vendor: typeof item.vendor === 'string' && item.vendor.trim() !== '' ? item.vendor.trim() : '自定义',
    targets,
    confidence: 'high', // 用户自己配的，路径可信度按最高处理
    source: 'user-config',
    note: null,
    userDefined: true,
  }
}

/**
 * 读取用户自定义配置；文件不存在或损坏时返回空列表（不抛错）。
 * @param {() => { dsh: { path: string } }} homes - 已解析的全局根。
 * @returns {Promise<{ tools: any[], existed: boolean, error: string | null }>}
 */
async function loadUserTools(homes) {
  const file = userConfigPath(homes)
  const info = await fileInfo(file)
  if (!info.exists) return { tools: [], existed: false, error: null }
  try {
    const text = (await readBounded(file, info)).content
    const parsed = JSON.parse(text)
    const rawList = Array.isArray(parsed?.tools) ? parsed.tools : []
    const tools = []
    for (const raw of rawList) {
      const norm = normalizeUserTool(raw)
      if (norm !== null) tools.push(norm)
    }
    return { tools, existed: true, error: null }
  } catch (error) {
    return { tools: [], existed: true, error: `配置文件解析失败：${error?.message ?? error}` }
  }
}

/**
 * 保存用户自定义工具列表（原子写、UTF-8 无 BOM）。
 * @param {() => { dsh: { path: string } }} homes - 已解析的全局根。
 * @param {any[]} tools - 已规范化的工具条目。
 * @returns {Promise<void>}
 */
async function saveUserTools(homes, tools) {
  const file = userConfigPath(homes)
  // 落盘时只保留可序列化的字段，去掉运行时补的 confidence/source 等
  const payload = {
    version: 1,
    tools: tools.map((t) => ({
      id: t.id,
      name: t.name,
      vendor: t.vendor,
      targets: t.targets.map((tg) => {
        if (tg.kind === 'glob') {
          return { kind: 'glob', segments: tg.segments, pattern: tg.patternSource, files: tg.files }
        }
        return tg
      }),
    })),
  }
  await atomicWrite(file, JSON.stringify(payload, null, 2) + '\n')
}

// ============================================================================
// 通用工具
// ============================================================================

/**
 * 写一个 JSON 响应。content-length 用实际字节数（中文是多字节）。
 * @param {import('node:http').ServerResponse} res - node:http 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 可序列化的响应体。
 */
function sendJson(res, status, payload) {
  if (res.writableEnded) return
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': String(body.byteLength) })
  res.end(body)
}

/**
 * 统一错误响应形状：{ ok:false, code, error }（契约 §2.4）。
 * @param {import('node:http').ServerResponse} res - node:http 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {string} code - 机器可读错误码。
 * @param {string} error - 人类可读的中文说明。
 */
function sendError(res, status, code, error) {
  sendJson(res, status, { ok: false, code, error })
}

/**
 * 读取请求体并解码成 UTF-8 文本。超过上限时抛 code='TOO_LARGE' 的错误。
 * @param {import('node:http').IncomingMessage} req - node:http 请求对象。
 * @returns {Promise<string>} 请求体文本。
 */
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let bytes = 0
    let overflow = false
    req.on('data', (chunk) => {
      if (overflow) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        // 超限后丢弃已收数据但仍把流读完，这样才能正常回一个 413 而不是断连。
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) {
        rejectBody(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }))
        return
      }
      resolveBody(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', rejectBody)
  })
}

/**
 * 判断一台主机名是否是回环地址（契约允许的三种写法）。
 * @param {string} hostname - 已归一化的小写主机名。
 * @returns {boolean} 是否回环。
 */
function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

/**
 * 从 Host 头里取出主机名（IPv6 保留方括号）。
 * @param {unknown} hostHeader - req.headers.host 的原始值。
 * @returns {string} 小写主机名，缺失时为空串。
 */
function hostnameOf(hostHeader) {
  const host = String(hostHeader ?? '').toLowerCase()
  if (host === '') return ''
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
}

/**
 * 从 Cordis 上下文读一个可选服务；缺失或上下文已失活时返回 undefined。
 * @param {any} ctx - Cordis 上下文。
 * @param {string} name - 服务名。
 * @returns {any} 服务实例或 undefined。
 */
function getService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * 信任栅栏。优先用 connection.requestRejection（同步方法，返回 401/403 或 undefined）；
 * connection 不可用时按 fail-closed 处理：只放行回环 Host（契约 §2）。
 * @param {any} ctx - Cordis 上下文。
 * @param {import('node:http').IncomingMessage} req - node:http 请求对象。
 * @returns {0|number} 0 表示放行，否则是要回的 HTTP 状态码。
 */
function trustRejection(ctx, req) {
  const connection = getService(ctx, 'connection')
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection(req)
      if (rejection === undefined || rejection === null || rejection === false) return 0
      return typeof rejection === 'number' ? rejection : 403
    } catch {
      // 栅栏自身抛错时必须是拒绝而不是放行。
      return 403
    }
  }
  // connection 服务缺失：只信任回环 Host，其余一律 403。
  return isLoopbackHostname(hostnameOf(req?.headers?.host)) ? 0 : 403
}

// ============================================================================
// 全局根解析（与 @deepseek-ai/dsh-home-paths 逐字对齐）
// ============================================================================

/**
 * 展开 `~` / `~/` / `~\` 前缀。
 * @param {string} value - 原始配置值。
 * @returns {string} 展开后的路径（无受支持前缀时原样返回）。
 */
function expandHomePath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * 解析一个用户数据根：显式配置 > 环境变量 > 默认目录。
 * 空串或纯空白的环变值按「未设置」处理（否则会把根解析到 cwd）。
 * @param {Record<string, string | undefined>} env - 环境变量表。
 * @param {string} envName - 覆盖用的环境变量名。
 * @param {string} dirName - 默认目录名（位于 OS home 下）。
 * @returns {string} 归一化后的绝对路径。
 */
function resolveRoot(env, envName, dirName) {
  const fromEnv = env?.[envName]
  const configured = typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), dirName)
  return resolve(expandHomePath(configured))
}

/**
 * 生成面向用户的符号化展示（绝不展示机器绝对路径）。
 * @param {string} resolvedRoot - 已解析的根。
 * @param {string} dirName - 默认目录名。
 * @param {string} defaultLabel - 默认根的展示名，例如 `~/.dsh`。
 * @param {string} envName - 覆盖用的环境变量名，被覆盖时展示 `$DSH_HOME` 之类。
 * @returns {string} 展示用路径前缀。
 */
function rootDisplay(resolvedRoot, dirName, defaultLabel, envName) {
  return resolvedRoot === resolve(join(homedir(), dirName)) ? defaultLabel : `$${envName}`
}

/**
 * 解析两个全局根及其展示名。
 * @param {Record<string, string | undefined>} [env] - 环境变量表，默认 process.env。
 * @returns {{ dsh: { path: string, display: string }, agents: { path: string, display: string } }}
 */
function resolveHomes(env = process.env) {
  const dshPath = resolveRoot(env, 'DSH_HOME', '.dsh')
  const agentsPath = resolveRoot(env, 'DSH_AGENTS_HOME', '.agents')
  return {
    dsh: { path: dshPath, display: rootDisplay(dshPath, '.dsh', '~/.dsh', 'DSH_HOME') },
    agents: { path: agentsPath, display: rootDisplay(agentsPath, '.agents', '~/.agents', 'DSH_AGENTS_HOME') },
  }
}

// ============================================================================
// 文件系统探测
// ============================================================================

/**
 * 探测一个路径的文件元信息。不存在、不可读、或不是普通文件都按「不存在」处理。
 * @param {string} absPath - 绝对路径。
 * @returns {Promise<{ exists: boolean, size: number, mtime: string | null, mtimeMs: number }>}
 */
async function fileInfo(absPath) {
  try {
    const info = await stat(absPath)
    if (!info.isFile()) return { exists: false, size: 0, mtime: null, mtimeMs: 0 }
    return { exists: true, size: info.size, mtime: new Date(info.mtimeMs).toISOString(), mtimeMs: info.mtimeMs }
  } catch {
    return { exists: false, size: 0, mtime: null, mtimeMs: 0 }
  }
}

/**
 * 有界读取：最多读 1 MiB，超出部分丢弃并标记 truncated。
 *
 * 不用 info.size 预分配缓冲：stat 与 open 之间存在窗口，
 * 文件在这期间变大就会只读到旧长度的内容（静默截断），
 * 变小则读到一堆 \0。改成边读边收集，长度以实际读到的为准。
 * @param {string} absPath - 绝对路径。
 * @param {{ size: number }} info - 已探测到的文件信息（只用来判断是否超限）。
 * @returns {Promise<{ content: string, truncated: boolean }>}
 */
async function readBounded(absPath, info) {
  const handle = await open(absPath, 'r')
  try {
    const chunks = []
    let total = 0
    let truncated = false
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
      if (bytesRead === 0) break
      // 只保留到 1 MiB；超出的部分丢弃但继续读到底（不读了，直接标记截断）
      const room = MAX_CONTENT_BYTES - total
      if (bytesRead > room) {
        chunks.push(Buffer.from(buffer.subarray(0, room)))
        total += room
        truncated = true
        break
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      total += bytesRead
      // 注意：读满 1 MiB 时**不能**立即判定截断 —— 文件可能恰好就是 1 MiB。
      // 再读一次确认是否真的还有内容，才有资格标记 truncated。
      if (total >= MAX_CONTENT_BYTES) {
        const probe = await handle.read(buffer, 0, 1, total)
        if (probe.bytesRead > 0) truncated = true
        break
      }
    }
    return { content: Buffer.concat(chunks).toString('utf8'), truncated: truncated || info.size > MAX_CONTENT_BYTES }
  } finally {
    await handle.close()
  }
}

/**
 * 读取一个文件的 trimmed 内容，用于全局去重比对；不可读时返回 undefined。
 * @param {string} absPath - 绝对路径。
 * @returns {Promise<string | undefined>}
 */
async function readTrimmed(absPath) {
  const info = await fileInfo(absPath)
  if (!info.exists) return undefined
  try {
    return (await readBounded(absPath, info)).content.trim()
  } catch {
    return undefined
  }
}

/**
 * 按路径串行的写队列。
 *
 * 为什么需要：`/write` 的「比对 expectedVersion → 落盘」是两步。
 * 两个并发请求可能都读到旧 version、都通过校验，后写的把前写的覆盖掉
 * （经典 lost update）。用一张「路径 → 链尾 Promise」的表把同一文件的
 * 读-判-写包成一个串行区间，就消除了这个窗口。
 * 不同文件互不影响；队列结算后自动清理，不会无界增长。
 */
const writeQueues = new Map()

/**
 * 在「同一路径串行」的区间里执行一个操作。
 * @template T
 * @param {string} key - 串行键（这里用绝对路径）。
 * @param {() => Promise<T>} operation - 要串行执行的操作。
 * @returns {Promise<T>} 操作本身的结果或异常。
 */
function serializeByPath(key, operation) {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  // 前一个无论成功失败，后一个都继续执行（用同一回调承担两种状态）。
  const run = previous.then(operation, operation)
  // 队列里只存「不会 reject」的尾巴，避免未处理的 rejection 告警。
  const tail = run.then(
    () => {},
    () => {},
  )
  writeQueues.set(key, tail)
  // 结算后若自己仍是队尾就删掉，防止 Map 随写过的文件数无限增长。
  tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key)
  })
  return run
}

/**
 * 原子写：同目录临时文件 + rename；UTF-8 无 BOM；父目录不存在则递归创建。
 * @param {string} absPath - 目标绝对路径（已由允许集合校验过）。
 * @param {string} content - 要写入的文本。
 * @returns {Promise<void>}
 */
async function atomicWrite(absPath, content) {
  const dir = dirname(absPath)
  await mkdir(dir, { recursive: true })
  const tempPath = join(dir, `.${basename(absPath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    const handle = await open(tempPath, 'w')
    try {
      await handle.writeFile(content, { encoding: 'utf8' })
      await handle.sync() // rename 之前落盘，崩溃时不会留下半截内容
    } finally {
      await handle.close()
    }
    await rename(tempPath, absPath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

// ============================================================================
// 项目根与目录链（与 @deepseek-ai/dsh-agent-instructions 的 files.ts 对齐）
// ============================================================================

/**
 * 路径是否存在（文件或目录都算）。根标记 `.git` 常态是目录，所以不能用 fileInfo。
 * @param {string} absPath - 绝对路径。
 * @returns {Promise<boolean>} 是否存在。
 */
async function pathExists(absPath) {
  try {
    await stat(absPath)
    return true
  } catch {
    return false
  }
}

/**
 * 向上找第一个含根标记的目录。
 * @param {string} cwd - 起点目录（绝对路径）。
 * @returns {Promise<string>} 项目根；找不到标记时回退为 cwd 自身。
 */
async function findProjectRoot(cwd) {
  let current = resolve(cwd)
  for (;;) {
    if (await pathExists(join(current, ROOT_MARKER))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * 构造包含两端的目录链，从最宽（root）到最具体（cwd）。
 * @param {string} root - 期望包含 cwd 的根目录。
 * @param {string} cwd - 链上最具体的目录。
 * @returns {string[]} 目录数组。
 */
function ancestorChain(root, cwd) {
  const chain = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * 目标路径是否落在 root 之内（含相等）。项目路径的硬约束检查（契约 §3.3）。
 * @param {string} root - 根目录绝对路径。
 * @param {string} target - 目标绝对路径。
 * @returns {boolean} 是否在根之内。
 */
function isInside(root, target) {
  const base = resolve(root)
  const full = resolve(target)
  return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * 目录在项目内的分组名：根目录为 '.'，其余用 `/` 分隔。
 * @param {string} projectRoot - 项目根。
 * @param {string} dir - 目录。
 * @returns {string} 分组名。
 */
function projectGroup(projectRoot, dir) {
  const rel = relative(projectRoot, dir)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

// ============================================================================
// 允许集合
// ============================================================================

/** 全局 key 编码：global:<dsh|agents>:<name>。 */
function globalKey(which) {
  return `global:${which}:${GLOBAL_FILE}`
}

/** 项目 key 编码：project:<相对目录|.>:<name>。 */
function projectKey(group, name) {
  return `project:${group}:${name}`
}

/** 第三方 key 编码：third:<toolId>:<相对该工具根的文件名>。 */
function thirdKey(toolId, name) {
  return `third:${toolId}:${name}`
}

/**
 * 把用户配置里的正则字符串编译成 RegExp。
 *
 * 用户配置是 JSON，存不了真正的正则，只能存字符串。这里做两道防护：
 *   1. 拒绝嵌套量词之类的典型 ReDoS 结构（如 (a+)+、(a|a)*）
 *   2. 长度上限 + 只允许锚定到行首行尾的简单模式
 * 编译失败或可疑时返回 null（该 target 被静默跳过，不影响其它工具）。
 * @param {unknown} source - 正则字符串。
 * @returns {RegExp | null} 可用的正则或 null。
 */
function compileUserPattern(source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > 200) return null
  // 典型灾难性回溯结构：(…)+ / (…)* / (…){n,} 里再套 + 或 *
  if (/\([^)]*[+*][^)]*\)\s*[+*]/.test(source)) return null
  try {
    return new RegExp(source)
  } catch {
    return null
  }
}

/**
 * 把 `segments` 拼成绝对路径（相对用户主目录）。
 * @param {string[]} segments - 路径分段。
 * @returns {string} 绝对路径。
 */
function homePath(segments) {
  return join(homedir(), ...segments)
}

/**
 * 启发式发现未收录的 AI 工具。
 *
 * 动机：内置清单只能覆盖「发布时已知」的工具。用户装了清单外的新工具时，
 * 页面不该什么都看不到 —— 所以按「文件形态特征」在 home 下扫一遍。
 *
 * 判定一个点目录是不是 AI 工具的规则目录，要求**同时**满足：
 *   1. 目录名不在忽略名单里（.cache / .npm / .git 这类明显不是）
 *   2. 目录内直接含有规则特征文件，或含有 `rules/`、`user_rules/` 这类子目录且其中有 .md
 *
 * 只扫 home 的一层点目录 + 至多两层子目录，避免遍历整个家目录。
 * 结果只作为「额外发现」列出，不覆盖内置清单，也不会重复内置项。
 * @param {Set<string>} knownDirs - 内置清单已经覆盖的绝对目录（用小写比较）。
 * @returns {Promise<Array<any>>} 额外发现的工具条目。
 */
async function discoverUnknownTools(knownDirs) {
  const home = homedir()
  // 明显不是 AI 工具的目录前缀/名称，跳过以减少误报与 IO
  const IGNORE = new Set([
    '.cache', '.npm', '.gradle', '.m2', '.cargo', '.rustup', '.conda', '.venv-html-to-docx',
    '.vscode', '.vscode-shared', '.ssh', '.git', '.local', '.config', '.android', '.dotnet',
    '.electron-gyp', '.thumbnails', '.templateengine', '.projfs', '.qt_material', '.oracle_jre_usage',
    '.openjfx', '.javacpp', '.matplotlib', '.mitmproxy', '.bun', '.chromium-browser-snapshots',
    '.agent-browser', '.mcp-auth', '.mspauth', '.lark-cli', '.cnb', '.cloudbase-mcp',
    '.agents', '.dsh', // DSH 自己的根由「全局级」Tab 负责，不重复列
  ])
  // 规则特征文件名（大小写不敏感）—— 这些是真·规则文件
  const FEATURE_FILES = ['agents.md', 'claude.md', 'gemini.md', 'codex.md', 'rules.md', 'instructions.md']
  // 规则子目录：放「人写给 AI 的规则」
  const RULE_SUBDIRS = ['rules', 'user_rules', 'steering', 'instructions']
  // 记忆子目录：放「AI 自己写下的记忆」，与规则是两回事。
  // 混进「规则」会给用户错误预期（以为改了会影响行为），所以单列。
  const MEMORY_SUBDIRS = ['memory', 'memories']

  let entries
  try {
    entries = await readdir(home, { withFileTypes: true })
  } catch {
    return []
  }

  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // 只考虑点目录：AI 工具的配置几乎都在 ~/.xxx
    if (!entry.name.startsWith('.')) continue
    if (IGNORE.has(entry.name)) continue
    const dir = join(home, entry.name)
    if (knownDirs.has(dir.toLowerCase())) continue

    let files = []
    // 1) 目录内直接有特征文件
    let kids = []
    try {
      kids = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const kid of kids) {
      if (!kid.isFile()) continue
      const lower = kid.name.toLowerCase()
      if (!FEATURE_FILES.includes(lower)) continue
      const abs = join(dir, kid.name)
      const fi = await fileInfo(abs)
      if (!fi.exists) continue
      files.push({ name: kid.name, absPath: abs, size: fi.size, mtime: fi.mtime })
    }
    // 2) 规则子目录
    for (const kid of kids) {
      if (!kid.isDirectory()) continue
      if (!RULE_SUBDIRS.includes(kid.name.toLowerCase())) continue
      const sub = join(dir, kid.name)
      for (const ruleFile of await listRuleFiles(sub, 50)) {
        const fi = await fileInfo(ruleFile.absPath)
        if (!fi.exists) continue
        files.push({ name: `${kid.name}/${ruleFile.name}`, absPath: ruleFile.absPath, size: fi.size, mtime: fi.mtime, kind: 'rule' })
      }
    }
    // 3) 记忆子目录：**不**当规则列，只在 note 里提一句。
    // 记忆是 AI 自己写的运行产物，不是用户要维护的规则；混在一起会让人
    // 误以为改它就能改变行为，反而误导。
    let memoryCount = 0
    for (const kid of kids) {
      if (!kid.isDirectory()) continue
      if (!MEMORY_SUBDIRS.includes(kid.name.toLowerCase())) continue
      memoryCount += await countRuleFiles(join(dir, kid.name))
    }
    // 没有规则文件就不算「这个工具有规则可管」；记忆数量单独返回给 UI 做说明
    if (files.length === 0) continue

    found.push({
      id: `discovered:${entry.name.replace(/^\./, '')}`,
      name: entry.name.replace(/^\./, ''),
      vendor: '自动发现',
      dir: tildeDisplay(dir),
      discovered: true,
      installed: true,
      confidence: 'low',
      source: '按文件形态特征自动发现（未在内置清单中）',
      note: '未收录的工具：按目录内的规则文件特征推断，可能不完全准确',
      memoryCount,
      files,
    })
  }
  return found
}

/**
 * 判断一个路径解析后是否仍落在用户主目录内。
 *
 * 为什么需要：允许符号链接（dotfiles 用户会把 ~/.cursor/rules 软链到别处）后，
 * 就得挡住「软链指向 home 之外」的情况 —— 否则白名单会把 ~/.ssh/id_rsa
 * 这类文件也纳入可读写范围。
 * 解析失败（文件不存在、权限不足）时按「不安全」处理。
 * @param {string} absPath - 待检查的绝对路径。
 * @param {string} [home] - 用户主目录，默认取 homedir()。
 * @returns {Promise<boolean>} 是否安全（在 home 之内）。
 */
async function isInsideHome(absPath, home = homedir()) {
  try {
    const real = await realpath(absPath)
    const realHome = await realpath(home)
    const rel = relative(realHome, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

/**
 * 生成展示路径：主目录下的部分写成 `~/...`，其余保持原样。
 * @param {string} absPath - 绝对路径。
 * @returns {string} 展示用路径。
 */
function tildeDisplay(absPath) {
  const home = homedir()
  const rel = relative(home, absPath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return absPath
  return '~/' + rel.split(sep).join('/')
}

/**
 * 列出目录下可编辑的规则文件（只认 .md / .mdc，按名排序）。
 * 目录不存在或不可读时返回空数组 —— 「没装这个工具」是正常状态，不是错误。
 * @param {string} dir - 目录绝对路径。
 * @returns {Promise<Array<{ name: string, absPath: string }>>}
 */
/**
 * 列出目录下可编辑的规则文件（只认 .md / .mdc，按名排序）。
 * 目录不存在或不可读时返回空数组 —— 「没装这个工具」是正常状态，不是错误。
 * @param {string} dir - 目录绝对路径。
 * @param {number} [limit] - 本目录最多返回多少个，默认用全局上限。
 * @returns {Promise<Array<{ name: string, absPath: string }>>}
 */
async function listRuleFiles(dir, limit = THIRD_PARTY_MAX_FILES) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (out.length >= limit) break
    // 允许符号链接：dotfiles 用户（stow / chezmoi）常把规则文件软链过去，
    // Dirent.isFile() 对软链返回 false，会导致页面上完全看不到。
    // 指向 home 之外的软链由调用方用 isInsideHome 过滤。
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    const lower = entry.name.toLowerCase()
    if (!THIRD_PARTY_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
    out.push({ name: entry.name, absPath: join(dir, entry.name) })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * 统计目录下规则文件总数（不受上限影响，用来提示「还有 N 个未列出」）。
 * @param {string} dir - 目录绝对路径。
 * @returns {Promise<number>} 规则文件总数。
 */
async function countRuleFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    let n = 0
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const lower = entry.name.toLowerCase()
      if (THIRD_PARTY_EXTENSIONS.some((ext) => lower.endsWith(ext))) n++
    }
    return n
  } catch {
    return 0
  }
}

/**
 * 扫描所有第三方工具的用户级规则文件。
 *
 * 返回结构（每个工具一条）：
 *   { id, name, vendor, kind, format, confidence, source, dir,
 *     installed, files: Array<{ name, key, displayPath, exists, size, mtime, duplicateOf }> }
 *
 * `installed` 表示该工具的配置目录/文件是否真实存在，用于区分
 * 「没装这个工具」与「装了但还没写规则」—— 两者对用户的含义完全不同。
 * @returns {Promise<Array<any>>}
 */
async function scanThirdParty(userTools = []) {
  const out = []
  // 内置清单覆盖到的绝对目录（小写），用于让启发式发现不重复列出同一位置
  const knownDirs = new Set()
  // 内置 + 用户自定义，一起参与扫描（用户条目 id 加前缀避免与内置撞车）
  const catalog = [...THIRD_PARTY_TOOLS, ...userTools.map((t) => ({ ...t, id: `user:${t.id}` }))]

  for (const tool of catalog) {
    const files = []
    let installed = false
    const dirs = []
    let totalRuleFiles = 0

    for (const target of tool.targets ?? []) {
      if (target.kind === 'file') {
        // 单文件工具：主文件之外还有 alternates（如 Codex 的 AGENTS.override.md）
        const candidates = [homePath(target.segments), ...(target.alternates ?? []).map((seg) => homePath(seg))]
        for (const abs of candidates) {
          const name = basename(abs)
          const fi = await fileInfo(abs)
          dirs.push(tildeDisplay(abs))
          files.push({ name, key: thirdKey(tool.id, name), scope: 'third', absPath: abs, displayPath: tildeDisplay(abs), exists: fi.exists, size: fi.size, mtime: fi.mtime, duplicateOf: null })
          if (fi.exists) installed = true
        }
        continue
      }

      if (target.kind === 'dir') {
        const dir = homePath(target.segments)
        knownDirs.add(dir.toLowerCase())
        const dirInfo = await stat(dir).catch(() => null)
        if (dirInfo !== null && dirInfo.isDirectory()) installed = true
        dirs.push(tildeDisplay(dir))
        // 先数总数，再截断取前 N 个 —— 这样能如实告诉用户「还有多少没列出」
        const total = await countRuleFiles(dir)
        totalRuleFiles += total
        for (const entry of await listRuleFiles(dir)) {
          const fi = await fileInfo(entry.absPath)
          files.push({ name: entry.name, key: thirdKey(tool.id, entry.name), scope: 'third', absPath: entry.absPath, displayPath: tildeDisplay(entry.absPath), exists: fi.exists, size: fi.size, mtime: fi.mtime, duplicateOf: null })
        }
        continue
      }

      // glob 型：目录名含动态 id（WorkBuddy 的 user-<id>-personal、CatPaw 的数字 uid），
      // 运行时枚举匹配的子目录。files 里的条目可以是 `memory/MEMORY.md` 这种带层级的路径。
      if (target.kind === 'glob') {
        const root = homePath(target.segments)
        knownDirs.add(root.toLowerCase())
        const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          // 内置清单给的是 RegExp；用户配置给的是 patternSource 字符串（JSON 存不了正则）
          const pattern = target.pattern instanceof RegExp ? target.pattern : compileUserPattern(target.patternSource)
          if (pattern === null || !entry.isDirectory() || !pattern.test(entry.name)) continue
          const sub = join(root, entry.name)
          installed = true
          dirs.push(tildeDisplay(sub))
          for (const fixed of target.files ?? []) {
            const abs = join(sub, fixed)
            const fi = await fileInfo(abs)
            if (!fi.exists) continue
            // key 里不能出现路径分隔符（Host 端会当成穿越拒绝），
            // 所以用 `子目录/文件名` 的展示名，key 用扁平化的安全形式。
            const flatKey = fixed.split('/').join('~')
            files.push({
              name: fixed,
              key: thirdKey(tool.id, flatKey),
              scope: 'third',
              absPath: abs,
              displayPath: tildeDisplay(abs),
              exists: true,
              size: fi.size,
              mtime: fi.mtime,
              duplicateOf: null,
            })
          }
        }
      }
    }

    // 同一工具内按真实文件去重：大小写不敏感的文件系统上 `AGENTS.md` 与 `agents.md`
    // 是同一个文件，不能列两次。用 realpath 拿规范路径做判据（Windows 上大小写归一）。
    const seenPaths = new Set()
    const dedupedFiles = []
    for (const file of files) {
      let key = file.absPath
      try {
        key = await realpath(file.absPath)
      } catch {
        // 文件不存在时 realpath 会失败，退回到小写路径比较
        key = file.absPath.toLowerCase()
      }
      if (seenPaths.has(key)) continue
      seenPaths.add(key)
      dedupedFiles.push(file)
    }

    out.push({
      id: tool.id,
      name: tool.name,
      vendor: tool.vendor,
      confidence: tool.confidence,
      source: tool.source,
      note: tool.note ?? null,
      dir: dirs.length === 1 ? dirs[0] : dirs,
      installed,
      // 目录里实际有多少个规则文件（不受列举上限影响）。
      // 前端据此提示「还有 N 个未列出」，而不是静默截断。
      totalRuleFiles: totalRuleFiles > 0 ? totalRuleFiles : undefined,
      // 对外不暴露绝对路径（展示用 displayPath 已足够），但内部保留供白名单使用
      files: dedupedFiles.map(({ absPath, ...entry }) => entry),
      _abs: dedupedFiles,
    })
  }

  // 启发式补漏：内置清单只覆盖「发布时已知」的工具。用户装了清单外的新工具时，
  // 页面不该一片空白 —— 按「目录内有规则特征文件」在 home 下扫一遍。
  // 结果追加在清单之后，id 以 discovered: 开头，页面上单独标注来源。
  try {
    const extra = await discoverUnknownTools(knownDirs)
    for (const tool of extra) {
      // 同一文件被内置工具和自动发现同时命中时，不重复列出
      const already = new Set()
      for (const known of out) {
        for (const real of known._abs) already.add(real.absPath.toLowerCase())
      }
      const files = []
      for (const f of tool.files) {
        if (already.has(f.absPath.toLowerCase())) continue
        files.push({
          name: f.name,
          key: thirdKey(tool.id, f.name.split('/').join('~')),
          scope: 'third',
          absPath: f.absPath,
          displayPath: tildeDisplay(f.absPath),
          exists: true,
          size: f.size,
          mtime: f.mtime,
          duplicateOf: null,
          sharedWith: [],
        })
      }
      if (files.length === 0) continue
      out.push({ ...tool, files: files.map(({ absPath, ...e }) => e), _abs: files })
    }
  } catch {
    // 自动发现是「锦上添花」，失败绝不能影响主流程
  }

  // 跨工具共用：**全文内容相同**的规则文件标出来。
  // 这是真实痛点：很多用户把同一份规则复制到每个工具，改一处会以为只影响一个。
  // 用 SHA-256 全文哈希比对 —— 不能用前缀（曾用 slice(0,4000)）：
  // 若两份只有末尾不同，前缀相同就会误判成「完全相同」，给出恰好相反的结论。
  const byDigest = new Map()
  for (const tool of out) {
    for (const real of tool._abs) {
      if (!real.exists || real.size === 0) continue
      const text = await readTrimmed(real.absPath)
      if (text === undefined) continue
      real._digest = createHash('sha256').update(text).digest('hex')
      const list = byDigest.get(real._digest) ?? []
      list.push(`${tool.name}/${real.name}`)
      byDigest.set(real._digest, list)
    }
  }
  for (const tool of out) {
    for (let i = 0; i < tool.files.length; i++) {
      const file = tool.files[i]
      const real = tool._abs[i]
      if (real === undefined || real._digest === undefined) { file.sharedWith = []; continue }
      file.sharedWith = (byDigest.get(real._digest) ?? []).filter((n) => n !== `${tool.name}/${file.name}`)
    }
  }

  return out
}

/**
 * 把注册表里的工作区补上 projectRoot。
 * @param {any} registry - workspaceRegistry 服务（可能缺失）。
 * @returns {Promise<Array<{ id: string, title: string, path: string, projectRoot: string }>>}
 */
async function describeWorkspaces(registry) {
  let list = []
  try {
    list = registry?.list?.() ?? []
  } catch {
    list = []
  }
  const out = []
  for (const workspace of Array.isArray(list) ? list : []) {
    const path = typeof workspace?.path === 'string' ? resolve(workspace.path) : ''
    if (path === '') continue
    let projectRoot = path
    try {
      projectRoot = await findProjectRoot(path)
    } catch {
      projectRoot = path
    }
    const title = typeof workspace?.title === 'string' && workspace.title.length > 0 ? workspace.title : basename(path)
    out.push({ id: String(workspace?.id ?? ''), title, path, projectRoot })
  }
  return out
}

/**
 * 选定生效的工作区。
 *
 * 语义区分很关键：
 *   · 客户端**没指定** workspaceId（首次加载）→ 用第一个工作区，合理
 *   · 客户端**指定了**但找不到（工作区被删除/改名，而前端还持着旧 id）
 *     → 必须返回 invalid，绝不能静默回退到第一个工作区。
 *       否则用户点「创建 AGENTS.md」，文件会落到另一个项目里。
 * @param {Array<{ id: string }>} workspaces - 已描述的工作区列表。
 * @param {string | null | undefined} requestedId - 客户端给的 workspaceId。
 * @returns {{ kind: 'none' } | { kind: 'ok', workspace: any } | { kind: 'invalid' }}
 */
function pickWorkspace(workspaces, requestedId) {
  const wanted = typeof requestedId === 'string' && requestedId.length > 0 ? requestedId : undefined
  if (wanted === undefined) {
    return workspaces.length > 0 ? { kind: 'ok', workspace: workspaces[0] } : { kind: 'none' }
  }
  const hit = workspaces.find((workspace) => workspace.id === wanted)
  return hit === undefined ? { kind: 'invalid' } : { kind: 'ok', workspace: hit }
}

/**
 * 造一条 FileEntry 记录（同时带绝对路径，供查表使用）。
 * @param {string} absPath - 绝对路径。
 * @param {{ key: string, scope: string, group: string, name: string, displayPath: string }} meta - 展示元信息。
 * @returns {Promise<{ absPath: string, entry: any }>}
 */
async function createRecord(absPath, meta) {
  const info = await fileInfo(absPath)
  return {
    absPath,
    entry: {
      key: meta.key,
      scope: meta.scope,
      group: meta.group,
      name: meta.name,
      displayPath: meta.displayPath,
      exists: info.exists,
      size: info.size,
      mtime: info.mtime,
      duplicateOf: null,
    },
  }
}

/**
 * 全局去重：两个全局文件属同一候选组，trimmed 内容相同时后者的 duplicateOf 指向前者 key。
 * @param {Array<{ absPath: string, entry: any }>} records - 顺序为 [dshHome, agentsHome] 的两条记录。
 * @returns {Promise<void>}
 */
async function markGlobalDuplicate(records) {
  const [first, second] = records
  if (!first?.entry.exists || !second?.entry.exists) return
  const [firstText, secondText] = await Promise.all([readTrimmed(first.absPath), readTrimmed(second.absPath)])
  if (firstText !== undefined && secondText !== undefined && firstText === secondText) {
    second.entry.duplicateOf = first.entry.key
  }
}

/**
 * 计算本次请求的完整允许集合。
 * 每次请求都重算，绝不复用上一次的路径表 —— 这是「key 只能是重算出来的合法路径」的保证。
 * @param {any} ctx - Cordis 上下文。
 * @param {string | null} workspaceId - 客户端给的 workspaceId（可为 null）。
 * @returns {Promise<{ homes: any, workspaces: any[], selected: any, globals: any[], project: any[], notes: string[], allowed: Map<string, string> }>}
 */
async function buildScope(ctx, workspaceId) {
  const homes = resolveHomes()
  const workspaces = await describeWorkspaces(getService(ctx, 'workspaceRegistry'))
  const picked = pickWorkspace(workspaces, workspaceId)
  // 客户端持了已失效的 workspaceId：不能静默回退（会把文件写进别的项目）。
  // 返回 invalid 让调用方回 BAD_KEY，前端收到后会刷新工作区列表。
  if (picked.kind === 'invalid') return { invalidWorkspace: true }
  const selected = picked.kind === 'ok' ? picked.workspace : undefined
  const records = []
  // 用户自定义的工具清单：读失败不能拖垮整个 /state，按空处理并回传错误说明
  const userConfig = await loadUserTools(homes)

  // 1) 全局：恰好两项，顺序固定 [dshHome, agentsHome]（契约 §2.1）。
  records.push(await createRecord(join(homes.dsh.path, GLOBAL_FILE), {
    key: globalKey('dsh'),
    scope: 'global',
    group: 'user-global',
    name: GLOBAL_FILE,
    displayPath: `${homes.dsh.display}/${GLOBAL_FILE}`,
  }))
  records.push(await createRecord(join(homes.agents.path, GLOBAL_FILE), {
    key: globalKey('agents'),
    scope: 'global',
    group: 'agents-global',
    name: GLOBAL_FILE,
    displayPath: `${homes.agents.display}/${GLOBAL_FILE}`,
  }))
  await markGlobalDuplicate(records)

  // 2) 项目：目录链（宽 → 具体）× 4 个候选；缺失的候选也要返回，页面要靠它提供「创建」。
  if (selected !== undefined) {
    for (const dir of ancestorChain(selected.projectRoot, selected.path)) {
      const group = projectGroup(selected.projectRoot, dir)
      for (const name of PROJECT_CANDIDATES) {
        const absPath = join(dir, name)
        // 硬约束：项目路径必须落在 projectRoot 之内（含相等），否则不入表 → 后续必然 BAD_KEY。
        if (!isInside(selected.projectRoot, absPath)) continue
        records.push(await createRecord(absPath, {
          key: projectKey(group, name),
          scope: 'project',
          group,
          name,
          displayPath: group === '.' ? name : `${group}/${name}`,
        }))
      }
    }
  }

  const allowed = new Map(records.map((record) => [record.entry.key, record.absPath]))

  // 3) 第三方集中：扫描各工具的用户级规则文件，并把它们并入同一份允许集合。
  //    必须用同一份扫描结果同时产出示数据与白名单，否则会出现
  //    「页面上看得见、点开却是 BAD_KEY」的裂缝。
  const thirdParty = await scanThirdParty(userConfig.tools)
  for (const tool of thirdParty) {
    for (const file of tool._abs) {
      // 直接用扫描阶段探到的真实绝对路径，不做任何「由 key 重建路径」的推理。
      // 这是本插件最安全的一层：白名单里的路径必然是扫描时亲眼看到的那个文件。
      //
      // 注意：这里**不能**只收 exists 的条目。页面会给「未创建」的候选渲染「创建」
      // 按钮，路径同样来自扫描（homePath(segments) 生成，与客户端 key 无关），
      // 若把它们排除在白名单外，点创建必然 BAD_KEY —— 那是链路断裂。
      // 若已存在，再做一次 realpath 归属校验：软链指向 home 之外的一律拒绝
      // （否则 ~/.cursor/rules/x.mdc 这种软链会把 ~/.ssh/id_rsa 也变成可读写）。
      if (file.exists && !(await isInsideHome(file.absPath))) continue
      allowed.set(file.key, file.absPath)
    }
    // 内部字段不外泄给浏览器
    delete tool._abs
  }

  const notes = []
  if (workspaces.length === 0) {
    notes.push('当前没有已注册的工作区，项目级候选为空；在会话里打开一个目录后再刷新即可。')
  }
  if (homes.dsh.display !== '~/.dsh' || homes.agents.display !== '~/.agents') {
    notes.push('全局根由环境变量覆盖（DSH_HOME / DSH_AGENTS_HOME），展示名用 $DSH_HOME / $DSH_AGENTS_HOME 表示。')
  }
  if (userConfig.error !== null) {
    notes.push(userConfig.error)
  }
  return {
    homes,
    workspaces,
    selected,
    globals: records.filter((record) => record.entry.scope === 'global').map((record) => record.entry),
    project: records.filter((record) => record.entry.scope === 'project').map((record) => record.entry),
    thirdParty,
    // 返回给前端做「自定义工具」面板：配置里已有的条目 + 配置文件位置
    userTools: userConfig.tools.map((t) => ({ id: t.id, name: t.name, vendor: t.vendor, targets: t.targets })),
    userConfigPath: tildeDisplay(userConfigPath(homes)),
    notes,
    allowed,
  }
}

// ============================================================================
// 三个接口
// ============================================================================

/**
 * GET /state
 * @param {any} ctx - Cordis 上下文。
 * @param {URL} url - 已解析的请求 URL（含查询串）。
 * @param {import('node:http').ServerResponse} res - node:http 响应对象。
 * @returns {Promise<void>}
 */
async function handleState(ctx, url, res) {
  const scope = await buildScope(ctx, url.searchParams.get('workspaceId'))
  if (scope.invalidWorkspace) {
    sendError(res, 400, 'BAD_KEY', 'workspaceId 已失效（工作区可能被删除或改名），请刷新后重试')
    return
  }
  sendJson(res, 200, {
    ok: true,
    homes: scope.homes,
    selectedWorkspaceId: scope.selected?.id ?? null,
    workspaces: scope.workspaces,
    globals: scope.globals,
    project: scope.project,
    thirdParty: scope.thirdParty,
    userTools: scope.userTools,
    userConfigPath: scope.userConfigPath,
    notes: scope.notes,
  })
}

/**
 * GET /read
 * @param {any} ctx - Cordis 上下文。
 * @param {URL} url - 已解析的请求 URL（含查询串）。
 * @param {import('node:http').ServerResponse} res - node:http 响应对象。
 * @returns {Promise<void>}
 */
async function handleRead(ctx, url, res) {
  const key = url.searchParams.get('key') ?? ''
  const scope = await buildScope(ctx, url.searchParams.get('workspaceId'))
  if (scope.invalidWorkspace) {
    sendError(res, 400, 'BAD_KEY', 'workspaceId 已失效（工作区可能被删除或改名），请刷新后重试')
    return
  }
  const absPath = scope.allowed.get(key)
  if (absPath === undefined) {
    sendError(res, 400, 'BAD_KEY', '未知的文件 key：它不在当前允许集合里（可能已过期或属于别的工作区）')
    return
  }
  const info = await fileInfo(absPath)
  if (!info.exists) {
    sendError(res, 404, 'NOT_FOUND', '文件不存在')
    return
  }
  const { content, truncated } = await readBounded(absPath, info)
  sendJson(res, 200, {
    ok: true,
    key,
    content,
    size: info.size,
    mtime: info.mtime,
    version: `${info.mtimeMs}-${info.size}`,
    truncated,
  })
}

/**
 * POST /write
 * @param {any} ctx - Cordis 上下文。
 * @param {import('node:http').IncomingMessage} req - node:http 请求对象。
 * @param {import('node:http').ServerResponse} res - node:http 响应对象。
 * @returns {Promise<void>}
 */
async function handleWrite(ctx, req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch (error) {
    if (error?.code === 'TOO_LARGE') sendError(res, 413, 'TOO_LARGE', '请求体超过 1 MiB 上限')
    else sendError(res, 400, 'BAD_KEY', '请求体不是合法 JSON')
    return
  }

  const key = typeof body?.key === 'string' ? body.key : ''
  const content = body?.content
  if (typeof content !== 'string') {
    sendError(res, 400, 'BAD_KEY', 'content 必须是字符串')
    return
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_CONTENT_BYTES) {
    sendError(res, 413, 'TOO_LARGE', `内容 ${bytes} 字节，超过 1 MiB 上限`)
    return
  }

  const workspaceId = typeof body?.workspaceId === 'string' && body.workspaceId.length > 0 ? body.workspaceId : null
  const scope = await buildScope(ctx, workspaceId)
  if (scope.invalidWorkspace) {
    sendError(res, 400, 'BAD_KEY', 'workspaceId 已失效（工作区可能被删除或改名），请刷新后重试')
    return
  }
  const absPath = scope.allowed.get(key)
  if (absPath === undefined) {
    sendError(res, 400, 'BAD_KEY', '未知的文件 key：它不在当前允许集合里（可能已过期或属于别的工作区）')
    return
  }

  // 关键：读版本 → 比对 → 落盘 必须在同一串行区间内完成，
  // 否则两个并发请求都会看到旧 version 而全部通过校验（lost update）。
  const outcome = await serializeByPath(absPath, async () => {
    const before = await fileInfo(absPath)
    // 只认「非空字符串」是有效版本号。`?? null` 对 "" / 0 / false 不生效，
    // 会把它们当成「有版本要求」而导致永远 409 STALE，用户陷入
    // 保存→冲突→覆盖→再冲突 的死循环。空串/其它类型一律按「无条件写」处理。
    const rawExpected = body?.expectedVersion
    const expectedVersion = typeof rawExpected === 'string' && rawExpected.length > 0 ? rawExpected : null
    if (expectedVersion !== null) {
      const currentVersion = before.exists ? `${before.mtimeMs}-${before.size}` : null
      if (currentVersion !== String(expectedVersion)) {
        return { kind: 'stale' }
      }
    }
    try {
      await atomicWrite(absPath, content)
    } catch (error) {
      // 写入失败（目标变目录、权限不足、磁盘满等）要落成契约里的错误形状，
      // 而不是冒泡成笼统的 500 INTERNAL。
      return { kind: 'write-failed', error }
    }
    const after = await fileInfo(absPath)
    return { kind: 'ok', before, after }
  })

  if (outcome.kind === 'stale') {
    sendError(res, 409, 'STALE', '文件已被外部修改，请重新读取后再保存')
    return
  }
  if (outcome.kind === 'write-failed') {
    const code = outcome.error?.code
    // EISDIR / EPERM / EACCES 都是「这个位置不可写」，给用户能看懂的说法
    if (code === 'EISDIR' || code === 'EPERM' || code === 'EACCES') {
      sendError(res, 409, 'STALE', `目标位置不可写（${code}）：它可能已变成目录或权限受限，请重新读取后再试`)
      return
    }
    throw outcome.error
  }

  const { before, after } = outcome
  sendJson(res, 200, {
    ok: true,
    key,
    created: !before.exists,
    version: `${after.mtimeMs}-${after.size}`,
    size: after.size,
    mtime: after.mtime,
  })
}

/**
 * GET /user-tools —— 读取用户自定义的工具清单（供设置页编辑）。
 * POST /user-tools —— 整表替换保存。
 * @param {any} ctx - Cordis 上下文。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @returns {Promise<void>}
 */
async function handleUserTools(ctx, req, res) {
  const homes = resolveHomes()

  if (req.method === 'GET') {
    const cfg = await loadUserTools(homes)
    sendJson(res, 200, {
      ok: true,
      path: tildeDisplay(userConfigPath(homes)),
      tools: cfg.tools.map((t) => ({ id: t.id, name: t.name, vendor: t.vendor, targets: t.targets })),
      error: cfg.error,
    })
    return
  }

  // POST：整表替换。逐条校验，任何一条非法都不写入（避免半残配置）。
  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch (error) {
    if (error?.code === 'TOO_LARGE') sendError(res, 413, 'TOO_LARGE', '请求体超过上限')
    else sendError(res, 400, 'BAD_KEY', '请求体不是合法 JSON')
    return
  }
  const rawList = Array.isArray(body?.tools) ? body.tools : null
  if (rawList === null) {
    sendError(res, 400, 'BAD_KEY', 'tools 必须是数组')
    return
  }
  if (rawList.length > 200) {
    sendError(res, 400, 'BAD_KEY', '自定义工具条目过多（上限 200）')
    return
  }
  const tools = []
  for (let i = 0; i < rawList.length; i++) {
    const norm = normalizeUserTool(rawList[i])
    if (norm === null) {
      sendError(res, 400, 'BAD_KEY', `第 ${i + 1} 条配置不合法：需要 id、name，以及至少一个合法的 targets 项`)
      return
    }
    tools.push(norm)
  }
  // id 不能重复（会撞 key）
  const ids = new Set()
  for (const t of tools) {
    if (ids.has(t.id)) {
      sendError(res, 400, 'BAD_KEY', `id 重复：${t.id}`)
      return
    }
    ids.add(t.id)
  }

  try {
    await saveUserTools(homes, tools)
  } catch (error) {
    sendError(res, 500, 'INTERNAL', `保存配置失败：${error?.message ?? error}`)
    return
  }
  sendJson(res, 200, {
    ok: true,
    path: tildeDisplay(userConfigPath(homes)),
    tools: tools.map((t) => ({ id: t.id, name: t.name, vendor: t.vendor, targets: t.targets })),
  })
}

// ============================================================================
// 路由分发
// ============================================================================

/**
 * 从 req.url 取出前缀之后的路径与查询串。
 * 兼容两种形态：已剥离前缀（契约示例）与未剥离前缀（webServer 只做匹配、不改写 req.url）。
 * @param {string | undefined} rawUrl - req.url。
 * @returns {{ path: string, url: URL }}
 */
function routeOf(rawUrl) {
  let raw = rawUrl ?? '/'
  if (raw === API_PREFIX || raw.startsWith(`${API_PREFIX}/`) || raw.startsWith(`${API_PREFIX}?`)) {
    raw = raw.slice(API_PREFIX.length) || '/'
  }
  let url
  try {
    url = new URL(raw.startsWith('/') ? raw : `/${raw}`, 'http://127.0.0.1')
  } catch {
    // 畸形 URL（如 `//[`）会让 new URL 抛 ERR_INVALID_URL。
    // 这是客户端输入问题，应当回 400 而不是冒泡成 500 INTERNAL。
    url = null
  }
  if (url === null) return null
  const path = url.pathname.replace(/\/+$/, '') || '/'
  return { path, url }
}

/**
 * 处理一个请求：先过信任栅栏，再按路径/方法分发。
 * @param {any} ctx - Cordis 上下文。
 * @param {import('node:http').IncomingMessage} req - node:http 请求对象。
 * @param {import('node:http').ServerResponse} res - node:http 响应对象。
 * @returns {Promise<void>}
 */
async function handleRequest(ctx, req, res) {
  const rejection = trustRejection(ctx, req)
  if (rejection !== 0) {
    sendError(res, rejection, 'FORBIDDEN', '请求未通过信任校验')
    return
  }

  const route = routeOf(req.url)
  if (route === null) {
    sendError(res, 400, 'BAD_KEY', '请求 URL 不合法')
    return
  }
  const { path, url } = route
  if (path === '/state' && req.method === 'GET') return handleState(ctx, url, res)
  if (path === '/read' && req.method === 'GET') return handleRead(ctx, url, res)
  if (path === '/write' && req.method === 'POST') return handleWrite(ctx, req, res)
  if (path === '/user-tools' && (req.method === 'GET' || req.method === 'POST')) return handleUserTools(ctx, req, res)
  if (path === '/state' || path === '/read' || path === '/write' || path === '/user-tools') {
    sendError(res, 400, 'BAD_KEY', `不支持的请求方法 ${req.method}`)
    return
  }
  sendError(res, 404, 'NOT_FOUND', `未知接口 ${path}`)
}

// ============================================================================
// 插件导出
// ============================================================================

export default {
  name: PLUGIN_NAME,
  // 注意：inject 必须是**单个数组**。历史上写成两个 inject 键时后者会覆盖前者，
  // 结果是某个服务没被注入、插件静默什么都不做（不报错）。
  //
  // 为什么 connection 不写进 inject：它是可选服务（无浏览器的 profile 里不存在），
  // 写死会让插件整个不加载。但它是安全栅栏的唯一来源，缺了会降级成「只看回环 Host」，
  // 所以 apply 里会显式检查并大声警告（见下），而不是无声降级。
  inject: ['webServer', 'workspaceRegistry'],
  /**
   * 注册前缀路由。路由随 Cordis fiber 一起销毁（ctx.effect 收集返回的 disposer）。
   * @param {any} ctx - Cordis 上下文。
   */
  apply(ctx) {
    // 安全自查：能读写用户全局规则文件的插件，弱栅栏代价太大。
    // connection 缺失时 trustRejection 只能退化为「Host 是否回环」，
    // 不再校验 Origin / 登录态 —— 必须让用户在日志里看得见。
    try {
      const connection = ctx.get('connection')
      if (connection === undefined || typeof connection.requestRejection !== 'function') {
        ctx.logger?.warn?.(
          `[${PLUGIN_NAME}] connection 服务不可用：HTTP 接口降级为「仅回环 Host」信任模型，` +
            '不再校验 Origin 与登录态。若本机以外的来源可访问该端口，请先修复 connection 服务。',
        )
      }
    } catch {
      // 上下文未就绪时忽略：不影响路由注册，首次请求时 trustRejection 仍会再判一次
    }

    const handler = async (req, res) => {
      try {
        await handleRequest(ctx, req, res)
      } catch (error) {
        try {
          ctx.logger?.warn?.(`[${PLUGIN_NAME}] 处理 ${req?.method} ${req?.url} 失败：${error?.stack ?? error}`)
        } catch {
          // 日志服务异常不能影响响应
        }
        if (res.writableEnded) return
        if (res.headersSent) {
          res.destroy()
          return
        }
        sendError(res, 500, 'INTERNAL', `内部错误：${error?.message ?? error}`)
      }
    }
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
      `${PLUGIN_NAME}: api`,
    )
  },
}
