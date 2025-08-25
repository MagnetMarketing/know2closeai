// Cloudflare Worker: Know2Close chat (Assistants API v2)
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const { message, thread_id } = await request.json();
    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ error: 'message is required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const headers = {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      // Assistants v2 header (required)
      'OpenAI-Beta': 'assistants=v2'
    };

    // 1) Ensure thread
    let tid = thread_id;
    if (!tid) {
      const tRes = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST', headers
      });
      if (!tRes.ok) return err(tRes);
      const tData = await tRes.json();
      tid = tData.id;
    }

    // 2) Add user message
    const mRes = await fetch(`https://api.openai.com/v1/threads/${tid}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ role: 'user', content: message })
    });
    if (!mRes.ok) return err(mRes);

    // 3) Create a run
    const runRes = await fetch(`https://api.openai.com/v1/threads/${tid}/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ assistant_id: env.KNOW2CLOSE_ASSISTANT_ID })
    });
    if (!runRes.ok) return err(runRes);
    const runData = await runRes.json();

    // 4) Poll until completed (simple loop; you can stream if you like)
    let status = runData.status;
    let runId = runData.id;
    const maxWaitMs = 20000, stepMs = 800;
    let waited = 0;
    while (status !== 'completed' && status !== 'failed' && waited < maxWaitMs) {
      await delay(stepMs); waited += stepMs;
      const chk = await fetch(`https://api.openai.com/v1/threads/${tid}/runs/${runId}`, { headers });
      if (!chk.ok) return err(chk);
      const info = await chk.json();
      status = info.status;
    }
    if (status !== 'completed') {
      return new Response(JSON.stringify({ error: `Run ${status}` }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 5) Read the latest assistant message
    const listRes = await fetch(`https://api.openai.com/v1/threads/${tid}/messages?limit=1&order=desc`, { headers });
    if (!listRes.ok) return err(listRes);
    const list = await listRes.json();
    const last = list.data?.[0];
    const text = last?.content?.[0]?.text?.value || '(No response text)';

    return new Response(JSON.stringify({ thread_id: tid, reply: text }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
}

function err(res) {
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' }});
}
function delay(ms){ return new Promise(r=>setTimeout(r, ms)); }

