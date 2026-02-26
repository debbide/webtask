# WebTask v2 升级计划

两大功能：**动态任务导入** + **完整 JS 脚本支持**

## 任务支持两种模式

### 模式一：声明式 JSON（简单场景）
```json
{
  "name": "minestrator_restart",
  "label": "Minestrator 重启",
  "url": "https://minestrator.com/my/server/{serverId}",
  "defaultData": {"serverId": "421301"},
  "steps": [
    {"action": "wait", "ms": 5000},
    {"action": "click", "selector": "button[class*='bg-info']"},
    {"action": "getText", "selector": "[class*='ring-warning']", "as": "timer"},
    {"action": "assert", "variable": "timer", "contains": "3h 5"}
  ]
}
```

### 模式二：JS 脚本（复杂场景）
```json
{
  "name": "complex_task",
  "label": "复杂任务",
  "url": "https://example.com",
  "defaultData": {},
  "script": "async function(ctx) {\n  // ctx.query(selector) 查找元素\n  // ctx.click(selector) 点击\n  // ctx.getText(selector) 读取文本\n  // ctx.type(selector, text) 输入\n  // ctx.wait(ms) 等待\n  // ctx.waitFor(selector, timeout) 等待元素\n  // ctx.reload() 刷新\n  // ctx.log(msg) 记录日志\n  // ctx.data 外部传入的数据\n\n  await ctx.wait(3000);\n  const items = document.querySelectorAll('.item');\n  for (const item of items) {\n    item.click();\n    await ctx.wait(1000);\n  }\n  const result = ctx.getText('.result');\n  if (result.includes('成功')) {\n    return { success: true, message: result };\n  }\n  return { success: false, message: '失败', keepOpen: true };\n}"
}
```

### 混合模式（步骤中嵌入 JS）
```json
{
  "steps": [
    {"action": "wait", "ms": 3000},
    {"action": "click", "selector": "#login-btn"},
    {"action": "script", "code": "const code = document.querySelector('.code').textContent; return code.replace(/\\s/g, '');", "as": "verifyCode"},
    {"action": "assert", "variable": "verifyCode", "contains": "OK"}
  ]
}
```

## DOM 引擎完整操作表

| action | 参数 | 说明 |
|--------|------|------|
| `wait` | `ms` | 等待毫秒 |
| `click` | `selector` | 点击元素 |
| `getText` | `selector`, `as` | 读取文本存变量 |
| `type` | `selector`, `text` | 输入文本 |
| `waitFor` | `selector`, `timeout` | 等待元素出现 |
| `reload` | — | 刷新页面 |
| `assert` | `variable`, `contains`, `failMsg` | 断言检查 |
| **`script`** | **`code`, `as`** | **执行 JS 代码，结果存变量** |

## Proposed Changes

### [MODIFY] [manifest.json](file:///e:/ck/leme-bot/webtask-ext/manifest.json)
- 移除 `background.scripts` 中 `tasks/*.js`
- 移除 `content_scripts` 全局注入（改为按需注入）
- 添加 `browser_specific_settings`

### [MODIFY] [background.js](file:///e:/ck/leme-bot/webtask-ext/background.js)
- 任务从 `storage.local.tasks` 读取（替代静态 `TASK_MAP`）
- 新消息：`importTask`（校验+存储）、`deleteTask`（删除）
- `onInstalled` 写入默认 minestrator 任务
- `runJobSteps` 中用 `tabs.executeScript` 按需注入 content.js
- 任务有 `script` 字段时，传整段脚本给 content.js 执行

### [MODIFY] [content.js](file:///e:/ck/leme-bot/webtask-ext/content.js)
- `script` action：用 `new Function()` 执行用户 JS，提供 `ctx` 上下文
- 完整脚本模式：收到 `runScript` 类型消息时执行整段 JS
- `ctx` 对象封装：`click/getText/type/wait/waitFor/reload/log/data/query`

### [MODIFY] [popup.html](file:///e:/ck/leme-bot/webtask-ext/popup.html)
- Tasks 面板增加 "+ Import" 按钮
- 导入弹窗：`<textarea>` + Import/Cancel 按钮
- 每个任务增加 "×" 删除按钮

### [MODIFY] [popup.js](file:///e:/ck/leme-bot/webtask-ext/popup.js)
- 导入：校验 JSON → `importTask` 消息
- 删除：确认 → `deleteTask` 消息
- 手动触发用 `defaultData` 预填
- JSON 校验：必须有 name/url，且有 steps 或 script

### [MODIFY] [popup.css](file:///e:/ck/leme-bot/webtask-ext/popup.css)
- 导入弹窗（overlay + modal）样式
- 删除按钮样式
- 成功/失败日志颜色标识

### [DELETE] [tasks/index.js](file:///e:/ck/leme-bot/webtask-ext/tasks/index.js)
### [DELETE] [tasks/minestrator.js](file:///e:/ck/leme-bot/webtask-ext/tasks/minestrator.js)

## JSON 导入校验

- ✅ `name` 非空字符串
- ✅ `url` 非空字符串
- ✅ 有 `steps`（数组）或 `script`（字符串），至少一个
- ✅ `steps` 中每项有 `action`
- ⚠️ `name` 重复时提示"覆盖？"

## Verification Plan

1. 导入声明式 JSON 任务 → 出现在列表 → 手动触发 → 全流程正常
2. 导入 JS 脚本任务 → 手动触发 → JS 执行正确
3. 导入混合模式（steps + script action）→ 执行正确
4. 删除任务 → 消失 → 重启插件 → 仍然消失
5. 格式错误 JSON → 提示错误
6. 重启插件 → 所有任务保留
