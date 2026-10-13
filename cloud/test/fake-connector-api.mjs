import http from "node:http";
import { once } from "node:events";

export async function fakeConnectorApi(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = { method: req.method, path: req.url, authorization: req.headers.authorization, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(request);
    const { status = 200, data = {}, rawBody, headers = {} } = await handler(request);
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(rawBody ?? JSON.stringify(data));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
