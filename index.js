/**
 * dsh-shutdown-hook — 统一退出屏障插件
 *
 * 职责：
 *  - 唯一 SIGTERM/SIGINT 拦截点（dsh 自身未注册信号 handler，插件可安全接管）
 *  - 提供 `shutdownHook` 服务：其他插件注册"退出前检查"（drain/flush/落盘）
 *  - 收到信号 → 并行执行所有检查（各自超时 + 全局兜底）→ 全部完成 → process.exit(0)
 *
 * 为什么需要：
 *  agent 回复经 imessage 等渠道异步投递，进程被杀时未完成的投递直接丢失
 *  （Web 会话可见但 iMessage 收不到）。由本插件在进程层强制"退出前等投递完成"，
 *  不依赖模型自觉调用工具、不依赖 agent 纪律。
 *
 * 用法（其他插件）：
 *   export const inject = ["shutdownHook"];
 *   ctx.shutdownHook.register("imessage-drain", async () => { await core.drain(); }, { timeoutMs: 5000 });
 *
 * 边界：
 *  - SIGKILL（kill -9）/ 进程崩溃：无法保证（进程直接死，任何方案都保证不了）
 *  - 检查超时：默认 5s/个，全局 10s 兜底，超时强制退出
 *  - 幂等：多次信号只执行一次
 */

export const name = "dsh-shutdown-hook";
export const inject = [];

const DEFAULT_TIMEOUT_MS = 5000;
const GLOBAL_TIMEOUT_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function apply(ctx) {
  const Logger = ctx.logger;
  // 本地时间戳（时区跟随系统，Asia/Shanghai +08）。dsh 无自动加时间的 logger，
  // 惯例是插件自己格式化（同 dsh-imessage 的 ts() 模式）。
  const ts = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const log = {
    info: (m) => { console.log(`[${ts()}] [sh] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[${ts()}] [sh:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[${ts()}] [sh:err] ${m}`); try { Logger?.error?.(m); } catch {} },
  };

  /** 退出前检查注册表：name -> { fn, timeoutMs } */
  const checks = new Map();

  // 注册服务：其他插件 inject "shutdownHook" 后可用（cordis 保证本插件先加载）
  ctx.provide("shutdownHook", {
    /**
     * 注册一个退出前检查。
     * @param {string} name 检查名（日志标识）
     * @param {() => Promise<void>} fn 检查函数，进程退出前必须完成的工作
     * @param {{ timeoutMs?: number }} [opts] 超时（默认 5000ms）
     */
    register(name, fn, opts = {}) {
      if (typeof fn !== "function") throw new TypeError("shutdownHook.register: fn 必须是函数");
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      checks.set(name, { fn, timeoutMs });
      log.info(`已注册退出前检查: ${name}（超时 ${timeoutMs}ms）`);
    },
    /** 注销一个退出前检查。 */
    unregister(name) {
      if (checks.delete(name)) log.info(`已注销退出前检查: ${name}`);
    },
    /** 当前已注册的检查名列表。 */
    list() {
      return [...checks.keys()];
    },
  });

  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return; // 幂等：多次信号只执行一次
    shuttingDown = true;
    log.info(`收到 ${signal}，执行 ${checks.size} 个退出前检查...`);
    const started = Date.now();

    const results = await Promise.allSettled(
      [...checks.entries()].map(([name, c]) =>
        Promise.race([
          (async () => {
            const t = Date.now();
            await c.fn();
            return { name, ms: Date.now() - t, timedOut: false };
          })(),
          sleep(c.timeoutMs).then(() => ({ name, ms: c.timeoutMs, timedOut: true })),
        ])
      )
    );

    let ok = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        const v = r.value;
        if (v.timedOut) {
          log.warn(`检查超时: ${v.name}（>${v.ms}ms，强制继续）`);
        } else {
          ok++;
          log.info(`检查完成: ${v.name}（${v.ms}ms）`);
        }
      } else {
        log.warn(`检查失败: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    }
    log.info(`退出前检查完成 ${ok}/${results.length}，总耗时 ${Date.now() - started}ms，退出`);
    process.exit(0);
  };

  const onSigterm = () => { void shutdown("SIGTERM"); };
  const onSigint = () => { void shutdown("SIGINT"); };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  // 启动时报告（可观测：确认拦截点已接管）
  log.info(`dsh-shutdown-hook 已启动（SIGTERM/SIGINT 拦截，当前 ${checks.size} 个检查）`);

  // 插件卸载时移除 handler，避免重复注册
  ctx.on("dispose", () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    log.info("dsh-shutdown-hook 已卸载，信号 handler 已移除");
  });
}
