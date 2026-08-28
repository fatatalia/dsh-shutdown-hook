# dsh-shutdown-hook

dsh 统一退出屏障插件：**唯一 SIGTERM/SIGINT 拦截点**，其他插件注册"退出前检查"（drain / flush / 落盘），进程退出时统一并行调度，全部完成才 `process.exit(0)`。

## 解决的问题

dsh 中 agent 回复经 iMessage 等渠道是**异步投递**的（`assistant/message` 事件 → 排队 → imsg 子进程）。进程被杀（重启 / 停止）时，未完成的投递直接丢失——表现为 Web 会话可见消息，但 iMessage 收不到。

本插件在**进程层强制**"退出前等投递完成"：由插件统一拦截信号并调度检查，**不依赖模型自觉调用工具、不依赖 agent 纪律**。

## 工作原理

```
launchctl kickstart / stop / Ctrl+C
        │  SIGTERM / SIGINT
        ▼
┌─────────────────────────────────────────┐
│  dsh-shutdown-hook（唯一信号拦截点）       │
│  ┌─────────────────────────────────────┐ │
│  │ 检查注册表: name → { fn, timeoutMs }│ │
│  │  imessage-drain ← dsh-imessage 注册 │ │
│  │  xxx-flush       ← 未来插件注册     │ │
│  └─────────────────────────────────────┘ │
│  并行执行所有检查（各自超时 + 全局兜底）   │
│  记录耗时/超时/失败 → process.exit(0)     │
└─────────────────────────────────────────┘
```

## 用法（其他插件）

**硬依赖模式**（服务必在，shutdown-hook 缺失时插件不激活）：

```js
export const inject = ["shutdownHook"];  // cordis 保证本插件先加载

ctx.shutdownHook.register("imessage-drain", async () => {
  await core.drain();  // 等投递链清空
}, { timeoutMs: 5000 });
```

**软依赖模式**（推荐：独立插件不强绑，服务缺失时优雅降级，延迟加载/重载自动补注册）：

```js
// 不要 inject "shutdownHook"
let registered = false;
const register = (barrier) => {
  if (registered || !barrier) return;
  barrier.register("imessage-drain", async () => { await core.drain(); }, { timeoutMs: 5000 });
  registered = true;
};
register(ctx.get("shutdownHook"));  // 立即尝试（可能尚未加载）
ctx.on("internal/service", (name, value) => {  // 服务出现/注销事件
  if (name !== "shutdownHook") return;
  if (value) register(value);
  else registered = false;
});
```

服务 API：

| 方法 | 说明 |
|---|---|
| `register(name, fn, { timeoutMs })` | 注册退出前检查（超时默认 5000ms） |
| `unregister(name)` | 注销检查 |
| `list()` | 当前已注册的检查名列表 |

## 调度逻辑

```
收到 SIGTERM/SIGINT
  → 幂等检查（多次信号只执行一次）
  → 并行执行所有检查（Promise.allSettled，互不阻塞）
  → 每个检查独立超时（默认 5s），全局 10s 兜底
  → 记录每个检查的耗时/超时/失败（[sh] 日志）
  → process.exit(0)
```

## 边界

- **SIGKILL（kill -9）/ 进程崩溃**：无法保证（进程直接死，任何方案都保证不了）
- **检查超时**：超时强制继续退出，避免进程悬挂
- **dsh 未来版本**：若 dsh 核心自己注册 SIGTERM handler 并立即退出，本插件拦截会失效（当前 dsh 版本无）

## 已注册检查

| 插件 | 检查名 | 作用 |
|---|---|---|
| dsh-imessage | `imessage-drain` | 等 iMessage 投递链清空（重启不丢消息） |

## 实战验证

- 2026-08-28：两次 `launchctl kickstart -k` 重启均被拦截，`imessage-drain` 正常执行，重启前消息完整送达，新进程 2 秒内恢复。

## 日志示例

```
[2026-08-28 16:21:27] [sh] 收到 SIGTERM，执行 1 个退出前检查...
[2026-08-28 16:21:27] [sh] 检查完成: imessage-drain（17ms）
[2026-08-28 16:21:27] [sh] 退出前检查完成 1/1，总耗时 85ms，退出
```
