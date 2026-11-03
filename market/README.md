# 商城收录

DSH 社区共有多个插件索引源，收录机制分三类：**人工审核提交**、**自动爬取**、**个人索引**。
本目录存放已备好的提交素材。

> 本目录不在 `package.json` 的 `files` 中，不随 npm 包发布。

## 九个索引源的实际机制

| 索引源 | 插件数 | 性质 | 能否提交 |
|---|---|---|---|
| [dshopen.org](https://dshopen.org/index.json) | 979 | 社区人工审核 | ✅ **Issue 提交** |
| [awesome-dsh-plugin](https://awesome-dsh-plugin.com/index.json) | 4282 | 社区 PR 审核 | ✅ **PR 提交**（见下方前置条件） |
| [jsDelivr catalog](https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json) | 4192 | 即 awesome-dsh-plugin 的 npm 镜像 | ↔ 随 awesome-dsh-plugin 自动更新 |
| [aaamechanic](https://aaamechanic.github.io/dsh-plugin-market/index.json) | 3315 | 上游镜像（与 catalog 交集 3314/3315） | ❌ 自动同步上游 |
| [cdn.dsh.so](https://cdn.dsh.so/market/index.json) | 10403 | 自动安装验证 + 安全审计 | ❌ 自动爬取 npm / GitHub |
| [cdn.dsh.so/top-rank](https://cdn.dsh.so/market/top-rank.json) | 1200 | 排行榜（派生数据） | ❌ 自动生成 |
| [shutongX](https://shutongx.github.io/dsh-plugins-index/index.json) | 4 | 个人索引，仅收自己的仓库 | ❌ 不收外部 |
| [bruc3van](https://bruc3van.com/dsh-plugins/index.json) | 1000 | 个人精选索引 | ❌ 未见公开提交入口 |
| [kingcharleslzy](https://kingcharleslzy-ai.github.io/dsh-purge/index.json) | 2 | 个人索引，仅收自己的仓库 | ❌ 不收外部 |

**结论**：真正能主动提交的只有两家 —— **dshopen.org** 和 **awesome-dsh-plugin**。其余要么自动爬取（发布 npm 后可能自行出现），要么是个人索引。

## 1. dshopen.org

**提交方式**：GitHub Issue（表单）

1. 打开 https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml
2. 三个表单字段分别粘贴 `dshopen-issue.md` 中对应的段落
3. 标题填 `[plugin-add] dsh-agents-visualization`

**收录要求**（官方 README 原文归纳）：
- 公开源码 ✅
- 有可安装的 npm 版本 ✅（`dsh-agents-visualization@0.1.4`）
- 明确的许可证 ✅（MIT）
- 有 Logo 与完善描述的优先 ✅

## 2. awesome-dsh-plugin

**提交方式**：向 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin 提 PR，新增**一个文件**
`data/plugins/LINGTIAN303__dsh-agents-visualization.yml`，内容即 `awesome-dsh-plugin.yml`。

**前置条件核对**：

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ |
| 仓库含真实可用代码（非占位） | ✅ |
| 仓库创建满 **1 天** | ⏳ 2026-11-03 11:05 (+08) 之后 |
| 仓库添加 `dsh-plugin` topic | ✅ 已添加 |
| 描述属实、无营销词 | ✅ 仅陈述功能 |

> 第 3 条由 CI 自动检查。仓库建于 2026-11-02 11:05 (+08)，**次日上午再提交**即可。
> 官方说明：刚好不达标时先做完再提交，重新提交不会有任何负面影响。

**分类选择**：`category: tools`（Tools & Capabilities）。该列表可选值：
`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`

**注意**：
- `icon` 字段要求 **GitHub 托管的位图**（PNG/JPEG），本项目只有 `icon.svg`，因此省略 —— 省略时会回退到作者头像，不影响收录
- 描述里含 `: `（冒号加空格）必须加引号，否则 YAML 解析失败

## 自动收录的可能性

`cdn.dsh.so`（10403 条）与 `aaamechanic`（镜像）不需要手动提交：

- `cdn.dsh.so` 声称只收「通过真实沙盒安装验证（L4/L5）且安全结论低风险」的条目，属于自动流水线产物
- 包已发布到 npm 并声明 `dsh.bundle`，满足自动抓取的基本条件，后续可能自行出现

## 索引条目格式（供参考）

`index-entry.json` 是标准 format-1 索引条目，与 npm 上的实际元数据对齐（当前最新 `0.1.4`）：

| 项 | 值 |
|---|---|
| version | `0.1.4` |
| publishTimestamp | `1793804145`（2026-11-03T18:55:45Z） |
| source | `npm` / `https://registry.npmjs.org/` |
| engines.dsh | `>=0.2.1-rc.5 <0.3.0-0` |
| shasum | `4cb36b903c62af2bdd4c0f7f9cd33496f51e498b` |

`icon`、`metadata.sortKeys`、`metadata.labels` 通常由索引器自动生成，无需手填。

## 后续发版

新增版本时，更新 `index-entry.json` 的 `versions` 数组：

```jsonc
{
  "version": "<新版本>",
  "publishTimestamp": <npm 发布 Unix 时间戳>,
  "source": { "type": "npm", "registry": "https://registry.npmjs.org/" },
  "engines": { "dsh": ">=0.2.1-rc.5 <0.3.0-0" }
}
```

时间戳获取：

```bash
npm view dsh-agents-visualization time --json --registry https://registry.npmjs.org/
```
