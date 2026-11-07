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
      '.amv-tool-hd .amv-icon{width:15px;height:15px;display:block}',
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
      // 子Tab里的品牌图标：固定方块尺寸并垂直居中；彩色 Logo 不随选中态变色
      '.amv-subtab .amv-icon{width:13px;height:13px;display:block}',
      // 字母占位图标：品牌色圆角方块 + 白色首字母（底色由内联 style 提供）
      '.amv-brand-letter{display:inline-block;flex:none;border-radius:3px;color:#fff;font-weight:700;text-align:center;overflow:hidden;user-select:none}',
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
      // 自定义工具的 JSON 文本框仍用普通 textarea；规则文件编辑器走「高亮层 + 透明 textarea」双层结构
      '.amv-textarea{display:block;width:100%;box-sizing:border-box;min-height:260px;height:340px;padding:11px 12px;border:none;outline:none;resize:vertical;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:' + MONO + ';font-size:12.5px;line-height:1.6;tab-size:2}',
      '.amv-textarea:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}',
      // 编辑器双层结构：行号条 + 代码盒（高亮层在下、textarea 在上）。
      // 对齐是硬约束：两层与 textarea 的字体 / 字号 / 行高 / padding / tab-size 必须逐项一致，
      // 否则着色会与光标错位；textarea 文字透明、光标可见，看到的着色来自下层。
      // resize 挂在包裹层上（textarea absolute 后自身 resize 不会带动行号与高亮层）。
      '.amv-editwrap{display:flex;height:340px;min-height:260px;overflow:hidden;resize:vertical;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px}',
      '.amv-editwrap:focus-within{border-color:var(--dsw-alias-brand-primary)}',
      '.amv-gutter{flex:none;min-width:36px;overflow:hidden;padding:11px 0 0;text-align:right;background:var(--dsw-alias-bg-layer-2);border-right:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-family:' + MONO + ';font-size:11px;line-height:20px;white-space:pre;user-select:none}',
      '.amv-gutter-num{display:block;font-family:inherit;font-size:inherit;padding:0 8px 0 6px}',
      '.amv-codebox{position:relative;flex:1;min-width:0;overflow:hidden}',
      '.amv-hl{position:absolute;inset:0;margin:0;padding:11px 12px;overflow:hidden;white-space:pre;background:transparent;font-family:' + MONO + ';font-size:12.5px;line-height:1.6;tab-size:2;color:var(--dsw-alias-label-primary);pointer-events:none}',
      '.amv-input{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;padding:11px 12px;border:none;outline:none;resize:none;background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary);font-family:' + MONO + ';font-size:12.5px;line-height:1.6;tab-size:2;white-space:pre;overflow:auto}',
      '.amv-input::selection{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent)}',
      // 着色谱：全部取主题 token —— 标题用品牌色，代码用成功色，标记用警示色，
      // frontmatter 与表格线退为次级文字色；选中时整块底色可见、字形仍由下层着色呈现
      '.amv-hl-h{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.amv-hl-b{font-weight:600}',
      '.amv-hl-i{font-style:italic;color:var(--dsw-alias-label-secondary)}',
      '.amv-hl-c{color:var(--dsw-alias-state-success-primary)}',
      '.amv-hl-l{color:var(--dsw-alias-brand-primary);text-decoration:underline}',
      '.amv-hl-m{color:var(--dsw-alias-state-warn-primary)}',
      '.amv-hl-q{color:var(--dsw-alias-state-idle-primary)}',
      '.amv-hl-fm{color:var(--dsw-alias-label-secondary);font-style:italic}',
      '.amv-hl-hr{color:var(--dsw-alias-label-secondary)}',
      '.amv-hl-t{color:var(--dsw-alias-label-secondary)}',
      // 只读高亮（对比窗右侧源码视图）：复用 amv-hl-* 色谱，但自己是普通 pre
      '.amv-cmp-src{white-space:pre;overflow-wrap:normal}',
      '.amv-editor-bar{display:flex;align-items:center;gap:8px;padding:6px 11px;background:var(--dsw-alias-bg-layer-2);border-top:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.amv-stat{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      // 全屏：覆盖层用 fixed 兜住整个视口拦截交互，内容容器则**实测设置面板矩形**
      //（role=dialog + data-shortcut-modal="settings"）后绝对定位进去 —— 放大到
      // 「设置页允许的最大区域」即面板宽高本身，不会超出设置页。
      // 对比态（双文件并列）需要横向空间：面板加宽到视口 92%，以宽度为准、高度随视口；
      // 单文件全屏维持原样（设置面板矩形），宽高都不变。
      '.amv-fs{position:fixed;inset:0;z-index:1100;background:color-mix(in srgb,var(--dsw-alias-bg-base) 88%,transparent);backdrop-filter:blur(2px)}',
      '.amv-fs-panel{position:absolute;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 32px rgba(0,0,0,.18);overflow:hidden}',
      '.amv-fs-panel[data-wide=true]{width:92vw !important;height:calc(100vh - 48px) !important;left:4vw !important;top:24px !important}',
      '.amv-fs-bar{display:flex;align-items:center;gap:8px;padding:7px 11px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.amv-fs-title{font-size:12.5px;line-height:18px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.amv-fs-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}',
      '.amv-fs-body .amv-editor,.amv-fs-body .amv-pv{flex:1;min-height:0}',
      '.amv-fs-body .amv-editwrap{height:auto;flex:1;min-height:0;resize:none}',
      '.amv-fs-body .amv-textarea{height:100%;min-height:0;resize:none}',
      '.amv-fs-body .amv-md{max-width:none}',
      // 预览内容默认 max-height:420px（非全屏时防止页面被撑长）；全屏里解除上限
      // 并让内容 flex 撑满，否则预览只占上半截、下半空白
      '.amv-fs-body .amv-pv{display:flex;flex-direction:column}',
      '.amv-fs-body .amv-md,.amv-fs-body .amv-preview{flex:1;min-height:0;max-height:none}',
      '.amv-fs-btn{align-self:flex-start}',
      // 对比窗：双列网格（窄容器退化为单列的兜底在下方 media query，宽面板下不触发）
      '.amv-fs-cmp{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0;overflow:hidden}',
      '.amv-fs-pane{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}',
      '.amv-fs-pane+.amv-fs-pane{border-left:.5px solid var(--dsw-alias-border-l2)}',
      '.amv-fs-pane-hd{display:flex;align-items:center;gap:7px;padding:5px 10px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.amv-fs-pane-path{flex:1;min-width:120px;font-family:' + MONO + ';font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.amv-fs-pane-bd{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      // 对比窗侧的内容区自身滚动（编辑器、预览、源码视图都撑满面板格）。
      // .amv-pv 必须照搬单文件全屏的 flex column 处理：它是「工具条 + 内容」的
      // 纵向组合，不设 flex 的话渲染内容不产生滚动框，溢出被 overflow:hidden 裁掉
      //（表现为「预览态滚不动」——编辑态能滚是因为 textarea 自身就有滚动）。
      '.amv-fs-pane-bd .amv-editor,.amv-fs-pane-bd .amv-pv,.amv-fs-pane-bd .amv-cmp-src{flex:1;min-height:0}',
      '.amv-fs-pane-bd .amv-pv{display:flex;flex-direction:column}',
      '.amv-fs-pane-bd .amv-editwrap{height:auto;flex:1;min-height:0;resize:none}',
      '.amv-fs-pane-bd .amv-md{flex:1;min-height:0;max-height:none}',
      '.amv-fs-pane-bd .amv-preview{flex:1;min-height:0;max-height:none;overflow:auto}',
      '.amv-fs-pane-bd .amv-prebar{flex:none}',
      // 路径行 + 行内小图标按钮（资源管理器定位）
      '.amv-meta-path-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '.amv-icon-btn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:2px;border-radius:5px;display:inline-flex;flex-shrink:0}',
      '.amv-icon-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.amv-icon-btn:focus-visible{box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}',
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
      // 对比窗加宽后视口很窄时退回单列，避免两列各自挤成一条缝
      '@media (max-width:760px){.amv-fs-cmp{grid-template-columns:minmax(0,1fr)}.amv-fs-pane+.amv-fs-pane{border-left:none;border-top:.5px solid var(--dsw-alias-border-l2)}}',
    ].join('');

    // ── 文案（zh / en 两套，key 必须一一对应）──────────────────────────────
    const zh = {
      nav: '规则',
      title: '规则（AGENTS.md）',
      intro: '查看、创建与编辑 DSH 实际会加载的 AGENTS.md：项目级跟随所选工作区的目录链，全局级覆盖 ~/.dsh 与 ~/.agents。',
      tabProject: '项目级',
      tabGlobal: '全局级',
      tabThird: '第三方',
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
      reveal: '在资源管理器中显示',
      revealFail: '无法打开文件资源管理器：{msg}',
      fullscreen: '全屏',
      fullscreenExit: '退出全屏',
      fullscreenHint: '放大到设置页允许的最大区域，专注浏览与编辑；再点一次或按 Esc 退出。',
      compare: '对比',
      compareHint: '并列查看两份规则文件：左侧为当前文件，右侧可任选；有共用文件时默认选中第一份。',
      compareClose: '关闭对比',
      compareWith: '对比对象',
      compareReadFail: '读取对比文件失败：{msg}',
      compareLoading: '读取对比文件…',
      compareLeft: '当前文件',
      compareRight: '对比文件',
      compareOnlyEdit: '仅左侧可编辑',
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
      reveal: 'Reveal in file manager',
      revealFail: 'Failed to open the file manager: {msg}',
      fullscreen: 'Fullscreen',
      fullscreenExit: 'Exit fullscreen',
      fullscreenHint: 'Enlarge this area to the maximum the settings page allows for focused reading and editing; click again or press Esc to exit.',
      compare: 'Compare',
      compareHint: 'View two rule files side by side: the left pane is the current file, the right one is selectable; defaults to the first shared file when one exists.',
      compareClose: 'Close compare',
      compareWith: 'Compare with',
      compareReadFail: 'Failed to read the comparison file: {msg}',
      compareLoading: 'Reading the comparison file…',
      compareLeft: 'Current file',
      compareRight: 'Compared file',
      compareOnlyEdit: 'Left side editable only',
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

    // ── 编辑态 Markdown 语法着色 ───────────────────────────────────────────
    // 叠层高亮：底层 pre 渲染色块，上层透明 textarea 接收输入（光标 caret-color 可见）。
    // 两层必须逐字符等宽对齐，因此任何输出都不得改变原文长度 —— 每个标记的
    // 文本内容与原文逐字相同，只附加 className。
    /**
     * 行内着色：粗体 / 斜体 / 行内代码 / 链接，文本原样切分、只包 className。
     * 与渲染态 inline() 同一套识别顺序（代码最先，防止内部符号被再解析）。
     * @param {string} text - 行内文本
     * @param {string} keyPrefix - React key 前缀
     * @returns {Array} React 子节点数组
     */
    function hlInline(text, keyPrefix) {
      const out = [];
      const re = /`([^`]+)`|\[([^\]]*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
      let last = 0;
      let m;
      let n = 0;
      const push = (cls, str) => {
        if (!str) return;
        out.push(cls ? h('span', { key: keyPrefix + '-' + n++, className: cls }, str) : str);
      };
      while ((m = re.exec(text)) !== null) {
        push(null, text.slice(last, m.index));
        if (m[1] !== undefined) push('amv-hl-c', m[0]);
        else if (m[2] !== undefined) {
          // 链接：[文字](url) 整段品牌色；文字与括号逐字保留
          push(/^https?:\/\//i.test(m[3]) ? 'amv-hl-l' : null, m[0]);
        } else if (m[4] !== undefined && m[4].length > 0) push('amv-hl-b', m[0]);
        else if (m[5] !== undefined && m[5].length > 0) push('amv-hl-b', m[0]);
        else if (m[6] !== undefined && m[6].length > 0) push('amv-hl-i', m[0]);
        else if (m[7] !== undefined && m[7].length > 0) push('amv-hl-i', m[0]);
        last = re.lastIndex;
      }
      push(null, text.slice(last));
      return out;
    }

    /**
     * 把一段 Markdown 文本按行着色，输出 React 元素数组。
     * 行级定基调（标题/围栏/引用/表格线/分割线/frontmatter），行内再走 hlInline；
     * 列表行只给行首标记上警示色，正文交给行内着色，避免整行继承标记色。
     * @param {string} src - 编辑器当前文本
     * @returns {Array} React 子节点数组
     */
    function highlightMarkdown(src) {
      const text = String(src ?? '');
      const lines = text.split('\n');
      const out = [];
      let inFence = false;
      let fenceMark = '`';
      let fenceLen = 3;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nl = i < lines.length - 1 ? '\n' : '';
        const k = 'hl-' + i;
        // frontmatter：文件以 --- 开头时，到第二条 --- 为止整块退色
        if (i === 0 && /^---[ \t]*$/.test(line)) {
          out.push(h('span', { key: k, className: 'amv-hl-fm' }, line + nl));
          continue;
        }
        if (out.length > 0 && out[out.length - 1].props.className === 'amv-hl-fm') {
          if (/^---[ \t]*$/.test(line)) out.push(h('span', { key: k, className: '' }, line + nl));
          else out.push(h('span', { key: k, className: 'amv-hl-fm' }, line + nl));
          continue;
        }
        // 围栏代码块：开栏着色行本身，内部行整体一个色，直到同长同符的闭栏
        const fence = /^\s*(`{3,}|~{3,})/.exec(line);
        if (inFence) {
          const close = new RegExp('^\\s*' + (fenceMark === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$');
          if (close.test(line)) inFence = false;
          out.push(h('span', { key: k, className: 'amv-hl-c' }, line + nl));
          continue;
        }
        if (fence) {
          inFence = true;
          fenceMark = fence[1][0];
          fenceLen = fence[1].length;
          out.push(h('span', { key: k, className: 'amv-hl-c' }, line + nl));
          continue;
        }
        // 标题：整行品牌色加粗，行内的强调标记不再二次着色
        if (/^\s{0,3}#{1,6}\s/.test(line)) {
          out.push(h('span', { key: k, className: 'amv-hl-h' }, line + nl));
          continue;
        }
        // 引用（含嵌套 >）：行首标记退色，内部正文行走行内着色
        if (/^\s{0,3}>/.test(line)) {
          const qm = /^(\s{0,3}>\s?)(.*)$/.exec(line);
          out.push(
            h(
              'span',
              { key: k, className: 'amv-hl-q' },
              qm[1],
              h('span', { key: k + '-b' }, hlInline(qm[2], k)),
              nl,
            ),
          );
          continue;
        }
        // 表格行（含分隔行）
        if (/^\s*\|.*\|\s*$/.test(line) || isTableDivider(line)) {
          out.push(h('span', { key: k, className: 'amv-hl-t' }, line + nl));
          continue;
        }
        // 分割线
        if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
          out.push(h('span', { key: k, className: 'amv-hl-hr' }, line + nl));
          continue;
        }
        // 列表行：只给行首标记上色，正文交给行内着色（否则整行继承标记色）
        const li = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/.exec(line);
        if (li) {
          out.push(
            h(
              'span',
              { key: k },
              h('span', { key: k + '-m', className: 'amv-hl-m' }, li[1] + li[2] + li[3]),
              hlInline(li[4], k),
              nl,
            ),
          );
          continue;
        }
        out.push(h('span', { key: k }, hlInline(line, k), nl));
      }
      return out;
    }

    /** 编辑器内容行数（textarea 按 \n 计行，末尾换行也占一行） */
    function lineCount(text) {
      const s = String(text ?? '');
      if (s === '') return 1;
      return s.split('\n').length;
    }

    /** 行号条：每行一个块级数字 */
    function gutterNumbers(count) {
      const out = [];
      for (let i = 1; i <= count; i++) out.push(h('span', { key: i, className: 'amv-gutter-num' }, String(i)));
      return out;
    }

    /**
     * 编辑器（行号条 + 着色层 + 透明 textarea）。
     * 滚动同步：textarea 是唯一滚动源，onScroll 把 scrollTop/Left 写回行号条与着色层。
     * resize 挂在包裹层，textarea absolute 不参与尺寸计算。
     * @param {object} p - { value, onChange, onKeyDown, label, lines }
     * @returns {object} React 元素
     */
    function CodeEditor(p) {
      const hlRef = useRef(null);
      const gutterRef = useRef(null);
      const sync = (e) => {
        const el = e && e.target ? e.target : null;
        if (!el) return;
        if (hlRef.current) {
          hlRef.current.scrollTop = el.scrollTop;
          hlRef.current.scrollLeft = el.scrollLeft;
        }
        if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
      };
      return h(
        'div',
        { className: 'amv-editwrap' },
        h('div', { ref: gutterRef, className: 'amv-gutter', 'aria-hidden': 'true' }, gutterNumbers(p.lines)),
        h(
          'div',
          { className: 'amv-codebox' },
          h('pre', { ref: hlRef, className: 'amv-hl', 'aria-hidden': 'true' }, highlightMarkdown(p.value)),
          h('textarea', {
            className: 'amv-input',
            value: p.value,
            spellCheck: false,
            wrap: 'off',
            'aria-label': p.label,
            onChange: p.onChange,
            onKeyDown: p.onKeyDown,
            onScroll: sync,
          }),
        ),
      );
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

    // 「规则」导航图标：带正文行的文档，呼应 AGENTS.md 规则文件
    const IconRules = (size, cls) =>
      svg(
        [
          h('path', { key: 'a', d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }),
          h('path', { key: 'b', d: 'M14 3v5h5' }),
          h('path', { key: 'c', d: 'M9 13h6' }),
          h('path', { key: 'd', d: 'M9 16.5h4' }),
        ],
        size,
        cls,
      );

    // 全屏：四角向外；退出全屏：四角向内
    const IconExpand = (size, cls) =>
      svg(
        [
          h('path', { key: 'a', d: 'M15 3h6v6' }),
          h('path', { key: 'b', d: 'M9 21H3v-6' }),
          h('path', { key: 'c', d: 'M21 3l-7 7' }),
          h('path', { key: 'd', d: 'M3 21l7-7' }),
        ],
        size,
        cls,
      );

    const IconCollapse = (size, cls) =>
      svg(
        [
          h('path', { key: 'a', d: 'M21 9h-6V3' }),
          h('path', { key: 'b', d: 'M3 15h6v6' }),
          h('path', { key: 'c', d: 'M14 10l7-7' }),
          h('path', { key: 'd', d: 'M10 14l-7 7' }),
        ],
        size,
        cls,
      );

    // 「在资源管理器中显示」：文件夹带定位标
    const IconReveal = (size, cls) =>
      svg(
        [
          h('path', { key: 'a', d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' }),
          h('circle', { key: 'b', cx: 16.5, cy: 13.5, r: 2.6 }),
          h('path', { key: 'c', d: 'M18.5 15.5L21 18' }),
        ],
        size,
        cls,
      );

    // ── 第三方工具品牌图标（取自 @lobehub/icons static-svg，MIT License）──────
    // 内联路径数据：mono 图标 fill=currentColor 跟随主题；彩色变体保留官方品牌色。
    // 唯一用渐变的两个图标（gemini / codebuddy）的渐变 id 固定为 amv-grad-*，
    // 同页多实例不冲突；defs 由 BrandIcon 组件按需挂载。
    const BRAND_PATHS = {
      'claude': [
        { d: 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z', fill: '#D97757', fillRule: 'nonzero' },
      ],
      'openai': [
        { d: 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z' },
      ],
      'gemini': [
        { d: 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z', fill: '#3186FF' },
        { d: 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z', fill: 'url(#amv-grad-g0)' },
        { d: 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z', fill: 'url(#amv-grad-g1)' },
        { d: 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z', fill: 'url(#amv-grad-g2)' },
      ],
      'cursor': [
        { d: 'M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z' },
      ],
      'trae': [
        { d: 'M24 20.541H3.428v-3.426H0V3.4h24V20.54zM3.428 17.115h17.144V6.827H3.428v10.288zm8.573-5.196l-2.425 2.424-2.424-2.424 2.424-2.424 2.425 2.424zm6.857-.001l-2.424 2.423-2.425-2.423 2.425-2.425 2.424 2.425z', fill: '#32F08C' },
      ],
      'codebuddy': [
        { d: 'M18.821 0H5.18A5.179 5.179 0 000 5.179V18.82A5.179 5.179 0 005.179 24H18.82A5.179 5.179 0 0024 18.821V5.18A5.179 5.179 0 0018.821 0z', fill: 'url(#amv-grad-cb)' },
        { d: 'M18.777 1.647c.28-.02.536.114.972.51 1.018.926 2.437 2.828 3.318 4.452l.34.631.482.24.11.06v3.638a5.206 5.206 0 00-5.32-1.23c-.491.166-1.021.471-2.08 1.082l-6.09 3.516c-1.057.61-1.586.916-1.975 1.259a5.208 5.208 0 00-1.493 5.572c.165.49.471 1.02 1.082 2.08l.315.543h-3.26c-.685 0-1.34-.135-1.939-.377-.169-.956-.009-1.789.469-2.335.158-.18.164-.189.13-.493a11.846 11.846 0 01-.057-1.711l.02-.444-.667-1.18C2.1 15.622 1.445 14.078 1.192 12.9c-.133-.647-.125-.934.04-1.146.1-.128.427-.261.822-.334.994-.175 3.162-.017 5.575.41l.25.043.551-.487c.915-.81 1.522-1.264 2.641-1.962 1.167-.73 2.484-1.331 3.967-1.807l.476-.152.261-.688c.937-2.471 1.896-4.293 2.58-4.9.235-.21.25-.22.422-.23z', fill: '#fff' },
        { d: 'M12.139 18.2a1.203 1.203 0 011.642.44l1.296 2.243a1.204 1.204 0 01-2.083 1.203l-1.296-2.243a1.203 1.203 0 01.44-1.644zM18.629 14.452a1.203 1.203 0 011.642.44l1.295 2.244a1.203 1.203 0 11-2.083 1.203l-1.295-2.243a1.203 1.203 0 01.44-1.644z', fill: '#fff' },
      ],
      'tencent': [
        { d: 'M9.976 1L24 9.8l-10.587.015L10.723 23H5.489L8.18 9.8H3.244L1 5.4h8.077L9.976 1z', fill: '#0052D9', fillRule: 'evenodd' },
      ],
      'workbuddy': [
        { d: 'M18.777 1.647c.28-.02.536.114.972.51 1.018.926 2.437 2.828 3.318 4.452l.34.631.482.24.11.06v3.638a5.206 5.206 0 00-5.32-1.23c-.491.166-1.021.471-2.08 1.082l-6.09 3.516c-1.057.61-1.586.916-1.975 1.259a5.208 5.208 0 00-1.493 5.572c.165.49.471 1.02 1.082 2.08l.315.543h-3.26c-.685 0-1.34-.135-1.939-.377-.169-.956-.009-1.789.469-2.335.158-.18.164-.189.13-.493a11.846 11.846 0 01-.057-1.711l.02-.444-.667-1.18C2.1 15.622 1.445 14.078 1.192 12.9c-.133-.647-.125-.934.04-1.146.1-.128.427-.261.822-.334.994-.175 3.162-.017 5.575.41l.25.043.551-.487c.915-.81 1.522-1.264 2.641-1.962 1.167-.73 2.484-1.331 3.967-1.807l.476-.152.261-.688c.937-2.471 1.896-4.293 2.58-4.9.235-.21.25-.22.422-.23z' },
        { d: 'M12.139 18.2a1.203 1.203 0 011.642.44l1.296 2.243a1.204 1.204 0 01-2.083 1.203l-1.296-2.243a1.203 1.203 0 01.44-1.644zM18.629 14.452a1.203 1.203 0 011.642.44l1.295 2.244a1.203 1.203 0 11-2.083 1.203l-1.295-2.243a1.203 1.203 0 01.44-1.644z' },
      ],
      'roocode': [
        { d: 'M20.113 5.5l-.442 1.557a.157.157 0 01-.196.106l-7.414-2.157a.16.16 0 00-.143.028l-7.342 5.74a.159.159 0 01-.074.032l-4.37.656a.154.154 0 00-.132.162l.02.245c.005.078.071.14.152.141l5.074.128.058.002 3.75-1.953a.16.16 0 01.164.01l2.657 1.847a.152.152 0 01.066.125l-.023 2.45c0 .032.01.063.028.089l3.737 5.227c.03.04.077.065.129.065h1.182a.153.153 0 00.14-.224l-2.664-4.919a.15.15 0 01.005-.152l1.389-2.169a.156.156 0 01.062-.055l4.965-2.456a.16.16 0 01.158.01l1.418.921a.16.16 0 00.087.026h1.289c.125 0 .2-.136.13-.237l-3.578-5.29c-.074-.109-.246-.082-.282.044z' },
      ],
      'opencode': [
        { d: 'M16 6H8v12h8V6zm4 16H4V2h16v20z' },
      ],
      'windsurf': [
        { d: 'M23.78 5.004h-.228a2.187 2.187 0 00-2.18 2.196v4.912c0 .98-.804 1.775-1.76 1.775a1.818 1.818 0 01-1.472-.773L13.168 5.95a2.197 2.197 0 00-1.81-.95c-1.134 0-2.154.972-2.154 2.173v4.94c0 .98-.797 1.775-1.76 1.775-.57 0-1.136-.289-1.472-.773L.408 5.098C.282 4.918 0 5.007 0 5.228v4.284c0 .216.066.426.188.604l5.475 7.889c.324.466.8.812 1.351.938 1.377.316 2.645-.754 2.645-2.117V11.89c0-.98.787-1.775 1.76-1.775h.002c.586 0 1.135.288 1.472.773l4.972 7.163a2.15 2.15 0 001.81.95c1.158 0 2.151-.973 2.151-2.173v-4.939c0-.98.787-1.775 1.76-1.775h.194c.122 0 .22-.1.22-.222V5.225a.221.221 0 00-.22-.222z', clipRule: 'evenodd' },
      ],
      'cline': [
        { d: 'M17.035 3.991c2.75 0 4.98 2.24 4.98 5.003v1.667l1.45 2.896a1.01 1.01 0 01-.002.909l-1.448 2.864v1.668c0 2.762-2.23 5.002-4.98 5.002H7.074c-2.751 0-4.98-2.24-4.98-5.002V17.33l-1.48-2.855a1.01 1.01 0 01-.003-.927l1.482-2.887V8.994c0-2.763 2.23-5.003 4.98-5.003h9.962zM8.265 9.6a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 004.547 0v-4.042A2.274 2.274 0 008.265 9.6zm7.326 0a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 104.548 0v-4.042A2.274 2.274 0 0015.59 9.6z' },
        { d: 'M12.054 5.558a2.779 2.779 0 100-5.558 2.779 2.779 0 000 5.558z' },
      ],
      'githubcopilot': [
        { d: 'M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z' },
      ],
      'kiro': [
        { d: 'M18.8 0H5.2A5.2 5.2 0 000 5.2v13.6A5.2 5.2 0 005.2 24h13.6a5.2 5.2 0 005.2-5.2V5.2A5.2 5.2 0 0018.8 0z', fill: '#9046FF' },
        { d: 'M7.97 16.376c-1.644 3.642 1.86 4.556 4.443 2.424.76 2.39 3.608.607 4.631-1.247 2.251-4.084 1.342-8.249 1.108-9.108-1.6-5.859-9.6-5.869-10.976.03-.323 1.033-.328 2.206-.507 3.423-.09.617-.16 1.009-.393 1.655-.139.373-.323.7-.62 1.257-.458.865-.264 2.53 2.101 1.665l.224-.1h-.01l-.001.001z', fill: '#fff' },
        { d: 'M12.722 10.985c-.656 0-.755-.785-.755-1.252 0-.423.074-.756.218-.97a.61.61 0 01.537-.283c.229 0 .428.095.567.289.159.218.243.55.243.964 0 .785-.303 1.252-.805 1.252h-.005zm2.703 0c-.656 0-.755-.785-.755-1.252 0-.423.074-.756.219-.97a.61.61 0 01.536-.283c.229 0 .428.095.567.289.159.218.243.55.243.964 0 .785-.303 1.252-.805 1.252h-.005z', fill: '#000' },
      ],
      'qoder': [
        { d: 'M23.376 14.458v-4.056c0-2.304-1.003-4.154-2.748-5.075L11.612.574l-.046.086-.045.086c1.68.886 2.644 2.673 2.644 4.902v4.056a7.928 7.928 0 01-.014.454l-.005.061c-.005.081-.01.164-.018.245a4.897 4.897 0 01-.011.1l-.01.076c-.008.068-.015.135-.025.203l-.018.113-.01.058a9.99 9.99 0 01-.098.513l-.007.03a7.209 7.209 0 01-.074.294l-.024.086c-.027.099-.056.197-.087.296l-.027.085a9.592 9.592 0 01-.111.323l-.033.085-.018.046c-.032.082-.064.166-.098.248-.019.048-.04.096-.061.145l-.007.017a6 6 0 01-.084.187c-.024.056-.05.11-.077.165-.03.061-.058.122-.089.182a9.423 9.423 0 01-.176.332c-.03.056-.062.111-.094.167-.031.053-.062.108-.095.16-.033.055-.066.11-.101.164-.033.053-.065.104-.1.155-.034.055-.07.107-.111.169l-.099.144a15.193 15.193 0 01-.34.457c-.04.05-.08.102-.121.151l-.107.128-.007.008a6.987 6.987 0 01-.262.298l-.149.16-.116.12a9.562 9.562 0 01-.204.198l-.03.03-.072.069a9.05 9.05 0 01-.263.235l-.025.022-.029.026-.042.035a11.7 11.7 0 01-.22.18l-.07.055-.018.013a8.904 8.904 0 01-.194.146c-.029.02-.057.042-.086.063a7.7 7.7 0 01-.22.152l-.057.04a8.865 8.865 0 01-.293.185l-.062.037a10.424 10.424 0 01-.307.173l-.037.02-.196.103-.108.052-.012.006a6.196 6.196 0 01-.315.143c-.065.028-.13.054-.196.08l-.035.014-.086.034c-.07.026-.143.05-.215.075l-.039.014-.064.023a8.056 8.056 0 01-.323.097l-.63.173a7.285 7.285 0 01-.33.08l-.07.015c-.053.012-.104.023-.157.032l-.065.011-.085.015a2.332 2.332 0 01-.194.027l-.085.01a4.715 4.715 0 01-.16.018l-.034.003a4.861 4.861 0 01-.246.016h-.033a2.714 2.714 0 01-.155.005h-.106a3.384 3.384 0 01-.225-.007H4.86l-.15-.012-.066-.006a5.586 5.586 0 01-.187-.02l-.04-.005a5.14 5.14 0 01-.219-.035l-.054-.01a6.943 6.943 0 01-.347-.082l-.03-.008-.038-.01a5.034 5.034 0 01-.269-.086l-.063-.023a4.216 4.216 0 01-.188-.073l-.071-.031-.016-.007a4.959 4.959 0 01-.16-.074l-.026-.013a.164.164 0 00-.014-.007l-.671-.351.486.486h.016l8.995 4.742.093.048.03.014.02.01c.056.026.111.052.169.076l.016.008.073.032.195.076.022.008a.718.718 0 01.03.012l.014.004a4.693 4.693 0 00.323.1l.027.007c.073.02.147.038.22.055l.018.004.027.006.066.013.088.016c.075.014.15.026.226.038l.042.004c.064.009.128.016.193.022l.126.012.06.003.05.002.098.005c.046.002.094.002.14.003h.12c.05 0 .1-.002.161-.005h.033l.07-.004a6.17 6.17 0 00.184-.014l.033-.003a.753.753 0 00.058-.005l.108-.012.081-.01.08-.01.129-.021.082-.014.071-.012c.054-.01.107-.021.16-.033l.066-.013.059-.013c.096-.022.192-.046.287-.073l.63-.172a7.354 7.354 0 00.397-.122l.04-.015c.075-.025.149-.051.222-.078.032-.011.062-.024.093-.037l.03-.012c.067-.027.135-.054.2-.082l.128-.056.195-.09.021-.01.102-.05c.068-.034.135-.069.202-.105l.037-.02.073-.038c.08-.044.16-.092.24-.139l.026-.015a8.086 8.086 0 00.322-.2l.065-.045 1.98.902a1.748 1.748 0 002.472-1.59v-7.33l.004.004z', fill: 'currentColor' },
        { d: 'M11.617.576a3.904 3.904 0 00-.093-.047c-.016-.009-.033-.016-.05-.024a5.854 5.854 0 00-.166-.077l-.09-.04a4.094 4.094 0 00-.194-.074c-.017-.006-.035-.015-.053-.02l-.013-.005a5.18 5.18 0 00-.277-.088l-.07-.019a4.034 4.034 0 00-.219-.053c-.015-.003-.03-.008-.044-.012L10.253.1l-.057-.011a5.177 5.177 0 00-.225-.036L9.928.047a5.972 5.972 0 00-.191-.022L9.669.02a1.33 1.33 0 00-.058-.005L9.515.009a4.058 4.058 0 00-.111-.005C9.354 0 9.304 0 9.254 0h-.109c-.052 0-.106.004-.16.004L8.884.01A5.32 5.32 0 008.7.022l-.083.006h-.008c-.05.005-.1.013-.15.019l-.12.014c-.056.008-.112.018-.169.028-.037.006-.074.011-.11.018a7.054 7.054 0 00-.572.133l-.63.172c-.111.031-.22.064-.33.1-.037.011-.072.025-.108.037a12.91 12.91 0 00-.345.126c-.067.027-.133.054-.2.083l-.128.055a11.916 11.916 0 00-.318.15 7.376 7.376 0 00-.311.163c-.082.045-.16.092-.24.14a9.424 9.424 0 00-.35.218l-.016.01-.06.04a9.242 9.242 0 00-.51.37 12.54 12.54 0 00-.315.254l-.043.034-.01.007-.045.041c-.09.078-.18.158-.268.24l-.106.101c-.07.067-.139.135-.207.204l-.056.054-.063.067-.153.164-.12.133-.148.17c-.024.03-.049.057-.073.086l-.043.053a5.96 5.96 0 00-.123.155l-.118.151c-.04.053-.08.106-.118.16l-.075.101-.038.056-.107.155-.11.164a9.91 9.91 0 00-.168.265c-.012.02-.023.043-.037.063a12.43 12.43 0 00-.192.335l-.09.168c-.019.034-.04.07-.057.105-.011.022-.02.043-.032.065l-.092.188-.08.167a19.15 19.15 0 00-.083.192c-.017.038-.035.076-.05.115-.008.016-.014.034-.021.051-.035.083-.067.167-.1.253l-.051.134c-.04.11-.077.22-.113.33l-.02.057c0 .002 0 .005-.002.007l-.008.026c-.032.1-.06.2-.09.301l-.023.089c-.027.1-.052.2-.075.301l-.007.03a7.63 7.63 0 00-.057.267l-.008.048c-.015.074-.026.148-.038.223L.082 8.4c-.011.078-.02.156-.029.234-.006.051-.013.103-.017.154a6.57 6.57 0 00-.02.26c-.003.044-.007.086-.009.13-.004.128-.007.257-.007.386v4.056c0 1.478.42 2.741 1.138 3.692A4.75 4.75 0 002.73 18.67l9.015 4.753c-1.656-.874-2.728-2.685-2.73-5.051v-4.056c0-.13.004-.26.01-.39.002-.043.006-.085.01-.128.005-.088.01-.174.019-.261l.017-.155c.01-.077.018-.155.029-.234l.026-.164c.013-.074.025-.15.039-.223.02-.105.04-.21.064-.313l.008-.031c.023-.1.048-.201.075-.301l.023-.088c.028-.1.058-.202.09-.302l.008-.025.021-.063c.036-.11.073-.22.113-.33l.052-.134c.031-.085.065-.169.1-.253.022-.056.047-.111.07-.166a13.856 13.856 0 01.164-.358c.03-.063.06-.126.092-.188l.088-.172a9.22 9.22 0 01.187-.338l.096-.164c.034-.057.069-.112.104-.168l.1-.159a10.49 10.49 0 01.567-.786l.123-.155.116-.139c.05-.057.098-.115.148-.171a14.092 14.092 0 01.272-.297 9.706 9.706 0 01.432-.425c.088-.083.177-.163.268-.241l.054-.048a10.08 10.08 0 01.553-.435l.092-.068c.075-.053.15-.105.226-.156.019-.013.038-.028.06-.04a9.18 9.18 0 01.362-.227c.08-.047.16-.094.241-.139l.11-.058a7.643 7.643 0 01.521-.256l.126-.056a7.509 7.509 0 01.546-.208l.107-.037c.11-.036.22-.069.33-.1l.63-.172c.095-.026.191-.05.287-.072l.097-.02c.062-.014.125-.029.187-.04l.114-.018c.055-.01.11-.02.166-.028.04-.006.08-.01.12-.014.053-.007.105-.014.157-.019l.083-.006c.061-.005.123-.01.184-.013.034-.003.067-.003.101-.004l.16-.006h.11a3.187 3.187 0 01.261.008l.153.01.067.007c.064.006.128.013.192.022l.043.005a5.232 5.232 0 01.281.047l.141.03c.073.016.146.035.218.053l.07.019c.094.026.187.055.278.087l.067.025a4.326 4.326 0 01.449.19l.143.072L11.617.576z', fill: '#2ADB5C' },
      ],
      'zai': [
        { d: 'M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z' },
      ],
      'huaweicloud': [
        { d: 'M10.341 17.042s.062-.061 0-.061C7.516 10.902 3.646 6.22 3.646 6.22S1.557 8.168 1.68 10.174c.061 1.52 1.228 2.37 1.228 2.37 1.843 1.763 6.266 4.012 7.31 4.499h.123zm-.737 1.52c0-.061-.123-.061-.123-.061l-7.371.243c.798 1.398 2.15 2.492 3.563 2.188.983-.243 3.194-1.763 3.87-2.25.123-.12.061-.12.061-.12zm.123-.67c.062-.06 0-.12 0-.12C6.471 15.581.206 12.3.206 12.3c-.553 1.763.184 3.161.184 3.161.798 1.702 2.334 2.189 2.334 2.189.676.303 1.413.303 1.413.303h5.529c.061 0 .061-.06.061-.06zm.492-14.831c-.308 0-1.168.243-1.168.243-1.965.486-2.395 2.249-2.395 2.249-.369 1.094 0 2.31 0 2.31.675 2.857 3.87 7.598 4.545 8.57l.062.062c.061 0 .061-.061.061-.061C12.43 5.796 10.22 3.06 10.22 3.06zm2.457 13.373c.061 0 .123-.061.123-.061.737-1.033 3.87-5.714 4.545-8.57 0 0 .369-1.399 0-2.31 0 0-.491-1.764-2.457-2.25 0 0-.553-.121-1.167-.243 0 0-2.211 2.796-1.106 13.312 0 .122.062.122.062.122zm1.72 2.067s-.062 0-.062.06v.122c.738.486 2.826 2.006 3.87 2.249 0 0 1.905.669 3.563-2.188l-7.371-.243zm9.398-6.261s-6.265 3.343-9.521 5.531c0 0-.062.06-.062.122 0 0 0 .06.062.06h5.651s.553 0 1.29-.303c0 0 1.536-.487 2.396-2.25 0-.06.737-1.458.184-3.16zM13.66 17.042s.061.06.122 0c1.045-.547 5.468-2.736 7.31-4.499 0 0 1.168-.911 1.23-2.37.122-2.067-1.967-3.951-1.967-3.951s-3.87 4.559-6.695 10.698c0 0-.062.06 0 .122z', fill: '#C7000B' },
      ],
    };

    // 渐变 defs：与 BRAND_PATHS 里 url(#amv-grad-*) 一一对应，只有用到该图标的
    // SVG 实例才会挂载自己的 defs（放在 <svg> 内部，id 不会跨实例泄漏）。
    const BRAND_DEFS = {
      gemini: [
        h('linearGradient', { key: 'g0', id: 'amv-grad-g0', gradientUnits: 'userSpaceOnUse', x1: 7, x2: 11, y1: 15.5, y2: 12 },
          h('stop', { key: 'a', stopColor: '#08B962' }),
          h('stop', { key: 'b', offset: 1, stopColor: '#08B962', stopOpacity: 0 }),
        ),
        h('linearGradient', { key: 'g1', id: 'amv-grad-g1', gradientUnits: 'userSpaceOnUse', x1: 8, x2: 11.5, y1: 5.5, y2: 11 },
          h('stop', { key: 'a', stopColor: '#F94543' }),
          h('stop', { key: 'b', offset: 1, stopColor: '#F94543', stopOpacity: 0 }),
        ),
        h('linearGradient', { key: 'g2', id: 'amv-grad-g2', gradientUnits: 'userSpaceOnUse', x1: 3.5, x2: 17.5, y1: 13.5, y2: 12 },
          h('stop', { key: 'a', stopColor: '#FABC12' }),
          h('stop', { key: 'b', offset: 0.46, stopColor: '#FABC12', stopOpacity: 0 }),
        ),
      ],
      codebuddy: [
        h('radialGradient', { key: 'cb', id: 'amv-grad-cb', cx: 0, cy: 0, r: 1, gradientUnits: 'userSpaceOnUse', gradientTransform: 'matrix(-9.00009 -16 16 -9.00009 21 24.5)' },
          h('stop', { key: 'a', stopColor: '#2EA99D' }),
          h('stop', { key: 'b', offset: 1, stopColor: '#6C4DFF' }),
        ),
      ],
    };

    // lobe-icons 的 slug 命名是品牌名；同一品牌多个工具变体共用一个图标。
    // 键 = 工具 id（与 index.js 注册表对齐）；值 = BRAND_PATHS 键。
    // 清单外的工具（无映射）由 BrandIcon 用「品牌色 + 工具名首字母」占位。
    const TOOL_BRAND = {
      'claude-code': 'claude',
      'codex': 'openai',
      'gemini-cli': 'gemini',
      'cursor': 'cursor',
      'trae': 'trae',
      'trae-cn': 'trae',
      'codebuddy': 'codebuddy',
      'codebuddy-cn': 'codebuddy',
      'workbuddy': 'workbuddy',
      'opencode': 'opencode',
      'windsurf': 'windsurf',
      'cline': 'cline',
      'copilot': 'githubcopilot',
      'kiro': 'kiro',
      'qoder': 'qoder',
      'qoder-cn': 'qoder',
      'qoderwork': 'qoder',
      'roo': 'roocode',
      'zcode': 'zai',
      'codearts-doer': 'huaweicloud',
    };

    // 字母占位的底色（取各品牌官方主色或常见识别色；与 mono 图标互不冲突）
    const BRAND_LETTER_COLORS = {
      'augment': '#F8483D',   // Augment 官方红
      'catpaw': '#FFC300',    // 美团黄
      'joycode': '#B33AFC',   // 京东紫
      'zcode': '#3B82F6',     // 蓝
      'autoclaw': '#10B981',  // 绿（开源工具）
      'hanako': '#EC4899',    // 粉
      'qoderwork': '#14B8A6', // 阿里系青
    };

    /** 品牌色 + 工具名首字母的占位图标（lobehub Avatar 风格）。 */
    function BrandLetter(toolName, size) {
      const ch = String(toolName || '?').trim().charAt(0).toUpperCase() || '?';
      const id = String(toolName || '').toLowerCase();
      const color = BRAND_LETTER_COLORS[id] || '#6b7280';
      return h(
        'span',
        {
          className: 'amv-brand-letter',
          style: {
            width: size || 14,
            height: size || 14,
            fontSize: Math.round((size || 14) * 0.62),
            lineHeight: (size || 14) + 'px',
            background: color,
          },
          'aria-hidden': 'true',
        },
        ch,
      );
    }

    /** 渲染一个工具的品牌图标；清单外的工具用品牌色字母占位。 */
    function BrandIcon(toolId, size, cls, toolName) {
      const brand = TOOL_BRAND[toolId];
      const paths = brand ? BRAND_PATHS[brand] : null;
      if (!paths) return BrandLetter(toolName || toolId, size);
      return h(
        'svg',
        {
          className: 'amv-icon' + (cls ? ' ' + cls : ''),
          width: size || 14,
          height: size || 14,
          viewBox: '0 0 24 24',
          // mono 变体根 svg 原文件带 fill="currentColor"（跟随主题色）；
          // 彩色变体路径自带品牌 fill，根上的 currentColor 不影响它们。
          fill: 'currentColor',
          // inline-svg 默认按基线排布会与文字错位；block 显示保证与相邻文字垂直居中
          display: 'block',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { flex: 'none', lineHeight: 1 },
        },
        brand && BRAND_DEFS[brand] ? h('defs', null, BRAND_DEFS[brand]) : null,
        paths.map((p, i) => h('path', { key: i, ...p })),
      );
    }

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
      // 第三方内部的子Tab：选中工具 id（'__custom__' = 自定义工具面板）
      const [thirdTab, setThirdTab] = useState(null);
      // 详情面板全屏态（编辑器 / 预览共用）：true 时渲染 fixed 覆盖层
      const [fullscreen, setFullscreen] = useState(false);
      // 全屏对比窗：null = 单文件全屏；非 null = 右侧展示该 key 的文件（双列并列）
      const [cmpKey, setCmpKey] = useState(null);
      const [cmpDoc, setCmpDoc] = useState(null); // 右侧 /read 结果 { content }
      const [cmpState, setCmpState] = useState(''); // '' | 'loading' | 'ready' | 'error'
      const [cmpErr, setCmpErr] = useState('');

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

      // 全屏态下按 Esc 退出；换文件 / 换 Tab 时随重置逻辑一并退出（resetSelection 里）。
      // capture 阶段 + stopPropagation：宿主设置模态的 Esc（关整个设置页）挂在 document
      // 冒泡阶段（useModalLayer），capture 拦截后它收不到 —— Esc 只退出全屏、不关设置页。
      // preventDefault 同时挡掉 shortcuts 系统的 dismiss 命令等其它全局 Esc 消费者。
      useEffect(() => {
        if (!fullscreen) return undefined;
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setFullscreen(false);
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [fullscreen]);

      // 全屏容器钉进设置面板矩形：面板是居中的 800×800（窄屏时收缩），每次打开
      // 全屏与窗口尺寸变化时实测一次 —— 「放大」的上限就是设置页本身。
      // 兜底：找不到设置面板元素时退回视口 inset 16px（不应发生，但宁可可用）。
      // 对比态例外：双列并列需要横向空间，CSS 里 !important 加宽到视口 92%，
      // 这里的内联矩形只作为单文件全屏的基准。
      const [fsRect, setFsRect] = useState(null);
      useEffect(() => {
        if (!fullscreen) {
          setFsRect(null);
          return undefined;
        }
        const measure = () => {
          const host = document.querySelector('[data-shortcut-modal="settings"]');
          const r = host ? host.getBoundingClientRect() : null;
          if (r && r.width > 0 && r.height > 0) {
            setFsRect({ left: r.left, top: r.top, width: r.width, height: r.height });
          } else {
            setFsRect({ left: 16, top: 16, width: window.innerWidth - 32, height: window.innerHeight - 32 });
          }
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
      }, [fullscreen]);

      // 对比窗右侧文件：候选集合 = 清单里所有 exists 的文件（跨 Tab），排除当前文件。
      // 只发 key —— 路径解析仍由 Host 完成（契约 §3）。
      const cmpCandidates = useMemo(() => {
        if (!state) return [];
        const out = [];
        for (const e of (state.globals || []).concat(state.project || [])) {
          if (e && e.exists && e.key !== selKey) out.push(e);
        }
        for (const tool of state.thirdParty || []) {
          for (const e of (tool && tool.files) || []) {
            if (e && e.exists && e.key !== selKey) out.push(e);
          }
        }
        return out;
      }, [state, selKey]);

      // cmpKey 变化时读右侧文件；复用 /read（右侧只读，不参与乐观并发）
      useEffect(() => {
        if (!fullscreen || !cmpKey) return undefined;
        let alive = true;
        setCmpState('loading');
        setCmpErr('');
        apiGet('/read' + qs({ key: cmpKey }))
          .then((json) => {
            if (!alive) return;
            setCmpDoc(json);
            setCmpState('ready');
          })
          .catch((e) => {
            if (!alive) return;
            setCmpDoc(null);
            setCmpState('error');
            setCmpErr(t('compareReadFail').replace('{msg}', errText(e)));
          });
        return () => {
          alive = false;
        };
        // qs 随 ws 变化，但 cmpKey 变化必然伴随重新请求；ws 在会话内极少变
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [fullscreen, cmpKey]);

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
        setFullscreen(false); // 换文件必然换内容，全屏覆盖层随之关闭
        setCmpKey(null); // 对比目标随当前文件一起失效
        setCmpDoc(null);
        setCmpState('');
        setCmpErr('');
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
              setConflict(true); // 契约 §3.4：409 STALE → 给「覆盖 / 重新读取」
              return;
            }
            setErr({ text: t('errSave').replace('{msg}', errText(e)) });
          } finally {
            if (ticket === readSeq.current) setBusy('');
          }
        },
        [selKey, ws, t, loadState],
      );

      // 在系统文件资源管理器里定位当前文件（只发 key，路径由 Host 从允许集合解析）。
      // revealBusy 做在途去重：/reveal 内部有 powershell 窗口探测（约 0.7s），
      // 连点会叠出多个资源管理器窗口与探测进程 —— 在途时忽略后续点击。
      const revealBusy = useRef(false);
      const reveal = useCallback(
        async (key) => {
          if (!key || revealBusy.current) return;
          revealBusy.current = true;
          try {
            await apiPost('/reveal', { workspaceId: ws, key });
          } catch (e) {
            setErr({ text: t('revealFail').replace('{msg}', errText(e)) });
          } finally {
            revealBusy.current = false;
          }
        },
        [ws, t],
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

      // 编辑器 Ctrl/Cmd+S：挂在 textarea 上（CodeEditor 的 onKeyDown 透传）
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
            target.exists
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'amv-icon-btn',
                    title: t('reveal'),
                    'aria-label': t('reveal'),
                    onClick: (e) => {
                      e.stopPropagation(); // 不触发卡片的选中/展开
                      reveal(target.key);
                    },
                  },
                  IconReveal(13),
                )
              : null,
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

      // ── 面板：第三方 ──────────────────────────────────────────────────────
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
              BrandIcon(tool.id, 13, null, tool.name),
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
              BrandIcon(tool.id, 15, null, tool.name),
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
            { className: 'amv-editor' },
            // 行号条 + 语法着色 + 透明 textarea 的双层编辑器（CodeEditor）
            h(CodeEditor, {
              value: draft,
              lines: lineCount(draft),
              label: t('editorLabel'),
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: onEditorKeyDown,
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
              h(
                'div',
                { className: 'amv-meta-path-row' },
                h('div', { className: 'amv-meta-path' }, entry.displayPath),
                // 定位文件：只在文件真实存在时提供（「未创建」的候选没有可定位的实体）
                entry.exists
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'amv-icon-btn',
                        title: t('reveal'),
                        'aria-label': t('reveal'),
                        onClick: () => reveal(entry.key),
                      },
                      IconReveal(13),
                    )
                  : null,
              ),
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
              // 全屏：只在有实际内容区（编辑器 / 预览）时提供；「未创建」空态没有意义
              docState === 'ready'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'amv-btn amv-fs-btn',
                      title: t('fullscreenHint'),
                      'aria-label': t('fullscreen'),
                      onClick: () => setFullscreen(true),
                    },
                    IconExpand(13),
                    t('fullscreen'),
                  )
                : null,
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
          // 全屏时底层不再渲染 body：覆盖层渲染的是同一棵受控树（同 state 源），
          // 底层留一份会造成「同一文件内容在 DOM 里出现两份」（屏幕阅读器读两遍、
          // Ctrl+F 页内搜索命中两处），折叠成 null 更干净。
          fullscreen && docState === 'ready' ? null : body,
          // 全屏覆盖层：把 body 的内容区放大到设置面板允许的最大范围（内容容器
          // 实测设置面板矩形后钉进去，见 fsRect）；fixed 遮罩层负责拦截底层交互。
          // Esc 由全局 capture 监听处理（退出全屏而不关设置页）。
          // 对比态：cmpKey 非空时双列并列展示（左=当前文件可编辑，右=对比文件只读），
          // 面板加宽到视口 92%（CSS data-wide）；关掉对比回单列，尺寸与原全屏一致。
          fullscreen && docState === 'ready'
            ? h(
                'div',
                { className: 'amv-fs', role: 'dialog', 'aria-modal': 'true', 'aria-label': entry.displayPath },
                h(
                  'div',
                  {
                    className: 'amv-fs-panel',
                    'data-wide': cmpKey ? 'true' : 'false',
                    style: fsRect
                      ? { left: fsRect.left, top: fsRect.top, width: fsRect.width, height: fsRect.height }
                      : { left: 16, top: 16, width: 'calc(100vw - 32px)', height: 'calc(100vh - 32px)' },
                  },
                  h(
                    'div',
                    { className: 'amv-fs-bar' },
                    IconFile(14, 'amv-icon-brand'),
                    h('span', { className: 'amv-fs-title', title: entry.displayPath }, entry.displayPath),
                    // 对比开关：候选至少 1 个才可用；开着时按钮变成「关闭对比」
                    cmpCandidates.length
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'amv-btn',
                            title: cmpKey ? t('compareClose') : t('compareHint'),
                            'aria-pressed': cmpKey ? 'true' : 'false',
                            onClick: () => {
                              if (cmpKey) {
                                setCmpKey(null);
                                setCmpDoc(null);
                                setCmpState('');
                                setCmpErr('');
                              } else {
                                // 默认目标：有共用文件先选第一份，否则选清单里第一个候选
                                const shared = entry && entry.sharedWith && entry.sharedWith.length
                                  ? cmpCandidates.find((c) => entry.sharedWith.some((n) => n.endsWith('/' + c.name)))
                                  : null;
                                setCmpKey(shared ? shared.key : cmpCandidates[0].key);
                              }
                            },
                          },
                          IconExpand(13),
                          cmpKey ? t('compareClose') : t('compare'),
                        )
                      : null,
                    h('div', { className: 'amv-spacer' }),
                    modeSwitch,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'amv-btn',
                        title: t('fullscreenExit'),
                        'aria-label': t('fullscreenExit'),
                        onClick: () => setFullscreen(false),
                      },
                      IconCollapse(13),
                      t('fullscreenExit'),
                    ),
                  ),
                  cmpKey
                    ? h(
                        'div',
                        { className: 'amv-fs-cmp' },
                        // 左：当前文件（完整编辑器 / 预览，与单文件全屏同一棵受控树）
                        h(
                          'div',
                          { className: 'amv-fs-pane' },
                          h(
                            'div',
                            { className: 'amv-fs-pane-hd' },
                            h('span', { className: 'amv-badge amv-badge-plain' }, t('compareLeft')),
                            h('span', { className: 'amv-fs-pane-path', title: entry.displayPath }, entry.displayPath),
                            h('span', { className: 'amv-badge amv-badge-plain' }, t('compareOnlyEdit')),
                          ),
                          h('div', { className: 'amv-fs-pane-bd' }, body),
                        ),
                        // 右：对比文件（只读）。头部给切换下拉（全部 exists 候选）
                        h(
                          'div',
                          { className: 'amv-fs-pane' },
                          h(
                            'div',
                            { className: 'amv-fs-pane-hd' },
                            h('span', { className: 'amv-badge amv-badge-plain' }, t('compareRight')),
                            (() => {
                              const sel = cmpCandidates.find((c) => c.key === cmpKey);
                              return h(
                                'span',
                                { className: 'amv-fs-pane-path', title: sel ? sel.displayPath : '' },
                                sel ? sel.displayPath : '',
                              );
                            })(),
                            h(
                              'select',
                              {
                                className: 'amv-select',
                                style: { height: 24, fontSize: 11.5, minWidth: 0, maxWidth: 200, flexShrink: 1 },
                                value: cmpKey,
                                'aria-label': t('compareWith'),
                                onChange: (e) => setCmpKey(e.target.value),
                              },
                              cmpCandidates.map((c) => h('option', { key: c.key, value: c.key }, c.displayPath)),
                            ),
                          ),
                          h(
                            'div',
                            { className: 'amv-fs-pane-bd' },
                            cmpState === 'loading'
                              ? loadingRow(t('compareLoading'))
                              : cmpState === 'error'
                                ? h('div', { className: 'amv-banner amv-banner-err', style: { margin: 10 } }, h('span', { className: 'amv-banner-txt' }, cmpErr))
                                : cmpDoc && typeof cmpDoc.content === 'string'
                                  ? h('pre', { className: 'amv-preview amv-cmp-src' }, cmpDoc.content)
                                  : null,
                          ),
                        ),
                      )
                    : h('div', { className: 'amv-fs-body' }, body),
                ),
              )
            : null,
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

      // 设置导航行的「规则」图标（DSH 0.2.2+ 提供该槽）。
      // slots.inject 对未声明的槽是等待语义：旧版宿主上 thunk（延迟求值回调）挂起不安装、不报错；
      // 升级后声明出现即自动安装 —— 渐进增强，无需版本探测。
      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register(
          { name: 'settings.section.icon', id: 'agents-md', label: 'agents-md icon' },
          // props: { size, active }，见 ui-settings SettingsSectionIconOwnerProps
          (props) =>
            h(
              'span',
              { style: { display: 'inline-flex', color: props && props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' } },
              IconRules(props && props.size ? props.size : 16),
            ),
        ),
      );
    }

    return { inject, apply };
  },
});
