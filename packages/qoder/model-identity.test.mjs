// Request-time labels preserve stable routing IDs on both Qoder sites.
import { afterEach, expect, test } from 'bun:test'
import { QoderAuthPlugin, QoderCNAuthPlugin, QwenWorkAuthPlugin, _internal } from './index.mjs'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const catalog = { kmodel_latest: 'Kimi-K3', gmodel: 'GLM-5.3', qmodel_latest: 'Qwen3.8-Max', qmodel_38max: 'Qwen3.8-Max', dfmodel: 'DeepSeek-Flash', mmodel: 'MiniMax-M3.1-Flash', ultimate: 'Ultimate', future_slot: 'Future Model' }
async function fixture(create) {
  const names = { ...catalog }
  let available = true
  const sent = []
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).pathname.endsWith('/model/list')) {
      if (!available) return new Response('', { status: 502 })
      const models = Object.entries(names).map(([key, display_name]) => ({ key, display_name, enable: true, max_input_tokens: 131072 }))
      return Response.json({ chat: models, qwork: models })
    }
    if (String(url).includes('agent_chat_generation')) {
      sent.push({ key: new Headers(init.headers).get('X-Model-Key'), body: JSON.parse(_internal.decodeBody(init.body)) })
      const chunk = { model: 'auto', choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }
      return new Response('data: ' + JSON.stringify({ body: JSON.stringify(chunk) }) + '\n\ndata: ' + JSON.stringify({ body: '[DONE]' }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error('Unexpected upstream URL')
  }
  const auth = { type: 'oauth', access: 'test-token', refresh: 'test-refresh', expires: Date.now() + 3600000, uid: 'test-user', machineId: 'test-machine' }
  const hooks = await create({ client: { auth: { set: async () => {} } } })
  const loader = await hooks.auth.loader(async () => auth)
  const ask = (model, stream = false) => loader.fetch('https://test.invalid/chat/completions', { method: 'POST', body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'OK' }] }) })
  return { ask, sent, names, hooks, auth, fail: () => { available = false } }
}
for (const [site, create] of [['qoder', QoderAuthPlugin], ['qoder-cn', QoderCNAuthPlugin]]) {
  for (const stream of [false, true]) {
    test(`${site}: all model labels, duplicate labels and tiers; stream=${stream}`, async () => {
      const f = await fixture(create)
      for (const [key, name] of Object.entries(catalog)) {
        const response = await f.ask(key, stream)
        expect(response.status).toBe(200)
        const events = stream ? (await response.text()).split('\n').filter(x => x.startsWith('data: ') && x !== 'data: [DONE]').map(x => JSON.parse(x.slice(6))) : [await response.json()]
        expect(events.every(x => x.model === name)).toBe(true)
        expect(events.at(-1).usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 10 })
        expect(f.sent.at(-1).key).toBe(key)
        expect(JSON.stringify(f.sent.at(-1).body)).toContain(key)
      }
      expect(Object.keys(await f.hooks.provider.models({ models: {} }, { auth: f.auth }))).toEqual(Object.keys(catalog))
    })
  }
  test(`${site}: non-Kimi label changes do not reuse cached names`, async () => {
    const f = await fixture(create)
    expect((await (await f.ask('gmodel')).json()).model).toBe('GLM-5.3')
    f.names.gmodel = 'GLM-Next'
    expect((await (await f.ask('gmodel')).json()).model).toBe('GLM-Next')
    f.names.gmodel = ''
    expect((await (await f.ask('gmodel')).json()).model).toBe('gmodel')
  })
  test(`${site}: refresh failure keeps chat available without claiming the old label`, async () => {
    const f = await fixture(create)
    await (await f.ask('gmodel')).text()
    f.fail()
    const response = await f.ask('gmodel')
    expect(response.status).toBe(200)
    expect((await response.json()).model).toBe('gmodel')
  })
}
test('QwenWork is not changed by this patch', async () => {
  const f = await fixture(QwenWorkAuthPlugin)
  expect((await (await f.ask('gmodel')).json()).model).toBe('gmodel')
})
