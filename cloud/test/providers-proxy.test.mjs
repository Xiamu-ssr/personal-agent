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

test("small HTTPS Messages calls tunnel through HTTPS_PROXY, preserve TLS validation and send the selected auth", { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(testRoot, "provider-proxy-")), cert = path.join(dir, "fixture-cert.pem"), key = path.join(dir, "fixture-key.pem"), config = path.join(dir, "fixture-openssl.cnf");
  fs.writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=models.example.test\n[ext]\nsubjectAltName=DNS:models.example.test\nbasicConstraints=critical,CA:TRUE\n");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-config", config], { timeout: 5000 });
  let seen, connected;
  const upstream = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen = { auth: req.headers.authorization, body: JSON.parse(body), url: req.url };
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"content":[]}');
  }); upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const sockets = new Set(), proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    connected = req.url; const tunnel = net.connect(upstream.address().port, "127.0.0.1"); sockets.add(tunnel); sockets.add(socket);
    tunnel.once("connect", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) tunnel.write(head); socket.pipe(tunnel); tunnel.pipe(socket); });
    tunnel.on("error", () => socket.destroy()); socket.on("error", () => tunnel.destroy());
  }); proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); upstream.closeAllConnections(); await Promise.all([new Promise((r) => upstream.close(r)), new Promise((r) => proxy.close(r))]); });
  const module = new URL("../src/providers.mjs", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import {testProvider} from ${JSON.stringify(module)}; const r=await testProvider({baseUrl:"https://models.example.test",apiKey:"fake-tunnel-provider-key",model:"basic-tunnel",protocol:"anthropic"}); console.log(JSON.stringify({ok:r.ok}));`], {
    env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert, HTTPS_PROXY: "http://127.0.0.1:" + proxy.address().port }, timeout: 5000,
  });
  assert.equal(JSON.parse(stdout).ok, true); assert.equal(connected, "models.example.test:443");
  assert.equal(seen.auth, "Bearer fake-tunnel-provider-key"); assert.equal(seen.body.model, "basic-tunnel"); assert.equal(seen.url, "/v1/messages");
});
