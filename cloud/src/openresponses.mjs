import { request } from 'node:http';

// The local gateway can run tools or compact without sending assistant text.
// fetch() imposes a 300-second body inactivity timeout; that is not a task deadline.
// Let OpenClaw own the run deadline and keep the caller's explicit cancellation.
export async function openResponse(url, { token, sessionKey, input, signal, onText = () => {} }) {
  const body = JSON.stringify({ model: 'openclaw/main', input, stream: true });
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      const req = request(new URL('/v1/responses', url), {
        method: 'POST', signal, agent: false, timeout: 0,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(body), 'x-openclaw-session-key': sessionKey },
      }, resolve);
      req.on('error', reject);
      req.end(body);
    });
    if (response.statusCode !== 200) {
      let bytes = 0, detail = '';
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) break;
        detail += chunk.toString('utf8');
      }
      let reason;
      try { const value = JSON.parse(detail); reason = value.error?.message || value.message; } catch {}
      throw new Error(`OpenClaw HTTP ${response.statusCode}${typeof reason === 'string' ? '：' + reason.slice(0, 1000) : ''}`);
    }
    let pending = '', output = '', completed = false, usage;
    const decoder = new TextDecoder();
    const frame = value => {
      const data = value.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n').trim();
      if (!data || data === '[DONE]') return;
      const event = JSON.parse(data);
      if (event.type === 'response.output_text.delta') { output += event.delta || ''; onText(event.delta || ''); }
      if (event.type === 'response.completed') { completed = true; usage = event.response?.usage; }
      if (event.type === 'response.failed' || event.type === 'error') {
        throw new Error(event.response?.error?.message || event.error?.message || 'OpenClaw 执行失败');
      }
      if (event.type === 'response.incomplete') throw new Error('本次执行达到模型输出上限，尚未完成');
    };
    for await (const chunk of response) {
      pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) { frame(pending.slice(0, end)); pending = pending.slice(end + 2); }
    }
    pending += decoder.decode();
    if (pending.trim()) frame(pending);
    if (!completed) throw new Error('OpenClaw 执行连接提前结束，未收到完成结果');
    return { text: output.trim(), usage };
  } catch (error) {
    signal?.throwIfAborted();
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) {
      throw new Error('与 OpenClaw 的执行连接中断，请查看服务状态', { cause: error });
    }
    throw error;
  } finally { response?.destroy(); }
}
