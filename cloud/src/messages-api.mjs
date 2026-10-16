import http from "node:http";
import https from "node:https";
import tls from "node:tls";

function proxyFor(url, env) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return null;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if ((env.NO_PROXY || env.no_proxy || "").split(",").some((entry) => {
    const [name, wantedPort] = entry.trim().toLowerCase().split(":");
    const domain = name.replace(/^\*?\./, "");
    return name && (!wantedPort || wantedPort === port) && (name === "*" || host === domain || host.endsWith("." + domain));
  })) return null;
  const value = (url.protocol === "https:" ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy) || env.ALL_PROXY || env.all_proxy;
  if (!value) return null;
  const proxy = new URL(value);
  if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("模型服务代理仅支持 HTTP 或 HTTPS");
  return proxy;
}

// Small non-streaming Messages calls share the CLI's proxy environment, without rewriting requests.
export function messagesRequest(url, options, env = process.env) {
  return new Promise((resolve, reject) => {
    const target = new URL(url), proxy = proxyFor(target, env), headers = { ...options.headers };
    let destination = target, agent;
    const requestOptions = { method: options.method, headers, signal: options.signal };
    const proxyHeaders = proxy?.username ? { "proxy-authorization": "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64") } : {};
    if (proxy) { proxy.username = ""; proxy.password = ""; }
    if (proxy && target.protocol === "http:") {
      destination = proxy;
      requestOptions.path = target.href;
      Object.assign(headers, proxyHeaders, { host: target.host });
    } else if (proxy) {
      agent = new https.Agent();
      agent.createConnection = (_options, callback) => {
        let completed = false;
        const done = (error, socket) => { if (!completed) { completed = true; callback(error, socket); } };
        const connect = (proxy.protocol === "https:" ? https : http).request(proxy, { method: "CONNECT", path: target.host.includes(":") ? target.host : target.host + ":443", headers: { host: target.host, ...proxyHeaders }, signal: options.signal });
        connect.on("connect", (response, socket, head) => {
          if (response.statusCode !== 200) { socket.destroy(); done(new Error("模型服务代理连接失败")); return; }
          if (head.length) socket.unshift(head);
          const secure = tls.connect({ socket, servername: target.hostname });
          secure.once("secureConnect", () => done(null, secure)); secure.once("error", done);
        });
        connect.once("error", done); connect.end();
      };
      requestOptions.agent = agent;
    }
    const request = (destination.protocol === "https:" ? https : http).request(destination, requestOptions, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) response.destroy(new Error("模型服务响应过大")); else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.once("error", reject); request.once("close", () => agent?.destroy());
    request.end(options.body);
  });
}
