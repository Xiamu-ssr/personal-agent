import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const cases = [
  { name: "DNS endpoint keeps SNI and TLS validation", host: "models.example.test", san: "DNS:models.example.test", servername: "models.example.test" },
  { name: "IPv4 endpoint validates its IP certificate without SNI", host: "198.51.100.42", san: "IP:198.51.100.42", servername: false },
  { name: "IP endpoint rejects a trusted certificate for a different identity", host: "198.51.100.42", san: "DNS:models.example.test", rejected: true },
  { name: "synchronous TLS setup errors reject the probe without crashing its process", host: "models.example.test", san: "DNS:models.example.test", rejected: true, setupError: true },
];

for (const scenario of cases) test("HTTPS proxy: " + scenario.name, { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(testRoot, "provider-proxy-")), cert = path.join(dir, "fixture-cert.pem"), key = path.join(dir, "fixture-key.pem"), config = path.join(dir, "fixture-openssl.cnf");
  fs.writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=models.example.test\n[ext]\nsubjectAltName=" + scenario.san + "\nbasicConstraints=critical,CA:TRUE\n");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-config", config], { timeout: 5000 });
  let seen, connected, servername;
  const upstream = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen = { auth: req.headers.authorization, body: JSON.parse(body), url: req.url };
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"content":[]}');
  }); upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  upstream.on("secureConnection", socket => { servername = socket.servername; });
  const sockets = new Set(), proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    connected = req.url; const tunnel = net.connect(upstream.address().port, "127.0.0.1"); sockets.add(tunnel); sockets.add(socket);
    tunnel.once("connect", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) tunnel.write(head); socket.pipe(tunnel); tunnel.pipe(socket); });
    tunnel.on("error", () => socket.destroy()); socket.on("error", () => tunnel.destroy());
  }); proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); upstream.closeAllConnections(); await Promise.all([new Promise((r) => upstream.close(r)), new Promise((r) => proxy.close(r))]); });
  const module = new URL("../src/providers.mjs", import.meta.url).href;
  const transport = new URL("../src/messages-api.mjs", import.meta.url).href;
  const authority = scenario.host + (scenario.host === "models.example.test" ? "" : ":" + upstream.address().port);
  const script = `import tls from 'node:tls'; import {testProvider} from ${JSON.stringify(module)}; import {messagesRequest} from ${JSON.stringify(transport)};
    let transportError; const request = async (...args) => { try { return await messagesRequest(...args); } catch(e) { transportError={code:e.code,message:e.message}; throw e; } };
    if (${Boolean(scenario.setupError)}) tls.connect = () => { throw new Error('fixture TLS setup failure'); };
    try { const r=await testProvider({baseUrl:${JSON.stringify("https://" + authority)},apiKey:"fake-tunnel-provider-key",model:"basic-tunnel",protocol:"anthropic"},{request}); console.log(JSON.stringify({ok:r.ok})); }
    catch (e) { console.log(JSON.stringify({ok:false,error:e.message,transportError})); }`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert, HTTPS_PROXY: "http://127.0.0.1:" + proxy.address().port }, timeout: 5000,
  });
  const result = JSON.parse(stdout);
  assert.equal(connected, authority + (scenario.host === "models.example.test" ? ":443" : ""));
  if (scenario.rejected) {
    assert.equal(result.ok, false); assert.match(result.error, /模型服务连接失败或超时/); assert.equal(seen, undefined);
    if (!scenario.setupError) assert.equal(result.transportError.code, "ERR_TLS_CERT_ALTNAME_INVALID");
    return;
  }
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(servername, scenario.servername);
  assert.equal(seen.auth, "Bearer fake-tunnel-provider-key"); assert.equal(seen.body.model, "basic-tunnel"); assert.equal(seen.url, "/v1/messages");
});
