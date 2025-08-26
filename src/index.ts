// Cloudflare Worker: Know2Close chat (Assistants API v2) with CORS + health + dual paths
const CORS = {
  "Access-Control-Allow-Origin": "*",              // or set to your exact funnel domain
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const isAllowedPath = url.pathname === "/" || url.pathname === "/api/know2close";

    // 1) CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 2) Health page for quick browser check
    if (request.method === "GET") {
      const html = `<!doctype html><meta charset="utf-8" />
        <title>Know2Close API</title>
        <style>body{font-family:system-ui,Arial;margin:2rem;line-height:1.5}</style>
        <h1>Know2Close API</h1>
        <p>POST JSON to <code>/api/know2close</code> or <code>/</code>:</p>
        <pre>{"message":"hello","thread_id":null}</pre>`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html", ...CORS } });
    }

    // 3) Only accept POST on allowed paths
    if (request.method !== "POST" || !isAllowedPath) {
      return new Response("Method Not Allowed", { status: 405, headers: CORS });
    }

    // ---- main logic ----
    const { message, thread_id } = await request.json().catch(() => ({} as any));
    if (!message || typeof message !== "string") {
      return json({ error: "message is required" }, 400);
    }

    const headers = {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };

    // Ensure thread
    let tid = thread_id;
    if (!tid) {
      const tRes = await fetch("https://api.openai.com/v1/threads", { method: "POST", headers });
      if (!tRes.ok) return proxyErr(tRes);
      tid = (await tRes.json()).id;
    }

    // Add message
    const mRes = await fetch(`https://api.openai.com/v1/threads/${tid}/messages`, {
      method: "POST", headers, body: JSON.stringify({ role: "user", content: message })
    });
    if (!mRes.ok) return proxyErr(mRes);

    // Run assistant
    const runRes = await fetch(`https://api.openai.com/v1/threads/${tid}/runs`, {
      method: "POST", headers, body: JSON.stringify({ assistant_id: env.KNOW2CLOSE_ASSISTANT_ID })
    });
    if (!runRes.ok) return proxyErr(runRes);
    const run = await runRes.json();

    // Poll until completed
    let status = run.status, waited = 0;
    while (status !== "completed" && status !== "failed" && waited < 20000) {
      await new Promise(r => setTimeout(r, 800)); waited += 800;
      const chk = await fetch(`https://api.openai.com/v1/threads/${tid}/runs/${run.id}`, { headers });
      if (!chk.ok) return proxyErr(chk);
      status = (await chk.json()).status;
    }
    if (status !== "completed") return json({ error: `Run ${status}` }, 500);

    // Read last message
    const list = await fetch(`https://api.openai.com/v1/threads/${tid}/messages?limit=1&order=desc`, { headers });
    if (!list.ok) return proxyErr(list);
    const last = (await list.json()).data?.[0];
    const text = last?.content?.[0]?.text?.value || "(No response text)";

    return json({ thread_id: tid, reply: text }, 200);
  }
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}
function proxyErr(res: Response) {
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}
