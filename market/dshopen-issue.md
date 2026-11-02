### 插件地址 / Plugin link

https://github.com/LINGTIAN303/dsh-agents-visualization

npm: `dsh-agents-visualization@0.1.1`

### 简短说明 / Summary

在 DSH 设置里集中查看、创建与编辑 AGENTS.md 等 AI 规则文件：项目级跟随工作区目录链（与 `dsh-agent-instructions` 的加载规则一致），全局级覆盖 `~/.dsh` 与 `~/.agents`，另有一个「第三方集中」Tab 管理 25 个 AI 工具（Claude Code / Codex / Cursor / TRAE / CodeBuddy / OpenCode / Windsurf / Cline / Copilot 等）的用户级规则文件。

主要能力：

- Markdown 渲染态预览（`.mdc` 的 YAML frontmatter 自动剥离），可切源码视图
- 就地编辑，`Ctrl/Cmd + S` 保存，冲突时提示覆盖或重新读取
- 跨工具共用检测：内容完全相同的规则文件互相标注（SHA-256 全文比对）
- 启发式发现内置清单之外的工具；支持在设置页用 JSON 追加自定义工具
- 零运行时依赖

### 补充信息 / Additional details

- 仓库已声明 `dsh.bundle`（`cordis.patch.yml` + `package.json` 的 `dsh.bundle`），可通过 `dsh plugin add dsh-agents-visualization` 安装
- 许可证：MIT
- 已在 DSH `0.2.1-rc.5` 实测：设置页「规则」入口正常，三个 Tab 与读写链路通过端到端验证
- 图标：`icon.svg`（64×64，随包发布）
- 仓库已添加 `dsh-plugin` topic
- 中英双语 README，界面文案 zh/en 两套
