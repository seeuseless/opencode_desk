/* 冒烟脚本：验证 opencode serve 的真实响应形状 */
const BASE = 'http://127.0.0.1:4312'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let up = false
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/session')
      if (r.ok) { up = true; break }
    } catch {}
    await sleep(500)
  }
  if (!up) { console.log('SERVER NOT UP'); process.exit(1) }

  const providers = await (await fetch(BASE + '/config/providers')).json()
  console.log('PROVIDERS keys:', Object.keys(providers))
  console.log('providers[0..2]:', JSON.stringify((providers.providers ?? []).slice(0, 2), null, 1).slice(0, 800))
  console.log('connected:', JSON.stringify(providers.connected ?? providers.all ?? null).slice(0, 400))
  console.log('default:', JSON.stringify(providers.default ?? null).slice(0, 400))

  const s = await (await fetch(BASE + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
  console.log('SESSION:', JSON.stringify(s).slice(0, 500))

  const msgs = await (await fetch(BASE + `/session/${s.id}/message`)).json()
  console.log('MESSAGES shape:', JSON.stringify(msgs).slice(0, 200))

  // 抓两秒事件流，确认 SSE 行格式与事件类型名
  const res = await fetch(BASE + '/event')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 2000 && buf.length < 1200) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
  }
  console.log('EVENT head:', buf.slice(0, 1200))
  process.exit(0)
}
main().catch((e) => { console.log('ERR', e.message); process.exit(1) })
