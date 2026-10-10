import http from "node:http";

export function compactRequest(body) {
  const last = JSON.stringify(body.messages?.findLast((m) => m.role === "user")?.content || "");
  return /Your task is to create a detailed summary|1500 tokens|Summarize the transcript inside|Summarize (?:the |this )?(?:conversation|messages)/i.test(last);
}

// Real local HTTP/SSE wire protocol, with fictional usage. Never calls an external model.
export async function fakeAnthropic(respond = () => ({})) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let data;
    try { data = JSON.parse(body); } catch {}
    if (!req.url.includes("messages") || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url.includes("count_tokens") ? { input_tokens: 10 } : { data: [], has_more: false }));
      return;
    }
    requests.push(data);
    const reply = await respond(data, requests.length - 1);
    if (reply.error) {
      res.writeHead(reply.status || 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: reply.error } }));
      return;
    }
    const content = reply.content || [{ type: "text", text: compactRequest(data) ? "<summary>用户目标：继续聊天。记忆在 data/memory/，待办在 data/todos.md。</summary>" : "OK" }];
    const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8, ...reply.usage };
    const message = { id: "msg_fake_" + requests.length, type: "message", role: "assistant", model: data.model,
      content, stop_reason: reply.stop_reason || "end_turn", stop_sequence: null, usage };
    if (!data.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "fake-local-request" });
    const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
    content.forEach((block, index) => {
      event("content_block_start", { index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
      event("content_block_delta", { index, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
      event("content_block_stop", { index });
    });
    event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    event("message_stop", {});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
