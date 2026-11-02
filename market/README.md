# 商城收录条目

`index-entry.json` 是提交到 DSH 插件商城索引（`index.json`）的条目，内容已与 npm 上发布的 `0.1.1` 对齐。

> 本目录不在 npm 包的 `files` 中，只作为仓库内的提交素材。

## 已核实的事实

| 项 | 值 |
|---|---|
| npm 包 | `dsh-agents-visualization@0.1.1` |
| 发布源 | `https://registry.npmjs.org/` |
| 发布时间 | `2026-11-02T03:30:52Z`（Unix `1793561452`） |
| tarball | `https://registry.npmjs.org/dsh-agents-visualization/-/dsh-agents-visualization-0.1.1.tgz` |
| shasum | `4cb36b903c62af2bdd4c0f7f9cd33496f51e498b` |
| 仓库 | `https://github.com/LINGTIAN303/dsh-agents-visualization` |

## 提交方式

商城索引由一个 JSON 文件驱动，把 `index-entry.json` 的内容作为数组元素加入对应列表即可（通常提 PR）。

提交前请按商城仓库当前的 `index.json` 校对以下字段，它们一般由商城侧生成、**不需要手工填写**：

- `icon` —— 商城把包内 `icon.svg` 按内容哈希重命名后填入（如 `icons/<sha256>.svg`）
- `metadata.sortKeys` —— GitHub stars / 推荐度等统计值，由索引器采集
- `metadata.labels` —— `trending` / `active` 等标签，由规则自动计算

保留的字段说明：

- `name` / `title` / `description` —— 与包内 `locale/*.json` 的 `meta` 保持一致
- `versions[].source.type = "npm"` —— 表示从 npm 拉取，商城支持 `npm` 与 `git` 两种来源
- `versions[].engines.dsh` —— 仅在 `0.2.1-rc.5` 实测通过，因此声明为 `>=0.2.1-rc.5 <0.3.0-0`

## 后续发版时

新增版本时在 `versions` 数组前（或用商城要求的位置）追加一条：

```jsonc
{
  "version": "<新版本>",
  "publishTimestamp": <npm 上的发布 Unix 时间戳>,
  "source": { "type": "npm", "registry": "https://registry.npmjs.org/" },
  "engines": { "dsh": ">=0.2.1-rc.5 <0.3.0-0" }
}
```

`publishTimestamp` 可从 npm 元数据取：

```bash
npm view dsh-agents-visualization time --json --registry https://registry.npmjs.org/
```
