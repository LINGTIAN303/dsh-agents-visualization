/**
 * dsh-agents-visualization —— 客户端（浏览器）半边：DSH「设置」里的 AGENTS.md 可视化页
 *
 * 数据流：settings.section ⇄ 同源 fetch `/dsh-agents-visualization/api/*` ⇄ Host 半边（index.js）
 *   契约见 docs/contract.md：客户端**只发 workspaceId + key**，绝不发绝对路径
 *   （Host 每次请求都按 workspaceId 重新计算完整允许集合，再按 key 查表）。
 *
 * 三份状态，彼此不重复请求：
 *   1) /state —— 工作区列表 + 全局/项目的文件清单（exists / size / mtime / duplicateOf）
 *   2) /read  —— 选中文件的内容 + version（乐观并发用；404 视为「未创建」）
 *   3) /write —— 保存；expectedVersion 不一致时 Host 回 409 STALE，这里给「覆盖 / 重新读取」两条路
 *   注意：只读回前 1 MiB（truncated），此时**禁止编辑**，否则写回会把文件截断 —— 见 truncatedNotice 分支。
 *
 * 渲染约定：
 *   - 样式用 React 元素 `<style>` 随组件挂载 / 卸载，不碰 document.head / document.body。
 *   - 颜色只取 `--dsw-alias-*` 主题 token；需要半透明底时用 color-mix 从 token 派生（先写纯 token 兜底值）。
 *   - 这是设置面板里的一页内容，不画侧边栏 / 全屏 / 标题栏，也不读别的插件的 DOM。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agents-visualization',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef, useMemo } = React;

    // ── 常量 ────────────────────────────────────────────────────────────────
    const API = '/dsh-agents-visualization/api';
    const NS = 'agents-md';
    const MAX_BYTES = 1048576; // 与 Host / /read 的 1 MiB 上限一致
    const PREVIEW_LIMIT = 200000; // 预览最多渲染的字符数（纯性能保护，不是契约约束）
    const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace';

    // ── 样式（全部走 --dsw-alias-* 主题 token）──────────────────────────────
    const CSS = [
      // 容器：设置页里的一页内容
      '.amv-section{display:flex;flex-direction:column;gap:14px;max-width:840px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.amv-hd{display:flex;flex-direction:column;gap:3px}',
      '.amv-title{margin:0;font-size:15px;line-height:22px;font-weight:600}',
      '.amv-intro{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}',
      // 顶部提示条（错误 / 成功 / 警示）：先给纯 token 兜底，再用 color-mix 叠一层淡色底
      '.amv-banner{display:flex;align-items:flex-start;gap:8px;padding:8px 11px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:12.5px;line-height:18px}',
      '.amv-banner-err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-1))}',
      '.amv-banner-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,var(--dsw-alias-bg-layer-1))}',
      '.amv-banner-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,var(--dsw-alias-bg-layer-1))}',
      '.amv-banner-txt{flex:1;min-width:0;word-break:break-word}',
      '.amv-banner-col{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
      // Tab：轻量药丸，不做大按钮
      '.amv-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);align-self:flex-start}',
      '.amv-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;line-height:18px;padding:4px 12px;border-radius:6px;cursor:pointer}',
      '.amv-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.amv-tab[aria-selected=true]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}',
      // 工作区选择行
      '.amv-field{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.amv-field-label{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);flex-shrink:0}',
      '.amv-select{appearance:none;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;line-height:18px;height:28px;padding:0 26px 0 8px;max-width:340px;min-width:180px;outline:none;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 14px) 12px,calc(100% - 10px) 12px;background-size:4px 4px,4px 4px;background-repeat:no-repeat}',
      '.amv-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.amv-select:disabled{opacity:.5;cursor:default}',
      '.amv-select option{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.amv-root{display:flex;align-items:center;gap:6px;min-width:0;font-family:' + MONO + ';font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.amv-root-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      // 文件列表
      '.amv-pane{display:flex;flex-direction:column;gap:10px}',
      '.amv-group{display:flex;flex-direction:column;gap:2px}',
      '.amv-group-hd{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);padding:0 10px 2px}',
      '.amv-count{font-variant-numeric:tabular-nums;opacity:.75}',
      '.amv-list{display:flex;flex-direction:column;gap:2px}',
      '.amv-row{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;padding:7px 10px;border-radius:7px;border:.5px solid transparent;background:transparent;color:inherit;font-family:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;user-select:none}',
      '.amv-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 7%,transparent)}',
      '.amv-row:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.amv-row[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
      '.amv-row[data-missing=true] .amv-row-path{color:var(--dsw-alias-label-secondary)}',
      '.amv-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:0}',
      '.amv-row-path{font-family:' + MONO + ';font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.amv-row-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.amv-row-side{display:flex;align-items:center;gap:8px;flex-shrink:0}',
      '.amv-icon{flex-shrink:0;color:var(--dsw-alias-label-secondary)}',
      '.amv-icon-brand{color:var(--dsw-alias-brand-primary)}',
      '.amv-icon-ok{color:var(--dsw-alias-state-success-primary)}',
      '.amv-icon-warn{color:var(--dsw-alias-state-warn-primary)}',
      // 徽章
      '.amv-badge{display:inline-flex;align-items:center;gap:4px;flex-shrink:0;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 13%,transparent);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.amv-badge-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.amv-badge-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 15%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.amv-badge-idle{background:color-mix(in srgb,var(--dsw-alias-state-idle-primary) 18%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.amv-badge-plain{background:transparent;padding:0}',
      // 全局卡片
      '.amv-cards{display:flex;flex-direction:column;gap:8px}',
      '.amv-card{display:flex;flex-direction:column;width:100%;box-sizing:border-box;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font-family:inherit;text-align:left;cursor:pointer;overflow:hidden}',
      '.amv-card:hover{border-color:var(--dsw-alias-border-l1)}',
      '.amv-card:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.amv-card[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary)}',
      '.amv-card-hd{display:flex;align-items:center;gap:8px;padding:8px 11px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.amv-card-path{flex:1;min-width:0;font-family:' + MONO + ';font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.amv-card-bd{display:flex;flex-direction:column;gap:4px;padding:9px 11px}',
      '.amv-card-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.amv-card-hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      // 说明块 / 警示小行
      '.amv-notes{display:flex;flex-direction:column;gap:4px;padding:8px 11px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.amv-note{display:flex;align-items:flex-start;gap:7px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.amv-note-warn{display:flex;align-items:flex-start;gap:6px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary);word-break:break-word}',
      // 详情面板
      '.amv-detail{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.amv-meta{display:flex;align-items:flex-start;gap:10px;padding:8px 11px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.amv-meta-main{flex:1;min-width:180px;display:flex;flex-direction:column;gap:2px}',
      '.amv-meta-path{font-family:' + MONO + ';font-size:12.5px;line-height:18px;word-break:break-all}',
      '.amv-meta-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.amv-meta-side{display:flex;align-items:center;gap:6px;flex-shrink:0}',
      '.amv-dot{width:2px;height:2px;border-radius:50%;background:currentColor;opacity:.55;flex-shrink:0}',
      // 预览 / 编辑 分段控件
      '.amv-seg{display:inline-flex;padding:2px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}',
      '.amv-seg-btn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:16px;padding:3px 10px;border-radius:5px;cursor:pointer}',
      '.amv-seg-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.amv-seg-btn:disabled{opacity:.45;cursor:default}',
      '.amv-seg-btn[aria-selected=true]{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent);color:var(--dsw-alias-label-primary)}',
      // 按钮
      '.amv-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;box-sizing:border-box;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.amv-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-secondary) 10%,transparent)}',
      '.amv-btn:disabled{opacity:.45;cursor:default}',
      '.amv-btn:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.amv-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base))}',
      '.amv-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.88}',
      '.amv-spacer{flex:1}',
      // 预览区
      '.amv-preview{margin:0;padding:11px 12px;max-height:420px;overflow:auto;background:var(--dsw-alias-bg-base);font-family:' + MONO + ';font-size:12.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);tab-size:2}',
      '.amv-preview-empty{color:var(--dsw-alias-label-secondary);font-style:normal}',
      // 渲染态：把 Markdown 排成可读的文档样式（不是源码）
      '.amv-md{padding:12px 14px;max-height:420px;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.7;overflow-wrap:anywhere}',
      '.amv-md>*:first-child{margin-top:0}',
      '.amv-md>*:last-child{margin-bottom:0}',
      '.amv-md h1,.amv-md h2,.amv-md h3,.amv-md h4,.amv-md h5,.amv-md h6{margin:16px 0 8px;font-weight:600;line-height:1.35}',
      '.amv-md h1{font-size:19px;padding-bottom:6px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.amv-md h2{font-size:16px;padding-bottom:5px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.amv-md h3{font-size:14px}',
      '.amv-md h4,.amv-md h5,.amv-md h6{font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.amv-md p{margin:8px 0}',
      '.amv-md ul,.amv-md ol{margin:8px 0;padding-left:22px}',
      '.amv-md li{margin:3px 0}',
      '.amv-md li>ul,.amv-md li>ol{margin:3px 0}',
      '.amv-md blockquote{margin:8px 0;padding:2px 0 2px 11px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.amv-md code{font-family:' + MONO + ';font-size:11.5px;padding:1px 4px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent)}',
      '.amv-md pre{margin:9px 0;padding:9px 11px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);overflow:auto}',
      '.amv-md pre code{padding:0;background:none;font-size:11.5px;line-height:1.55;white-space:pre}',
      '.amv-md table{width:100%;border-collapse:collapse;margin:9px 0;font-size:12px}',
      '.amv-md th,.amv-md td{padding:5px 9px;border:.5px solid var(--dsw-alias-border-l2);text-align:left;vertical-align:top}',
      '.amv-md th{background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '.amv-md hr{margin:14px 0;border:none;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.amv-md a{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.amv-md a:hover{text-decoration:underline}',
      '.amv-md strong{font-weight:600}',
      // 渲染 / 源码 切换
      '.amv-prebar{display:flex;align-items:center;gap:8px;padding:6px 11px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      // 内联详情：选中项下方就地展开，与所属文件视觉同组
      '.amv-inline{display:flex;flex-direction:column;gap:2px}',
      '.amv-inline .amv-row[aria-expanded=true]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);border-bottom-left-radius:0;border-bottom-right-radius:0}',
      '.amv-inline .amv-card[aria-expanded=true]{border-bottom-left-radius:0;border-bottom-right-radius:0;border-bottom-color:transparent}',
      '.amv-inline .amv-detail{border-top-left-radius:0;border-top-right-radius:0;margin-top:-1px}',
      '.amv-inline .amv-card+.amv-detail{border-top-left-radius:0;border-top-right-radius:0}',
      // 第三方集中
      '.amv-tool{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.amv-tool-hd{display:flex;align-items:center;gap:7px;padding:7px 11px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.amv-tool-name{font-size:12.5px;line-height:18px;font-weight:600}',
      '.amv-tool-vendor{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.amv-tool-dir{font-family:' + MONO + ';font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px}',
      '.amv-tool-empty{padding:9px 11px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.amv-absent{display:flex;flex-direction:column;gap:6px;padding:9px 11px;border-radius:8px;border:.5px dashed var(--dsw-alias-border-l2)}',
      '.amv-absent-hd{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.amv-absent-list{display:flex;flex-direction:column;gap:3px}',
      '.amv-absent-item{display:flex;align-items:baseline;gap:8px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}',
      '.amv-absent-dir{font-family:' + MONO + ';font-size:10.5px;line-height:15px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.amv-tool-note{display:flex;align-items:flex-start;gap:6px;padding:6px 11px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      // 第三方子Tab：横向可滚动的工具切换条（工具多时收进滚动，不换行撑高页面）
      '.amv-subtabs{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow-x:auto;max-width:100%;scrollbar-width:thin}',
      '.amv-subtab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;flex-shrink:0;display:inline-flex;align-items:center;gap:5px}',
      '.amv-subtab:hover{color:var(--dsw-alias-label-primary)}',
      '.amv-subtab[aria-selected=true]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}',
      // 自定义工具面板
      '.amv-custom{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.amv-custom-hd{display:flex;align-items:center;gap:7px;padding:7px 11px;background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}',
      '.amv-custom-title{font-size:12.5px;line-height:18px;font-weight:600}',
      '.amv-custom-bd{display:flex;flex-direction:column;gap:8px;padding:12px 11px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.amv-custom-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.amv-custom-ta{min-height:180px;height:200px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:11.5px}',
      '.amv-custom-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.amv-shared{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-state-warn-primary)}',
      '.amv-trunc{color:var(--dsw-alias-state-warn-primary)}',
      '.amv-shared-note{display:flex;align-items:flex-start;gap:7px;padding:8px 11px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,var(--dsw-alias-bg-layer-1));border-bottom:.5px solid var(--dsw-alias-border-l2);word-break:break-word}',
      // 编辑区
      '.amv-editor{display:flex;flex-direction:column}',
      '.amv-textarea{display:block;width:100%;box-sizing:border-box;min-height:260px;height:340px;padding:11px 12px;border:none;outline:none;resize:vertical;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:' + MONO + ';font-size:12.5px;line-height:1.6;tab-size:2}',
      '.amv-textarea:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}',
      '.amv-editor-bar{display:flex;align-items:center;gap:8px;padding:6px 11px;background:var(--dsw-alias-bg-layer-2);border-top:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.amv-stat{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      // 指标行：详情面板 / 工具头部共用的一组「标签+值」
      '.amv-metrics{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:11.5px;line-height:17px;font-variant-numeric:tabular-nums}',
      '.amv-metrics-label{color:var(--dsw-alias-label-secondary)}',
      '.amv-metrics-value{color:var(--dsw-alias-label-primary)}',
      '.amv-kbd{font-family:' + MONO + ';font-size:10.5px;line-height:15px;padding:0 4px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.amv-dirty{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary)}',
      '.amv-over{font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-error-primary)}',
      // 冲突条
      '.amv-conflict{display:flex;flex-direction:column;gap:8px;margin:10px 11px 0;padding:9px 11px;border-radius:8px;border:.5px solid var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,var(--dsw-alias-bg-layer-1))}',
      '.amv-conflict-title{font-size:12.5px;line-height:18px;font-weight:600;color:var(--dsw-alias-state-warn-primary)}',
      '.amv-conflict-body{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.amv-conflict-actions{display:flex;gap:8px;flex-wrap:wrap}',
      // 空状态（文件不存在）
      '.amv-empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:30px 20px;background:var(--dsw-alias-bg-base);text-align:center}',
      '.amv-empty-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.amv-empty-body{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);max-width:480px;overflow-wrap:anywhere}',
      '.amv-empty-code{font-family:' + MONO + ';font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.amv-empty-actions{display:flex;gap:8px;margin-top:4px}',
      // 加载态
      '.amv-loading{display:flex;align-items:center;gap:7px;padding:16px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      // 面板内边距（提示条贴在详情框顶部时用）
      '.amv-inset{margin:10px 11px 0}',
      '.amv-inset-b{padding:8px 12px 0}',
      // 窄屏（设置面板被拉窄时）收紧
      '@media (max-width:520px){.amv-row-side{display:none}.amv-select{max-width:100%;min-width:0;width:100%}}',
    ].join('');

    // ── 文案（zh / en 两套，key 必须一一对应）──────────────────────────────
    const zh = {
      nav: '规则',
      title: '规则（AGENTS.md）',
      intro: '查看、创建与编辑 DSH 实际会加载的 AGENTS.md：项目级跟随所选工作区的目录链，全局级覆盖 ~/.dsh 与 ~/.agents。',
      tabProject: '项目级',
      tabGlobal: '全局级',
      tabThird: '第三方集中',
      workspaceLabel: '工作区',
      workspaceNone: '当前没有已注册的工作区，暂时只能管理全局级文件。',
      projectRoot: '项目根：{root}',
      projectEmpty: '这个工作区的目录链上没有任何候选文件。',
      groupExists: '已存在',
      groupMissing: '未创建',
      globalDshHint: '优先级更高：与另一份全局文件内容相同时，这一份生效。',
      globalAgentsHint: '优先级较低：与 ~/.dsh 那份内容相同时不会重复加载。',
      globalEmpty: '没法解析全局目录（配置缺失），全局级暂时不可用。',
      thirdEmpty: '没有可扫描的第三方工具。',
      thirdNoRules: '这个工具已安装，但还没有写规则文件。',
      thirdAbsentTitle: '未检测到 {n} 个工具（配置目录不存在）',
      thirdShared: '内容与 {names} 完全相同',
      thirdTruncated: '目录内共 {total} 个规则文件，这里只列出前 {shown} 个。',
      thirdFiles: '{n} 个文件',
      customSubtab: '自定义工具',
      metricOccupied: '占用字节',
      metricInjected: '注入字节',
      metricChars: '已用字数',
      metricTokens: 'token 占用',
      metricTokensApprox: '≈{n}',
      metricSubtab: '{n} · ≈{t} token',
      metricToolSummary: '共 {n} 个文件 · 注入 {b} · ≈{t} token',
      metricInjectHint: '注入字节 = 剥离 YAML frontmatter、去首尾空白后的有效内容字节数（工具真正注入上下文的部分）。',
      metricTokenHint: 'token 为启发式估算：中日韩字符按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token，仅供量级参考。',
      confLow: '路径为推测',
      confLowTip: '该路径既无官方文档依据、本机也没有实测到，属于推测，请谨慎参考。',
      srcOfficial: '来源：官方文档',
      srcDisk: '来源：本机磁盘实测（文件确实存在，但未见于官方文档）',
      srcUnverified: '来源：社区资料，本机未扫到该位置（可能未安装）',
      srcInferred: '来源：按同类工具惯例推测，未经验证',
      customTitle: '自定义工具',
      customCount: '{n} 条',
      customHint: '下面已给出模板，直接改值即可；也可以全选删掉、粘贴自己的。保存到 {path}。kind 可取 file / dir / glob；未收录的工具若含 AGENTS.md 或 rules/ 目录也会自动发现。',
      customPlaceholder: '在这里填写 JSON 数组，或点下方「填入模板」',
      customFillTemplate: '填入模板',
      customClear: '清空',
      customReloadTitle: '丢弃当前草稿，重新读取已保存的配置',
      customSave: '保存',
      customReload: '重新读取',
      customSaved: '已保存，清单已刷新。',
      customLoadFail: '读取配置失败：{msg}',
      customSaveFail: '保存失败：{msg}',
      customBadJson: 'JSON 语法错误：{msg}',
      customNeedArray: '顶层必须是数组，例如 [{"id":...}]。',
      badgeLoaded: 'DSH 会加载',
      badgeSkipped: '不会加载',
      badgeExists: '已创建',
      badgeMissing: '未创建',
      dupOf: '内容与 {path} 相同，DSH 只会加载前一份',
      missingTitle: '这个文件还没创建',
      missingBody: '将在 {path} 创建它。创建后可继续编辑，DSH 会在新的会话里加载。',
      missingOther: '同一目录下已有其它约定文件，确认是否还要创建这一份。',
      create: '创建',
      creating: '创建中…',
      modePreview: '预览',
      modeEdit: '编辑',
      refresh: '重新读取',
      loading: '读取中…',
      loadingState: '正在读取文件清单…',
      emptyFile: '文件是空的（0 字节）。DSH 加载它不会产生任何指令。',
      truncatedNotice: '文件超过 1 MiB，这里只显示前 1 MiB。',
      editBlocked: '文件超过 1 MiB（已截断）。为避免写回时丢掉后面的内容，这里禁止编辑，请直接用外部编辑器修改。',
      previewClipped: '内容较长，预览只显示前 {n} 个字符。',
      previewRendered: '排版预览',
      pvRendered: '渲染',
      pvSource: '源码',
      save: '保存',
      saving: '保存中…',
      revert: '放弃改动',
      unsaved: '有未保存的改动',
      saved: '已保存',
      bytesCount: '{n} 字节',
      tooLarge: '内容超过 1 MiB，无法保存。',
      ctrlS: 'Ctrl+S 保存',
      editorLabel: 'AGENTS.md 内容',
      conflictTitle: '保存冲突',
      conflictBody: '文件在你编辑期间被改过（版本不一致）。选一个处理方式：',
      overwrite: '覆盖保存',
      errState: '文件清单加载失败：{msg}',
      errRead: '读取失败：{msg}',
      errSave: '保存失败：{msg}',
      retry: '重试',
      notesTitle: '说明',
      template:
        '# AGENTS.md\n\n<!-- 写给 AI 的约定。只留必要信息：范围、命令、约定、注意事项。 -->\n\n## 范围\n\n\n## 命令\n\n- 构建：\n- 测试：\n\n## 约定\n\n',
    };

    const en = {
      nav: 'Rules',
      title: 'Rules (AGENTS.md)',
      intro: 'Inspect, create and edit the AGENTS.md files DSH actually loads: project scope follows the selected workspace chain, global scope covers ~/.dsh and ~/.agents.',
      tabProject: 'Project',
      tabGlobal: 'Global',
      tabThird: 'Third-party',
      workspaceLabel: 'Workspace',
      workspaceNone: 'No workspace is registered yet, so only global files can be managed.',
      projectRoot: 'Project root: {root}',
      projectEmpty: 'The workspace directory chain has no candidate files.',
      groupExists: 'Existing',
      groupMissing: 'Not created',
      globalDshHint: 'Higher priority: when both global files have the same content, this one wins.',
      globalAgentsHint: 'Lower priority: not loaded again when it matches the ~/.dsh copy.',
      globalEmpty: 'Global directories could not be resolved (missing configuration); global scope is unavailable.',
      thirdEmpty: 'No third-party tools to scan.',
      thirdNoRules: 'This tool is installed but has no rule files yet.',
      thirdAbsentTitle: '{n} tools not detected (config directory missing)',
      thirdShared: 'Identical content to {names}',
      thirdTruncated: 'This directory has {total} rule files; only the first {shown} are listed.',
      thirdFiles: '{n} files',
      customSubtab: 'Custom tools',
      metricOccupied: 'On-disk bytes',
      metricInjected: 'Injected bytes',
      metricChars: 'Characters',
      metricTokens: 'Tokens (est.)',
      metricTokensApprox: '≈{n}',
      metricSubtab: '{n} · ≈{t} tok',
      metricToolSummary: '{n} files · {b} injected · ≈{t} tokens',
      metricInjectHint: 'Injected bytes = content after stripping YAML frontmatter and trimming whitespace — the part a tool actually injects into context.',
      metricTokenHint: 'Tokens are heuristic estimates: CJK characters ≈ 1 token each, everything else ≈ 1 token per 4 characters.',
      confLow: 'Path inferred',
      confLowTip: 'This path is neither documented officially nor found on this machine; treat it as a guess.',
      srcOfficial: 'Source: official documentation',
      srcDisk: 'Source: found by scanning this machine (the files exist, but the path is not in official docs)',
      srcUnverified: 'Source: community reports; nothing was found at this location (the tool may not be installed)',
      srcInferred: 'Source: inferred by analogy with similar tools; unverified',
      customTitle: 'Custom tools',
      customCount: '{n} entries',
      customHint:
        'A template is pre-filled below — just change the values, or select all and paste your own. Saved to {path}. kind is file / dir / glob; tools containing an AGENTS.md or a rules/ directory are also discovered automatically.',
      customPlaceholder: 'Enter a JSON array here, or click "Fill template" below',
      customFillTemplate: 'Fill template',
      customClear: 'Clear',
      customReloadTitle: 'Discard the current draft and reload the saved configuration',
      customSave: 'Save',
      customReload: 'Reload',
      customSaved: 'Saved; the list has been refreshed.',
      customLoadFail: 'Failed to read the configuration: {msg}',
      customSaveFail: 'Failed to save: {msg}',
      customBadJson: 'JSON syntax error: {msg}',
      customNeedArray: 'The top level must be an array, for example [{"id":...}].',
      badgeLoaded: 'DSH loads this',
      badgeSkipped: 'Not loaded',
      badgeExists: 'Created',
      badgeMissing: 'Not created',
      dupOf: 'Same content as {path}; DSH loads only the first one',
      missingTitle: 'This file does not exist yet',
      missingBody: 'It will be created at {path}. You can keep editing afterwards; DSH loads it in the next session.',
      missingOther: 'Another rules file already exists in the same directory — make sure you still want this one.',
      create: 'Create',
      creating: 'Creating…',
      modePreview: 'Preview',
      modeEdit: 'Edit',
      refresh: 'Reload',
      loading: 'Reading…',
      loadingState: 'Reading the file list…',
      emptyFile: 'The file is empty (0 bytes). Loading it produces no instructions.',
      truncatedNotice: 'The file is larger than 1 MiB; only the first 1 MiB is shown here.',
      editBlocked: 'The file is larger than 1 MiB (truncated). Editing is disabled so that saving cannot drop the rest — use an external editor instead.',
      previewClipped: 'The content is long; only the first {n} characters are previewed.',
      previewRendered: 'Rendered preview',
      pvRendered: 'Rendered',
      pvSource: 'Source',
      save: 'Save',
      saving: 'Saving…',
      revert: 'Discard changes',
      unsaved: 'Unsaved changes',
      saved: 'Saved',
      bytesCount: '{n} bytes',
      tooLarge: 'The content is larger than 1 MiB and cannot be saved.',
      ctrlS: 'Ctrl+S to save',
      editorLabel: 'AGENTS.md content',
      conflictTitle: 'Save conflict',
      conflictBody: 'The file changed while you were editing it (version mismatch). Pick one:',
      overwrite: 'Overwrite',
      errState: 'Failed to load the file list: {msg}',
      errRead: 'Failed to read: {msg}',
      errSave: 'Failed to save: {msg}',
      retry: 'Retry',
      notesTitle: 'Notes',
      template:
        '# AGENTS.md\n\n<!-- Rules for the AI. Keep it short: scope, commands, conventions, caveats. -->\n\n## Scope\n\n\n## Commands\n\n- Build:\n- Test:\n\n## Conventions\n\n',
    };

    // apply() 里会被替换成 ctx.locale.bind(NS)；先给一份兜底，保证渲染期永不拿到 undefined。
    let activeT = (key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key);

    // ── 工具函数 ───────────────────────────────────────────────────────────
    const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

    /** UTF-8 字节数（Host 侧上限就是按字节算的，不能用 length） */
    function utf8Bytes(text) {
      const s = typeof text === 'string' ? text : '';
      if (encoder) return encoder.encode(s).length;
      let n = 0;
      for (const ch of s) {
        const c = ch.codePointAt(0) || 0;
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
      }
      return n;
    }

    function formatBytes(n) {
      const v = Number(n) || 0;
      if (v <= 0) return '0 B';
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB';
      return (v / 1048576).toFixed(1) + ' MB';
    }

    // ── 注入统计（与 Host 端 index.js 的 injectionStats 保持同一口径）────────
    // 为什么客户端也算一份：编辑器里改内容时，四项指标要实时跟着跳动，
    // 而不能等保存后再刷新清单；两端口径必须逐字一致，否则详情与清单对不上。

    /** CJK 码点判定：中日韩表意文字 / 假名 / 谚文，1 字 ≈ 1 token。 */
    const isCjkCodePoint = (cp) =>
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af);

    /**
     * 按注入口径统计一段规则文本。
     * 剥 YAML frontmatter → trim → 注入字节 / 字数 / 估算 token。
     * @param {string} text - 原始文本。
     * @returns {{ injectBytes: number, chars: number, tokens: number }}
     */
    function injectionStats(text) {
      const source = typeof text === 'string' ? text : '';
      const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(source);
      const body = (m ? source.slice(m[0].length) : source).trim();
      let cjk = 0;
      let other = 0;
      for (const ch of body) {
        const cp = ch.codePointAt(0) || 0;
        if (isCjkCodePoint(cp)) cjk++;
        else other++;
      }
      return { injectBytes: utf8Bytes(body), chars: cjk + other, tokens: cjk + Math.ceil(other / 4) };
    }

    /** 本地时间 YYYY-MM-DD HH:mm（固定格式，不依赖浏览器 locale） */
    function formatTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function errText(e) {
      if (!e) return 'unknown';
      const code = e.code && String(e.code).indexOf('HTTP_') !== 0 ? e.code + ' · ' : '';
      return code + (e.message || 'unknown');
    }

    // ── 极简 Markdown 渲染器 ───────────────────────────────────────────────
    // 为什么自己写：插件不能引入第三方依赖（契约 §4 禁止 require 任何外部包），
    // 而 AGENTS.md 是给人看的规则文档，预览态必须呈现成排版后的样子才有意义。
    // 安全：全程用 React 元素构造（不走 innerHTML），天然免疫 XSS —— 文件里的
    // HTML 标签只会被当成普通文本渲染，不会被解析成 DOM。
    // 支持：标题、段落、有序/无序列表（含嵌套）、围栏代码块、引用、分割线、
    //      表格、以及行内的 **粗体** / *斜体* / `代码` / [链接](url)。

    /** 行内解析：把一段文本切成 React 元素数组（只认最常用的几种行内语法） */
    function inline(text, keyPrefix) {
      const out = [];
      // 一次正则扫完：代码 > 链接 > 粗体 > 斜体。代码最先匹配，避免内部符号被再解析。
      const re = /`([^`]+)`|\[([^\]]*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
      let last = 0;
      let m;
      let n = 0;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const k = keyPrefix + '-' + n++;
        if (m[1] !== undefined) out.push(h('code', { key: k }, m[1]));
        else if (m[2] !== undefined) {
          // 链接：只允许 http/https 协议，其余（含 javascript:）退化成纯文本，防止脚本注入
          const href = m[3];
          if (/^https?:\/\//i.test(href)) {
            out.push(
              h('a', { key: k, href, target: '_blank', rel: 'noopener noreferrer' }, m[2] || href),
            );
          } else out.push(h('span', { key: k }, m[2] || href));
        } else if (m[4] !== undefined && m[4].length > 0) out.push(h('strong', { key: k }, m[4]));
        else if (m[5] !== undefined && m[5].length > 0) out.push(h('strong', { key: k }, m[5]));
        else if (m[6] !== undefined && m[6].length > 0) out.push(h('em', { key: k }, m[6]));
        else if (m[7] !== undefined && m[7].length > 0) out.push(h('em', { key: k }, m[7]));
        last = re.lastIndex;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }

    /**
     * 剥掉文件头的 YAML frontmatter（`---` 开头、下一条 `---` 结束）。
     * 只处理「文件第一行就是 ---」的情况，避免把正文里的分割线误伤。
     * @param {string} text - 原始文本
     * @returns {string} 去掉 frontmatter 后的正文
     */
    function stripFrontmatter(text) {
      // 开头 `---` 行 + 任意内容（含空）+ 一行 `---`
      const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text);
      return m ? text.slice(m[0].length) : text;
    }

    /** 判定表格分隔行：| --- | :---: | ---: | */
    function isTableDivider(line) {
      return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.indexOf('-') >= 0;
    }

    /** 按未转义的 | 切表格行（支持 \| 转义） */
    function splitRow(line) {
      const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      const cells = [];
      let cur = '';
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
        if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
        cur += s[i];
      }
      cells.push(cur.trim());
      return cells;
    }

    /**
     * 把 Markdown 文本渲染成 React 元素数组。
     * @param {string} src - 原始 Markdown 文本
     * @returns {Array} React 子节点数组
     */
    function renderMarkdown(src) {
      const text = String(src ?? '').replace(/\r\n?/g, '\n');
      // Cursor / CodeBuddy 系的 .mdc 在文件头带 YAML frontmatter。
      // 直接渲染会把 `---` 当成水平线、把元数据当正文，所以要整体剥掉。
      const stripped = stripFrontmatter(text);
      const lines = stripped.split('\n');
      const out = [];
      let i = 0;
      let key = 0;
      const nextKey = () => 'md-' + key++;

      while (i < lines.length) {
        const line = lines[i];

        // 围栏代码块：``` 或 ~~~ 开头，直到同种围栏闭合（未闭合则吃到文末）
        const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
          const mark = fence[1][0];
          const len = fence[1].length;
          const lang = fence[2].trim();
          const buf = [];
          i++;
          while (i < lines.length) {
            const close = new RegExp('^\\s*' + (mark === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
            if (close.test(lines[i])) { i++; break; }
            buf.push(lines[i]);
            i++;
          }
          out.push(
            h(
              'pre',
              { key: nextKey() },
              h('code', lang ? { 'data-lang': lang } : null, buf.join('\n')),
            ),
          );
          continue;
        }

        // 空行
        if (/^\s*$/.test(line)) { i++; continue; }

        // 分割线
        if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
          out.push(h('hr', { key: nextKey() }));
          i++;
          continue;
        }

        // 标题 # ~ ######
        const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
          const level = heading[1].length;
          out.push(h('h' + level, { key: nextKey() }, inline(heading[2], 'h' + key)));
          i++;
          continue;
        }

        // 表格：当前行含 |，下一行是分隔行
        if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
          const head = splitRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) {
            rows.push(splitRow(lines[i]));
            i++;
          }
          out.push(
            h(
              'table',
              { key: nextKey() },
              h('thead', null, h('tr', null, head.map((c, ci) => h('th', { key: 'th' + ci }, inline(c, 'th' + ci))))),
              rows.length
                ? h(
                    'tbody',
                    null,
                    rows.map((r, ri) =>
                      h('tr', { key: 'tr' + ri }, r.map((c, ci) => h('td', { key: 'td' + ci }, inline(c, 'td' + ri + '-' + ci)))),
                    ),
                  )
                : null,
            ),
          );
          continue;
        }

        // 引用：连续 > 行合并成一个 blockquote（内部再按块解析，支持嵌套列表/代码）
        if (/^\s{0,3}>/.test(line)) {
          const buf = [];
          while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
            buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
            i++;
          }
          out.push(h('blockquote', { key: nextKey() }, renderMarkdownBlocks(buf)));
          continue;
        }

        // 列表：连续的 - / * / + 或 1. 行，按缩进判定嵌套层级
        if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) {
          const consumed = readList(lines, i, out, nextKey);
          i = consumed;
          continue;
        }

        // 段落：连续非空、且不是其它块起始的行
        const buf = [line];
        i++;
        while (i < lines.length) {
          const t = lines[i];
          if (/^\s*$/.test(t)) break;
          if (/^\s{0,3}(#{1,6})\s+/.test(t)) break;
          if (/^\s*(`{3,}|~{3,})/.test(t)) break;
          if (/^\s{0,3}>/.test(t)) break;
          if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(t)) break;
          if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(t)) break;
          buf.push(t);
          i++;
        }
        out.push(h('p', { key: nextKey() }, inline(buf.join('\n').trim(), 'p' + key)));
      }

      return out;
    }

    /** 引用块内部只做「块级 + 内联」解析，跳过最外层包裹 */
    function renderMarkdownBlocks(lines) {
      return renderMarkdown(lines.join('\n'));
    }

    /**
     * 读一个列表块（含嵌套）。返回消费到的行号。
     * 用「缩进栈」把扁平行还原成嵌套结构 —— 这是自己写解析器最容易出错的地方，
     * 所以只认 2 空格或 tab 递进，遇到不支持的结构就退化成同层同级，不抛错。
     */
    function readList(lines, start, out, nextKey) {
      const rootItems = [];
      const stack = [{ indent: -1, items: rootItems }];
      let i = start;

      while (i < lines.length) {
        const raw = lines[i];
        const m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(raw);
        if (!m) {
          // 列表项的续行：以缩进开头且非空 → 并入上一项的文本
          if (/^\s+\S/.test(raw) && stack.length > 0) {
            const top = stack[stack.length - 1].items;
            if (top.length > 0) { top[top.length - 1].text += '\n' + raw.trim(); i++; continue; }
          }
          break;
        }
        const indent = m[1].replace(/\t/g, '  ').length;
        const ordered = /^\d/.test(m[2]);
        const text = m[3];

        // 根层级的缩进由第一个列表项决定；否则 -1 会让首项被误判成「更深」而自我嵌套。
        if (stack.length === 1 && stack[0].items.length === 0) stack[0].indent = indent;

        // 找到当前缩进应归属的层级
        while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
        let level = stack[stack.length - 1];
        if (indent > level.indent && level.items.length > 0) {
          // 更深 → 作为上一项的子列表
          const parent = level.items[level.items.length - 1];
          if (!parent.children) parent.children = [];
          const child = { indent, items: parent.children, ordered };
          stack.push(child);
          level = child;
        }
        level.items.push({ text, ordered });
        i++;
      }

      // 递归把结构渲染成 ul/ol
      const build = (items, kp) =>
        h(
          items.length && items[0].ordered ? 'ol' : 'ul',
          { key: nextKey() },
          items.map((item, idx) =>
            h(
              'li',
              { key: kp + '-' + idx },
              inline(item.text, kp + '-' + idx),
              item.children && item.children.length ? build(item.children, kp + '-c' + idx) : null,
            ),
          ),
        );

      if (rootItems.length) out.push(build(rootItems, 'l' + start));
      return i;
    }

    async function request(path, init) {
      let res;
      try {
        res = await fetch(API + path, init);
      } catch (e) {
        const netErr = new Error((e && e.message) || 'network error');
        netErr.code = 'NETWORK';
        throw netErr;
      }
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      // 契约 §2.4：失败体统一是 { ok:false, code, error }
      if (res.ok && data && data.ok !== false) return data;
      const fail = new Error((data && data.error) || 'HTTP ' + res.status);
      fail.code = (data && data.code) || 'HTTP_' + res.status;
      fail.status = res.status;
      throw fail;
    }

    function apiGet(path) {
      return request(path, { headers: { accept: 'application/json' } });
    }

    function apiPost(path, body) {
      return request(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    /** 在 /state 结果里按 key 找 FileEntry（客户端只用 key 寻址，契约 §3） */
    function findEntry(state, key) {
      if (!state || !key) return null;
      const all = (state.globals || []).concat(state.project || []);
      for (const entry of all) if (entry && entry.key === key) return entry;
      // 第三方集中：文件挂在每个工具的 files 数组里
      for (const tool of state.thirdParty || []) {
        for (const entry of (tool && tool.files) || []) if (entry && entry.key === key) return entry;
      }
      return null;
    }

    /** 从 /state 里找出某个 key 所属的第三方工具（详情面板要显示工具名） */
    function thirdPartyToolOf(state, key) {
      if (!state || !key) return null;
      for (const tool of state.thirdParty || []) {
        for (const entry of (tool && tool.files) || []) if (entry && entry.key === key) return tool;
      }
      return null;
    }

    /** loaded = 会被 DSH 加载；skipped = 全局去重里被前者覆盖；missing = 还没创建 */
    function statusOf(entry) {
      if (!entry || !entry.exists) return 'missing';
      return entry.duplicateOf ? 'skipped' : 'loaded';
    }

    // ── 内联 SVG 图标（禁止 emoji；stroke 用 currentColor 跟随主题）──────────
    function svg(children, size, className) {
      return h(
        'svg',
        {
          className: 'amv-icon' + (className ? ' ' + className : ''),
          width: size || 14,
          height: size || 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      );
    }

    const IconFile = (size, cls) =>
      svg(
        [
          h('path', { key: 'a', d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }),
          h('path', { key: 'b', d: 'M14 3v5h5' }),
        ],
        size,
        cls,
      );

    const IconPlus = (size, cls) =>
      svg([h('path', { key: 'a', d: 'M12 5v14' }), h('path', { key: 'b', d: 'M5 12h14' })], size, cls);

    const IconCheck = (size, cls) => svg([h('path', { key: 'a', d: 'M20 6 9 17l-5-5' })], size, cls);

    const IconAlert = (size, cls) =>
      svg(
        [
          h('path', { key: 'a', d: 'M10.3 4.3 2.9 17a1.6 1.6 0 0 0 1.4 2.4h15.4a1.6 1.6 0 0 0 1.4-2.4L13.7 4.3a1.6 1.6 0 0 0-2.8 0z' }),
          h('path', { key: 'b', d: 'M12 9.5v4' }),
          h('path', { key: 'c', d: 'M12 17h.01' }),
        ],
        size,
        cls,
      );

    const IconRefresh = (size, cls) =>
      svg(
        [
          h('path', { key: 'a', d: 'M3 4.5v5h5' }),
          h('path', { key: 'b', d: 'M3.6 13.8A8.5 8.5 0 1 0 5.9 6.6L3 9.5' }),
        ],
        size,
        cls,
      );

    const IconFolder = (size, cls) =>
      svg(
        [
          h('path', { key: 'a', d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' }),
        ],
        size,
        cls,
      );

    const IconInfo = (size, cls) =>
      svg(
        [
          h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }),
          h('path', { key: 'b', d: 'M12 11v5' }),
          h('path', { key: 'c', d: 'M12 7.6h.01' }),
        ],
        size,
        cls,
      );

    // ── 设置页 Section ─────────────────────────────────────────────────────
    function Section(props) {
      // 优先用插槽注入的 t（性能更好，且与宿主渲染同帧）；没注入时退回 apply() 里绑定的那个。
      const t = (props && typeof props.t === 'function' && props.t) || activeT;

      const [state, setState] = useState(null); // /state 结果
      const [wsId, setWsId] = useState(null); // 用户显式选择的工作区（null = 用 Host 回显的）
      const [tab, setTab] = useState('project');
      const [selKey, setSelKey] = useState(null); // 选中文件的 key
      const [doc, setDoc] = useState(null); // /read 结果 + 写回后的本地同步值
      const [draft, setDraft] = useState(''); // 编辑器内容
      const [docState, setDocState] = useState(''); // '' 加载中 | 'ready' | 'missing'
      const [mode, setMode] = useState('preview');
      const [pvMode, setPvMode] = useState('rendered'); // 预览态：rendered（排版后）| source（原始源码）
      const [busy, setBusy] = useState(''); // '' | 'read' | 'save' | 'create'
      const [stateBusy, setStateBusy] = useState(false);
      const [err, setErr] = useState(null); // { text }
      const [notice, setNotice] = useState('');
      const [conflict, setConflict] = useState(false);
      // 自定义工具编辑：草稿是整份 JSON 文本，保存时整体提交（避免半残配置）
      const [customText, setCustomText] = useState('');
      const [customMsg, setCustomMsg] = useState(null);
      // 第三方集中内部的子Tab：选中工具 id（'__custom__' = 自定义工具面板）
      const [thirdTab, setThirdTab] = useState(null);

      const stateSeq = useRef(0); // /state 请求序号：丢弃过期响应
      const readSeq = useRef(0); // /read 请求序号：同上

      // 当前生效的工作区：用户显式选的优先，否则用 Host 回显的那个
      const ws = wsId || (state && state.selectedWorkspaceId) || null;

      const qs = useCallback(
        (extra) => {
          const parts = [];
          if (ws) parts.push('workspaceId=' + encodeURIComponent(ws));
          if (extra) for (const k of Object.keys(extra)) parts.push(k + '=' + encodeURIComponent(extra[k]));
          return parts.length ? '?' + parts.join('&') : '';
        },
        [ws],
      );

      // 拉文件清单；silent=true 时不显示加载态（保存后静默刷新用）
      const loadState = useCallback(
        async (targetWs, silent) => {
          const ticket = ++stateSeq.current;
          if (!silent) {
            setStateBusy(true);
            setErr(null);
          }
          try {
            const q = targetWs ? '?workspaceId=' + encodeURIComponent(targetWs) : '';
            const json = await apiGet('/state' + q);
            if (ticket !== stateSeq.current) return null;
            setState(json);
            return json;
          } catch (e) {
            if (ticket !== stateSeq.current) return null;
            setErr({ text: t('errState').replace('{msg}', errText(e)) });
            return null;
          } finally {
            // 只有最新的一次请求负责清标记，避免旧响应把新请求的加载态提前关掉
            if (ticket === stateSeq.current) setStateBusy(false);
          }
        },
        [t],
      );

      // 读单个文件
      const readEntry = useCallback(
        async (target) => {
          const ticket = ++readSeq.current;
          setBusy('read');
          setErr(null);
          setConflict(false);
          setDoc(null);
          setDraft('');
          setDocState('');
          setMode('preview');
          try {
            const json = await apiGet('/read' + qs({ key: target.key }));
            if (ticket !== readSeq.current) return;
            setDoc(json);
            setDraft(typeof json.content === 'string' ? json.content : '');
            setDocState('ready');
          } catch (e) {
            if (ticket !== readSeq.current) return;
            if (e.code === 'NOT_FOUND') {
              setDocState('missing'); // 清单说存在但实际没了：按「未创建」处理
              return;
            }
            setErr({ text: t('errRead').replace('{msg}', errText(e)) });
          } finally {
            if (ticket === readSeq.current) setBusy('');
          }
        },
        [qs, t],
      );

      // 首次加载 / 切换工作区时拉清单（只跟 wsId 走，避免 state 回填引发循环）
      useEffect(() => {
        loadState(wsId, false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [wsId]);

      // 首次挂载就把自定义工具配置读进编辑器：这样用户一进页面看到的就是
      // 「现成的结构或模板」，而不是一个空框等人去点按钮。
      useEffect(() => {
        openCustom(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const entry = useMemo(() => findEntry(state, selKey), [state, selKey]);
      const truncated = !!(doc && doc.truncated);
      const dirty = docState === 'ready' && !!doc && draft !== (doc.content || '');
      const draftBytes = useMemo(() => utf8Bytes(draft), [draft]);
      // 编辑器实时统计（注入字节 / 字数 / token）：口径与 Host 一致，敲键盘即更新
      const draftStats = useMemo(() => injectionStats(draft), [draft]);
      const canEdit = docState === 'ready' && !truncated;
      const canSave = canEdit && dirty && !busy && draftBytes <= MAX_BYTES;
      const showEdit = mode === 'edit' && canEdit;

      // 清空选中（切 Tab / 切工作区时用）
      const resetSelection = useCallback(() => {
        readSeq.current += 1; // 作废在途读取
        setSelKey(null);
        setDoc(null);
        setDraft('');
        setDocState('');
        setMode('preview');
        setConflict(false);
        setErr(null);
        setNotice('');
      }, []);

      // 切换顶层 Tab 时把子Tab也复位，避免「上次选中的工具」串到下一次
      const resetThirdTab = useCallback(() => setThirdTab(null), []);

      const switchTab = (next) => {
        if (next === tab) return;
        setTab(next);
        resetSelection();
        if (next === 'third') resetThirdTab();
      };

      const selectEntry = (target) => {
        setNotice('');
        setErr(null);
        setConflict(false);
        setSelKey(target.key);
        setMode('preview');
        if (!target.exists) {
          // 清单已经说了不存在：不发 /read，直接进空状态（Host 会回 404）
          readSeq.current += 1;
          setDoc(null);
          setDraft('');
          setDocState('missing');
          return;
        }
        readEntry(target);
      };

      // 写文件：expectedVersion=null 表示无条件写（创建 / 用户确认覆盖）
      const write = useCallback(
        async (content, expectedVersion, creating) => {
          if (!selKey) return;
          const ticket = ++readSeq.current; // 作废在途读取，避免写回后被旧内容覆盖
          setBusy(creating ? 'create' : 'save');
          setErr(null);
          setNotice('');
          try {
            const json = await apiPost('/write', {
              workspaceId: ws,
              key: selKey,
              content,
              expectedVersion: expectedVersion === undefined ? null : expectedVersion,
            });
            if (ticket !== readSeq.current) return;
            setConflict(false);
            setDoc({
              key: selKey,
              content,
              size: json.size,
              mtime: json.mtime,
              version: json.version,
              truncated: false,
            });
            setDraft(content);
            setDocState('ready');
            setNotice(t('saved'));
            if (creating) setMode('edit'); // 建完直接进编辑器，方便接着补内容
            loadState(ws, true); // 静默刷新清单（exists / size / duplicateOf）
          } catch (e) {
            if (ticket !== readSeq.current) return;
            if (e.code === 'STALE') {
              setConflict(true); // 契约 §2.3：409 STALE → 给「覆盖 / 重新读取」
              return;
            }
            setErr({ text: t('errSave').replace('{msg}', errText(e)) });
          } finally {
            if (ticket === readSeq.current) setBusy('');
          }
        },
        [selKey, ws, t, loadState],
      );

      // ── 自定义工具（用户可编辑，落盘到 ~/.dsh/agents-visualization.json）──
      /**
       * 读回已保存的配置到编辑器。首次挂载时也会调一次，让模板/现状直接可见。
       * 已有内容就展示现状；为空则填一份可直接改值的模板。
       * @param {boolean} [overwrite] - true 表示强制覆盖编辑器（用户点了「重新读取」）。
       * @returns {Promise<void>}
       */
      const openCustom = async (overwrite = true) => {
        setCustomMsg(null);
        try {
          const json = await apiGet('/user-tools');
          const tools = json.tools || [];
          const text = tools.length > 0 ? JSON.stringify(tools, null, 2) : templateText('');
          // 非强制刷新时，不覆盖用户已经改动过的草稿
          setCustomText((prev) => (overwrite || prev.trim() === ''? text : prev));
        } catch (e) {
          setCustomMsg({ kind: 'err', text: t('customLoadFail').replace('{msg}', errText(e)) });
          setCustomText((prev) => (prev.trim() === '' ? templateText('') : prev));
        }
      };

      /**
       * 保存：先本地 parse 校验，再整体提交给 Host 逐条复核。
       * @returns {Promise<void>}
       */
      const saveCustom = async () => {
        setCustomMsg(null);
        let parsed
        try {
          parsed = JSON.parse(customText);
        } catch (e) {
          setCustomMsg({ kind: 'err', text: t('customBadJson').replace('{msg}', e.message) });
          return;
        }
        if (!Array.isArray(parsed)) {
          setCustomMsg({ kind: 'err', text: t('customNeedArray') });
          return;
        }
        try {
          await apiPost('/user-tools', { tools: parsed });
          setCustomMsg({ kind: 'ok', text: t('customSaved') });
          loadState(ws, true); // 静默刷新第三方清单
        } catch (e) {
          setCustomMsg({ kind: 'err', text: t('customSaveFail').replace('{msg}', errText(e)) });
        }
      };

      // 元信息里的「重新读取」：脏数据时不覆盖，只静默刷新清单
      const refresh = () => {        if (dirty) {
          loadState(ws, true);
          return;
        }
        const next = findEntry(state, selKey);
        loadState(ws, true);
        if (!next) {
          setSelKey(null);
          return;
        }
        if (next.exists) readEntry(next);
        else {
          readSeq.current += 1;
          setDoc(null);
          setDraft('');
          setDocState('missing');
        }
      };

      // 冲突里的「重新读取」：故意覆盖编辑器（用户已经明确选了这条路）
      const forceReload = () => {
        const next = findEntry(state, selKey);
        setConflict(false);
        if (next && next.exists) readEntry(next);
        else {
          readSeq.current += 1;
          setDoc(null);
          setDraft('');
          setDocState('missing');
        }
        loadState(ws, true);
      };

      const save = () => {
        if (!canSave) return;
        write(draft, doc.version, false);
      };

      const onEditorKeyDown = (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          save();
        }
      };

      // ── 渲染小件 ────────────────────────────────────────────────────────
      /** 详情面板的指标行：占用 / 注入 / 字数 / token（值来自 /read 实时内容或清单缓存）。 */
      const metricsEl = (stats, size) =>
        h(
          'div',
          { className: 'amv-metrics', title: t('metricInjectHint') + '\n' + t('metricTokenHint') },
          h('span', { className: 'amv-metrics-label' }, t('metricOccupied')),
          h('span', { className: 'amv-metrics-value' }, formatBytes(size)),
          h('span', { className: 'amv-dot' }),
          h('span', { className: 'amv-metrics-label' }, t('metricInjected')),
          h('span', { className: 'amv-metrics-value' }, formatBytes(stats.injectBytes)),
          h('span', { className: 'amv-dot' }),
          h('span', { className: 'amv-metrics-label' }, t('metricChars')),
          h('span', { className: 'amv-metrics-value' }, String(stats.chars)),
          h('span', { className: 'amv-dot' }),
          h('span', { className: 'amv-metrics-label' }, t('metricTokens')),
          h('span', { className: 'amv-metrics-value' }, t('metricTokensApprox').replace('{n}', String(stats.tokens))),
        );

      // 徽章语义要区分作用域：只有 DSH 自己的规则才谈得上「会不会被 DSH 加载」，
      // 第三方工具的文件是给对应工具读的，说「DSH 会加载」会误导。
      const badgeOf = (status, scope) => {
        if (status === 'missing') return h('span', { className: 'amv-badge amv-badge-idle' }, t('badgeMissing'));
        if (scope === 'third') return h('span', { className: 'amv-badge amv-badge-ok' }, t('badgeExists'));
        if (status === 'skipped') return h('span', { className: 'amv-badge amv-badge-warn' }, t('badgeSkipped'));
        return h('span', { className: 'amv-badge amv-badge-ok' }, t('badgeLoaded'));
      };

      const metaOf = (target) => {
        const status = statusOf(target);
        return [
          h('span', { key: 'sz' }, formatBytes(target.size)),
          target.mtime ? h('span', { key: 'dot1', className: 'amv-dot' }) : null,
          target.mtime ? h('span', { key: 'mt' }, formatTime(target.mtime)) : null,
          h('span', { key: 'dot2', className: 'amv-dot' }),
          badgeOf(status, target.scope),
        ].filter(Boolean);
      };

      const dupNoteOf = (target) => {
        if (!target || !target.duplicateOf) return null;
        const first = findEntry(state, target.duplicateOf);
        const label = first ? first.displayPath : String(target.duplicateOf);
        return h(
          'div',
          { className: 'amv-note-warn' },
          IconAlert(12, 'amv-icon-warn'),
          h('span', null, t('dupOf').replace('{path}', label)),
        );
      };

      // 跨工具共用提示：同一份规则被复制到多个工具时，改一处不会同步其它处。
      // 这是本页最容易踩的坑，所以既在行内给角标，也在详情里给整行说明。
      const sharedNoteOf = (target) => {
        if (!target || !target.sharedWith || target.sharedWith.length === 0) return null;
        return t('thirdShared').replace('{names}', target.sharedWith.join('、'));
      };

      // 项目级 / 全局级的一行（div + role=button，避免 button 里嵌块级元素）
      // 项目级 / 全局级的一行（div + role=button，避免 button 里嵌块级元素）
      // 详情不再统一堆在页面底部，而是「点谁就在谁下面展开」—— 否则页面一长，
      // 用户点完看不到任何变化，会以为没生效。
      const rowOf = (target) => {
        const status = statusOf(target);
        const selected = target.key === selKey;
        const row = h(
          'div',
          {
            key: target.key + ':row',
            className: 'amv-row',
            role: 'button',
            tabIndex: 0,
            'aria-pressed': selected ? 'true' : 'false',
            'aria-expanded': selected ? 'true' : 'false',
            'data-missing': target.exists ? 'false' : 'true',
            onClick: () => selectEntry(target),
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                selectEntry(target);
              }
            },
          },
          status === 'loaded'
            ? IconFile(14, 'amv-icon-brand')
            : status === 'skipped'
              ? IconAlert(14, 'amv-icon-warn')
              : IconPlus(14),
          h(
            'div',
            { className: 'amv-row-main' },
            h('div', { className: 'amv-row-path', title: target.displayPath }, target.displayPath),
            target.exists ? null : h('div', { className: 'amv-row-sub' }, t('missingTitle')),
            target.exists && target.sharedWith && target.sharedWith.length
              ? h('div', { className: 'amv-row-sub amv-shared' }, IconAlert(10, 'amv-icon-warn'), h('span', null, sharedNoteOf(target)))
              : null,
          ),
          h('div', { className: 'amv-row-side' }, metaOf(target)),
        );
        if (!selected) return row;
        // 选中态的详情就插在这一行下面，视觉上与所属文件同组
        return h('div', { key: target.key + ':wrap', className: 'amv-inline' }, row, detailOf(target));
      };

      // 全局级卡片
      const cardOf = (target, hint) => {
        const selected = target.key === selKey;
        const card = h(
          'div',
          {
            key: target.key + ':card',
            className: 'amv-card',
            role: 'button',
            tabIndex: 0,
            'aria-pressed': selected ? 'true' : 'false',
            'aria-expanded': selected ? 'true' : 'false',
            onClick: () => selectEntry(target),
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                selectEntry(target);
              }
            },
          },
          h(
            'div',
            { className: 'amv-card-hd' },
            statusOf(target) === 'loaded' ? IconFile(14, 'amv-icon-brand') : statusOf(target) === 'skipped' ? IconAlert(14, 'amv-icon-warn') : IconPlus(14),
            h('div', { className: 'amv-card-path', title: target.displayPath }, target.displayPath),
            badgeOf(statusOf(target), target.scope),
          ),
          h(
            'div',
            { className: 'amv-card-bd' },
            h(
              'div',
              { className: 'amv-card-meta' },
              h('span', null, formatBytes(target.size)),
              target.mtime ? h('span', { className: 'amv-dot' }) : null,
              target.mtime ? h('span', null, formatTime(target.mtime)) : null,
            ),
            hint ? h('div', { className: 'amv-card-hint' }, hint) : null,
            dupNoteOf(target),
          ),
        );
        if (!selected) return card;
        return h('div', { key: target.key + ':wrap', className: 'amv-inline' }, card, detailOf(target));
      };

      const loadingRow = (label) => h('div', { className: 'amv-loading' }, IconRefresh(13), h('span', null, label));

      // ── 面板：项目级 ────────────────────────────────────────────────────
      const projectPane = () => {
        const all = (state && state.project) || [];
        const existing = all.filter((e) => e.exists);
        const missing = all.filter((e) => !e.exists);
        const workspaces = (state && state.workspaces) || [];
        const activeWs = (() => {
          const targetId = ws || (state && state.selectedWorkspaceId);
          for (const w of workspaces) if (w && w.id === targetId) return w;
          return null;
        })();

        return h(
          'div',
          { className: 'amv-pane' },
          h(
            'div',
            { className: 'amv-field' },
            h('span', { className: 'amv-field-label' }, t('workspaceLabel')),
            workspaces.length
              ? h(
                  'select',
                  {
                    className: 'amv-select',
                    'aria-label': t('workspaceLabel'),
                    value: ws || (state && state.selectedWorkspaceId) || '',
                    disabled: stateBusy || !!busy,
                    onChange: (e) => {
                      const nextWs = e.target.value || null;
                      resetSelection();
                      setWsId(nextWs);
                    },
                  },
                  workspaces.map((w) => h('option', { key: w.id, value: w.id }, w.title || w.path || w.id)),
                )
              : h('span', { className: 'amv-card-hint' }, t('workspaceNone')),
          ),
          activeWs && activeWs.projectRoot
            ? h(
                'div',
                { className: 'amv-root', title: activeWs.projectRoot },
                IconFolder(12),
                h('span', { className: 'amv-root-txt' }, t('projectRoot').replace('{root}', activeWs.projectRoot)),
              )
            : null,
          stateBusy && !state ? loadingRow(t('loadingState')) : null,
          all.length === 0
            ? h('div', { className: 'amv-card-hint' }, t('projectEmpty'))
            : [
                existing.length
                  ? h(
                      'div',
                      { className: 'amv-group', key: 'exists' },
                      h(
                        'div',
                        { className: 'amv-group-hd' },
                        h('span', null, t('groupExists')),
                        h('span', { className: 'amv-count' }, String(existing.length)),
                      ),
                      h('div', { className: 'amv-list' }, existing.map(rowOf)),
                    )
                  : null,
                missing.length
                  ? h(
                      'div',
                      { className: 'amv-group', key: 'missing' },
                      h(
                        'div',
                        { className: 'amv-group-hd' },
                        h('span', null, t('groupMissing')),
                        h('span', { className: 'amv-count' }, String(missing.length)),
                      ),
                      h('div', { className: 'amv-list' }, missing.map(rowOf)),
                    )
                  : null,
              ],
        );
      };

      // ── 面板：全局级 ────────────────────────────────────────────────────
      const globalPane = () => {
        const globals = (state && state.globals) || [];
        if (!globals.length) return h('div', { className: 'amv-pane' }, h('div', { className: 'amv-card-hint' }, t('globalEmpty')));
        return h(
          'div',
          { className: 'amv-pane' },
          h(
            'div',
            { className: 'amv-cards' },
            globals.map((g, i) => cardOf(g, i === 0 ? t('globalDshHint') : t('globalAgentsHint'))),
          ),
          stateBusy && !state ? loadingRow(t('loadingState')) : null,
        );
      };

      // 自定义工具编辑区：默认折叠，展开后是一个 JSON 文本框 + 保存。
      // 用 JSON 而不是表单，是因为 targets 的结构可变（file/dir/glob），
      // 表单控件会把它压扁成无法表达的组合；JSON 反而更直观也更省代码。
      const customPanel = () => {
        const userTools = (state && state.userTools) || [];
        const count = userTools.length;
        return h(
          'div',
          { className: 'amv-custom' },
          h(
            'div',
            { className: 'amv-custom-hd' },
            IconPlus(12),
            h('span', { className: 'amv-custom-title' }, t('customTitle')),
            h('span', { className: 'amv-badge amv-badge-plain' }, t('customCount').replace('{n}', String(count))),
            h('div', { className: 'amv-spacer' }),
            h(
              'button',
              { type: 'button', className: 'amv-btn', onClick: openCustom, title: t('customReloadTitle') },
              IconRefresh(12),
              t('customReload'),
            ),
          ),
          h(
            'div',
            { className: 'amv-custom-bd' },
            h('div', { className: 'amv-custom-hint' }, t('customHint').replace('{path}', (state && state.userConfigPath) || '')),
            // 模板就在编辑区里：直接改值即可，也可以全选删掉粘贴自己的
            h('textarea', {
              className: 'amv-textarea amv-custom-ta',
              spellCheck: false,
              value: customText,
              onChange: (e) => setCustomText(e.target.value),
              'aria-label': t('customTitle'),
              placeholder: t('customPlaceholder'),
            }),
            customMsg
              ? h(
                  'div',
                  { className: customMsg.kind === 'ok' ? 'amv-banner amv-banner-ok' : 'amv-banner amv-banner-err' },
                  h('span', { className: 'amv-banner-txt' }, customMsg.text),
                )
              : null,
            h(
              'div',
              { className: 'amv-custom-actions' },
              h('button', { type: 'button', className: 'amv-btn amv-btn-primary', onClick: saveCustom }, t('customSave')),
              h(
                'button',
                { type: 'button', className: 'amv-btn', onClick: () => { setCustomMsg(null); setCustomText(templateText('')) } },
                t('customFillTemplate'),
              ),
              h(
                'button',
                { type: 'button', className: 'amv-btn', onClick: () => { setCustomMsg(null); setCustomText('[]') } },
                t('customClear'),
              ),
            ),
          ),
        );
      };

      /**
       * 编辑区常驻、内容预填模板。
       *
       * 为什么不再用「点编辑才展开」：那样每次都要手敲 id / targets / segments 这些键名，
       * 极易写错；而用户真正要改的通常只是几个值。所以默认就把结构摆出来，
       * 用户直接改值即可；要批量粘贴时全选覆盖也不会被挡住。
       * 「填入模板」按钮额外给一个干净起点（比如清空后想加第二条）。
       * @param {string} jsonText - 当前编辑器文本。
       * @returns {string} 填入编辑器的模板文本。
       */
      const templateText = (jsonText) => {
        const base = {
          id: 'mytool',
          name: '我的工具',
          vendor: '自定义',
          targets: [{ kind: 'dir', segments: ['.mytool', 'rules'] }],
        };
        // 已有配置就以现状为模板；为空才给一份示例，避免覆盖用户内容
        if (jsonText.trim() !== '' && jsonText.trim() !== '[]') return jsonText;
        return JSON.stringify([base], null, 2);
      };

      // ── 面板：第三方集中 ────────────────────────────────────────────────
      // 不再纵向铺开全部工具：改为「子Tab 切换各 Agent 工具」。
      // 已安装工具各占一个子Tab（头部带文件数与 token 汇总），自定义工具固定为最后一个
      // 子Tab；未安装的仍折叠在底部「未检测到」块里 —— 子Tab栏只留真正有文件可管的工具。
      const CUSTOM_TAB = '__custom__';

      // 工具级汇总：Σ注入字节 + Σ估算 token（文件级 stats 由 Host 扫描时算好）。
      // files 与 _abs 一一对应，sharedWith 也在同一下标 —— 这里只读对外字段。
      const toolSummary = (tool) => {
        let injectBytes = 0;
        let tokens = 0;
        for (const f of tool.files || []) {
          if (!f.stats) continue;
          injectBytes += f.stats.injectBytes || 0;
          tokens += f.stats.tokens || 0;
        }
        return { injectBytes, tokens };
      };

      const thirdPane = () => {
        const tools = (state && state.thirdParty) || [];
        if (!tools.length) {
          return h('div', { className: 'amv-pane' }, h('div', { className: 'amv-card-hint' }, t('thirdEmpty')));
        }
        const installed = tools.filter((tool) => tool.installed);
        const absent = tools.filter((tool) => !tool.installed);

        // 生效的子Tab：用户选过的优先；否则默认第一个已安装工具；
        // 一个已安装工具都没有时直接落到「自定义工具」（此时它是唯一可用内容）
        const activeTab = thirdTab && (thirdTab === CUSTOM_TAB || installed.some((tool) => tool.id === thirdTab))
          ? thirdTab
          : installed.length
            ? installed[0].id
            : CUSTOM_TAB;
        const activeTool = activeTab && activeTab !== CUSTOM_TAB ? installed.find((tool) => tool.id === activeTab) : null;

        const switchThirdTab = (nextId) => {
          if (nextId === activeTab) return;
          resetSelection(); // 换工具必然换文件集合，先清掉旧选中与在途读取
          setThirdTab(nextId);
        };

        // 子Tab条：已安装工具 + 固定的「自定义工具」
        const subtabsEl = h(
          'div',
          { className: 'amv-subtabs', role: 'tablist', 'aria-label': t('tabThird') },
          installed.map((tool) => {
            const sum = toolSummary(tool);
            return h(
              'button',
              {
                type: 'button',
                key: tool.id,
                role: 'tab',
                className: 'amv-subtab',
                'aria-selected': activeTab === tool.id ? 'true' : 'false',
                title: tool.name,
                onClick: () => switchThirdTab(tool.id),
              },
              tool.name,
              tool.files.length
                ? h('span', { className: 'amv-badge amv-badge-plain' }, t('metricSubtab').replace('{n}', String(tool.files.length)).replace('{t}', String(sum.tokens)))
                : null,
            );
          }),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'amv-subtab',
              'aria-selected': activeTab === CUSTOM_TAB ? 'true' : 'false',
              onClick: () => switchThirdTab(CUSTOM_TAB),
            },
            t('customSubtab'),
          ),
        );

        const toolCard = (tool) => {
          const sum = toolSummary(tool);
          return h(
            'div',
            { className: 'amv-tool', key: tool.id },
            h(
              'div',
              { className: 'amv-tool-hd' },
              h('span', { className: 'amv-tool-name', title: sourceTitle(tool) }, tool.name),
              h('span', { className: 'amv-tool-vendor' }, tool.vendor),
              confidenceOf(tool),
              h('div', { className: 'amv-spacer' }),
              h(
                'span',
                { className: 'amv-tool-dir', title: Array.isArray(tool.dir) ? tool.dir.join('\n') : tool.dir },
                Array.isArray(tool.dir) ? tool.dir.join(' · ') : tool.dir,
              ),
            ),
            // 工具级汇总 + 口径说明（title 悬停给出注入/token 的计算口径）
            tool.files.length
              ? h(
                  'div',
                  { className: 'amv-tool-note', title: t('metricInjectHint') + '\n' + t('metricTokenHint') },
                  h('span', null, t('metricToolSummary').replace('{n}', String(tool.files.length)).replace('{b}', formatBytes(sum.injectBytes)).replace('{t}', String(sum.tokens))),
                )
              : null,
            // 工具说明：产品状态（已被取代 / 已停维护 / 账户级不可编辑等）直接影响
            // 用户该不该在这里改，所以放在显眼位置而不是藏进 tooltip。
            tool.note ? h('div', { className: 'amv-tool-note' }, IconInfo(11), h('span', null, tool.note)) : null,
            // 目录里规则文件超过列举上限时如实告知，不静默截断
            tool.totalRuleFiles && tool.totalRuleFiles > tool.files.length
              ? h(
                  'div',
                  { className: 'amv-tool-note amv-trunc' },
                  IconAlert(11, 'amv-icon-warn'),
                  h('span', null, t('thirdTruncated').replace('{shown}', String(tool.files.length)).replace('{total}', String(tool.totalRuleFiles))),
                )
              : null,
            tool.files.length
              ? h('div', { className: 'amv-list' }, tool.files.map((f) => rowOf(f)))
              : h('div', { className: 'amv-tool-empty' }, t('thirdNoRules')),
          );
        };

        return h(
          'div',
          { className: 'amv-pane' },
          subtabsEl,
          // activeTab 恒有值：有已安装工具时默认第一个，否则落到「自定义工具」
          activeTab === CUSTOM_TAB ? customPanel() : toolCard(activeTool),
          absent.length
            ? h(
                'div',
                { className: 'amv-absent' },
                h('div', { className: 'amv-absent-hd' }, IconInfo(12), h('span', null, t('thirdAbsentTitle').replace('{n}', String(absent.length)))),
                h(
                  'div',
                  { className: 'amv-absent-list' },
                  absent.map((tool) =>
                    h(
                      'span',
                      { className: 'amv-absent-item', key: tool.id },
                      tool.name,
                      h('span', { className: 'amv-absent-dir' }, tool.dir),
                    ),
                  ),
                ),
              )
            : null,
          stateBusy && !state ? loadingRow(t('loadingState')) : null,
        );
      };

      /**
       * 置信度提示。
       *
       * 先厘清两件容易被混为一谈的事：
       *   · 路径**是否存在** —— 只要卡片里列出了真实文件，这件事已经被证实
       *   · 路径**是否出自官方文档** —— 这是另一层信息
       *
       * 所以不给「已经扫到文件」的工具挂徽章：文件就在那儿，用户改它即可，
       * 挂个「待核实」只会让人以为出错了（这是之前的真实反馈）。
       * 只有**纯推测**（既无官方文档、本机也没扫到）才用警告色提醒。
       * 来源说明统一放到工具名的 tooltip 里，不占视觉空间。
       */
      const confidenceOf = (tool) => {
        if (tool.confidence !== 'low') return null;
        return h('span', { className: 'amv-badge amv-badge-warn', title: t('confLowTip') }, t('confLow'));
      };

      /** 工具名的 tooltip：说明这个路径的来源可信度（不占版面） */
      const sourceTitle = (tool) => {
        const level = tool.confidence;
        const label =
          level === 'high' ? t('srcOfficial')
            : level === 'medium' ? (tool.installed ? t('srcDisk') : t('srcUnverified'))
              : t('srcInferred');
        const where = tool.source ? `\n${tool.source}` : '';
        return `${label}${where}`;
      };

      // ── 详情面板 ────────────────────────────────────────────────────────
      /**
       * 详情面板。参数是「当前展开的那一项」——由 rowOf / cardOf 传入，
       * 这样内联渲染时不会因为 selKey 与渲染时机不同步而错位。
       */
      const detailOf = (entry) => {
        if (!entry) return null;
        const status = statusOf(entry);
        const dupNote = dupNoteOf(entry);
        // 元信息以 /read 的实时值为准（保存 / 创建后 /state 是异步刷新的，
        // 直接读 entry 会短暂显示旧大小），拿不到时退回清单里的值。
        const metaSize = doc && docState === 'ready' && typeof doc.size === 'number' ? doc.size : entry.size;
        const metaMtime = doc && docState === 'ready' && doc.mtime !== undefined ? doc.mtime : entry.mtime;
        // 四项指标：以 /read 到手的内容为准（与磁盘一致）；清单里 Host 扫描算好的
        // entry.stats 只在内容还没读出来时充当占位，避免数字闪变。
        const statsSource = docState === 'ready' && doc && typeof doc.content === 'string' ? doc.content : null;
        const liveStats = statsSource !== null ? injectionStats(statsSource) : entry.stats || null;

        const modeSwitch = canEdit
          ? h(
              'div',
              { className: 'amv-seg', role: 'tablist', 'aria-label': t('modePreview') },
              h(
                'button',
                {
                  type: 'button',
                  role: 'tab',
                  className: 'amv-seg-btn',
                  'aria-selected': showEdit ? 'false' : 'true',
                  onClick: () => setMode('preview'),
                },
                t('modePreview'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'tab',
                  className: 'amv-seg-btn',
                  'aria-selected': showEdit ? 'true' : 'false',
                  onClick: () => setMode('edit'),
                },
                t('modeEdit'),
              ),
            )
          : null;

        let body;
        if (docState === 'missing') {
          const siblings = ((state && state.project) || []).filter(
            (e) => e.name !== entry.name && e.group === entry.group && e.exists,
          );
          body = h(
            'div',
            { className: 'amv-empty' },
            IconFile(26),
            h('div', { className: 'amv-empty-title' }, t('missingTitle')),
            h('div', { className: 'amv-empty-body' }, t('missingBody').replace('{path}', entry.displayPath)),
            siblings.length ? h('div', { className: 'amv-empty-body' }, t('missingOther')) : null,
            h(
              'div',
              { className: 'amv-empty-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'amv-btn amv-btn-primary',
                  disabled: !!busy,
                  onClick: () => write(t('template'), null, true),
                },
                IconPlus(13),
                busy === 'create' ? t('creating') : t('create'),
              ),
            ),
          );
        } else if (docState !== 'ready') {
          body = loadingRow(t('loading'));
        } else if (showEdit) {
          const over = draftBytes > MAX_BYTES;
          body = h(
            'div',
            { className: 'amv-editor', onKeyDown: onEditorKeyDown },
            h('textarea', {
              className: 'amv-textarea',
              value: draft,
              spellCheck: false,
              wrap: 'off',
              'aria-label': t('editorLabel'),
              onChange: (e) => setDraft(e.target.value),
            }),
            h(
              'div',
              { className: 'amv-editor-bar' },
              h('span', { className: 'amv-stat' }, t('bytesCount').replace('{n}', String(draftBytes))),
              h('span', { className: 'amv-stat' }, t('metricInjected') + ' ' + formatBytes(draftStats.injectBytes)),
              h('span', { className: 'amv-stat' }, t('metricChars') + ' ' + String(draftStats.chars)),
              h('span', { className: 'amv-stat' }, t('metricTokens') + ' ' + t('metricTokensApprox').replace('{n}', String(draftStats.tokens))),
              h('span', { className: 'amv-kbd' }, t('ctrlS')),
              dirty ? h('span', { className: 'amv-dirty' }, h('span', { className: 'amv-dot' }), t('unsaved')) : null,
              over ? h('span', { className: 'amv-over' }, t('tooLarge')) : null,
              h('span', { className: 'amv-spacer' }),
              h(
                'button',
                { type: 'button', className: 'amv-btn', disabled: !dirty || !!busy, onClick: () => setDraft(doc.content || '') },
                t('revert'),
              ),
              h(
                'button',
                { type: 'button', className: 'amv-btn amv-btn-primary', disabled: !canSave, onClick: save },
                busy === 'save' ? t('saving') : t('save'),
              ),
            ),
          );
        } else {
          const content = typeof doc.content === 'string' ? doc.content : '';
          const clipped = content.length > PREVIEW_LIMIT;
          body = [
            // 截断提示：/read 只回了前 1 MiB，这时**必须**禁止编辑（写回会丢内容）
            truncated
              ? h(
                  'div',
                  { key: 'tr', className: 'amv-banner amv-banner-warn amv-inset' },
                  IconAlert(13, 'amv-icon-warn'),
                  h(
                    'div',
                    { className: 'amv-banner-col' },
                    h('span', null, t('truncatedNotice')),
                    h('span', null, t('editBlocked')),
                  ),
                )
              : null,
            clipped
              ? h(
                  'div',
                  { key: 'clip', className: 'amv-note amv-inset-b' },
                  IconInfo(12),
                  h('span', null, t('previewClipped').replace('{n}', String(PREVIEW_LIMIT))),
                )
              : null,
            content
              ? h(
                  'div',
                  { key: 'pv', className: 'amv-pv' },
                  // 渲染态工具条：在「排版后」与「原始源码」之间切换。
                  // 预览默认走渲染态（你要的「预览态可渲染」），源码态保留等宽视图方便核对字面量。
                  h(
                    'div',
                    { className: 'amv-prebar' },
                    IconInfo(12),
                    h('span', { className: 'amv-stat' }, t('previewRendered')),
                    h('div', { className: 'amv-spacer' }),
                    h(
                      'div',
                      { className: 'amv-seg', role: 'tablist', 'aria-label': t('previewRendered') },
                      h(
                        'button',
                        {
                          type: 'button',
                          role: 'tab',
                          className: 'amv-seg-btn',
                          'aria-selected': pvMode === 'rendered' ? 'true' : 'false',
                          onClick: () => setPvMode('rendered'),
                        },
                        t('pvRendered'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          role: 'tab',
                          className: 'amv-seg-btn',
                          'aria-selected': pvMode === 'source' ? 'true' : 'false',
                          onClick: () => setPvMode('source'),
                        },
                        t('pvSource'),
                      ),
                    ),
                  ),
                  pvMode === 'source'
                    ? h('pre', { className: 'amv-preview' }, clipped ? content.slice(0, PREVIEW_LIMIT) : content)
                    : h(
                        'div',
                        { className: 'amv-md' },
                        renderMarkdown(clipped ? content.slice(0, PREVIEW_LIMIT) : content),
                      ),
                )
              : h('pre', { key: 'pre', className: 'amv-preview amv-preview-empty' }, t('emptyFile')),
          ];
        }

        return h(
          'div',
          { className: 'amv-detail' },
          h(
            'div',
            { className: 'amv-meta' },
            h(
              'div',
              { className: 'amv-meta-main' },
              h('div', { className: 'amv-meta-path' }, entry.displayPath),
              // 四项指标：占用字节 / 注入字节 / 已用字数 / token 估算（口径见悬停提示）
              liveStats
                ? metricsEl(liveStats, metaSize)
                : h(
                    'div',
                    { className: 'amv-metrics' },
                    h('span', { className: 'amv-metrics-label' }, t('metricOccupied')),
                    h('span', { className: 'amv-metrics-value' }, formatBytes(metaSize)),
                  ),
              h(
                'div',
                { className: 'amv-meta-sub' },
                h('span', null, formatBytes(metaSize)),
                metaMtime ? h('span', { className: 'amv-dot' }) : null,
                metaMtime ? h('span', null, formatTime(metaMtime)) : null,
                h('span', { className: 'amv-dot' }),
                h(
                  'span',
                  null,
                  entry.scope === 'third'
                    ? (() => {
                        const tool = thirdPartyToolOf(state, entry.key);
                        return tool ? tool.name : t('tabThird');
                      })()
                    : t(entry.scope === 'global' ? 'tabGlobal' : 'tabProject'),
                ),
                h('span', { className: 'amv-dot' }),
                badgeOf(status, entry.scope),
              ),
              dupNote,
              sharedNoteOf(entry)
                ? h(
                    'div',
                    { className: 'amv-note-warn' },
                    IconAlert(12, 'amv-icon-warn'),
                    h('span', null, sharedNoteOf(entry)),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'amv-meta-side' },
              modeSwitch,
              h(
                'button',
                {
                  type: 'button',
                  className: 'amv-btn',
                  disabled: !!busy || stateBusy || dirty,
                  title: dirty ? t('unsaved') : t('refresh'),
                  onClick: refresh,
                },
                IconRefresh(13),
                t('refresh'),
              ),
            ),
          ),
          conflict
            ? h(
                'div',
                { className: 'amv-conflict' },
                h('div', { className: 'amv-conflict-title' }, t('conflictTitle')),
                h('div', { className: 'amv-conflict-body' }, t('conflictBody')),
                h(
                  'div',
                  { className: 'amv-conflict-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'amv-btn amv-btn-primary', disabled: !!busy, onClick: () => write(draft, null, false) },
                    t('overwrite'),
                  ),
                  h('button', { type: 'button', className: 'amv-btn', disabled: !!busy, onClick: forceReload }, IconRefresh(13), t('refresh')),
                ),
              )
            : null,
          body,
        );
      };

      // ── 顶部：标题 / 提示条 / Tab / 说明 ────────────────────────────────
      const notesEl =
        state && state.notes && state.notes.length
          ? h(
              'div',
              { className: 'amv-notes' },
              h('div', { className: 'amv-note' }, IconInfo(12), h('span', null, t('notesTitle'))),
              state.notes.map((line, i) => h('div', { key: i, className: 'amv-note' }, h('span', null, String(line)))),
            )
          : null;

      return h(
        'section',
        { className: 'amv-section', 'aria-busy': busy === 'read' || stateBusy ? 'true' : 'false', 'aria-label': t('title') },
        h('style', null, CSS),
        h(
          'div',
          { className: 'amv-hd' },
          h('h2', { className: 'amv-title' }, t('title')),
          h('p', { className: 'amv-intro' }, t('intro')),
        ),
        h(
          'div',
          { className: 'amv-tabs', role: 'tablist', 'aria-label': t('title') },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'amv-tab',
              'aria-selected': tab === 'project' ? 'true' : 'false',
              onClick: () => switchTab('project'),
            },
            t('tabProject'),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'amv-tab',
              'aria-selected': tab === 'global' ? 'true' : 'false',
              onClick: () => switchTab('global'),
            },
            t('tabGlobal'),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'amv-tab',
              'aria-selected': tab === 'third' ? 'true' : 'false',
              onClick: () => switchTab('third'),
            },
            t('tabThird'),
          ),
        ),
        err
          ? h(
              'div',
              { className: 'amv-banner amv-banner-err', role: 'alert' },
              IconAlert(13, 'amv-icon-warn'),
              h('span', { className: 'amv-banner-txt' }, err.text),
              h('button', { type: 'button', className: 'amv-btn', onClick: () => loadState(ws, false) }, t('retry')),
            )
          : null,
        notice
          ? h(
              'div',
              { className: 'amv-banner amv-banner-ok', role: 'status' },
              IconCheck(13, 'amv-icon-ok'),
              h('span', { className: 'amv-banner-txt' }, notice),
            )
          : null,
        tab === 'project' ? projectPane() : tab === 'global' ? globalPane() : thirdPane(),
        notesEl,
        // 注意：详情面板不再在这里渲染 —— 它由 rowOf / cardOf 内联到选中项下方，
        // 这样点击后视线不需要跳到底部就能看到内容。
      );
    }

    // ── 插件装配 ───────────────────────────────────────────────────────────
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agents-md: dictionaries');
      const t = ctx.locale.bind(NS);
      activeT = t;

      // 设置页 section；label 是函数，切语言时会重新求值
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'agents-md', order: 8, label: () => t('nav') },
          Section,
        ),
      );
    }

    return { inject, apply };
  },
});
