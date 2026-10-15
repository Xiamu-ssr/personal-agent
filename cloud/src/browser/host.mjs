import { startBrowserHost } from "./service-host.mjs";

try {
  const host = await startBrowserHost({ root: process.env.AGENT_ROOT || "/srv/agent" });
  const finish = () => host.close().catch(() => { process.exitCode = 1; });
  process.once("SIGTERM", finish); process.once("SIGINT", finish);
} catch {
  console.error("独立浏览器 host 启动失败，请检查目录权限和 loopback 监听");
  process.exitCode = 1;
}
