# dsh-shutdown-hook

dsh 统一退出屏障插件：**唯一 SIGTERM/SIGINT 拦截点**，其他插件注册"退出前检查"，退出时统一并行调度，全部完成才 `process.exit(0)`。

## 解决的问题

agent 回复经 iMessage 等渠道是**异步投递**的（`assistant/message` 事件 → 排队 → imsg 子进程）。进程被杀（重启/停止）时，未完成的投递直接丢失——Web 会话可见但 iMessage 收不到。

本插件在**进程层强制**"退出前等投递完成"，不依赖模型自觉调用工具、不依赖 agent 纪律。

## 用法（其他插件）

```js
export const inject = ["shutdownHook"];  // cordis 保证本插件先加载

ctx.shutdownHook.register("imessage-drain", async () => {
  await core.drain();  // 等投递链清空
}, { timeoutMs: 5000 });
```

## 调度逻辑

```
收到 SIGTERM/SIGINT
  → 幂等检查（多次信号只执行一次）
  → 并行执行所有注册的检查（Promise.allSettled）
  → 每个检查独立超时（默认 5s）
  → 记录每个检查的耗时/超时/失败（[sh] 日志）
  → process.exit(0)
```

## 边界

- **SIGKILL（kill -9）/ 进程崩溃**：无法保证（进程直接死，任何方案都保证不了）
- **检查超时**：默认 5s/个，全局 10s 兜底，超时强制退出
- **dsh 未来版本**：若 dsh 自己注册 SIGTERM handler 并立即退出，本插件拦截会失效（当前版本无）

## 已注册检查

| 插件 | 检查名 | 作用 |
|---|---|---|
| dsh-imessage | `imessage-drain` | 等 iMessage 投递链清空（重启不丢消息） |
