// docs/cabin-design/_migrate-v21-theme.mjs —— ②A 一次性配色迁移（不入库）。
//
// 默认 dry-run：只打印将改动的舱。加 --apply 才写。
// 幂等：theme 已是 terminal 的舱跳过；重复执行无副作用。
// 可回退：每舱打印原 theme，按需再 PATCH 回去即可。
//
// 跑：node docs/cabin-design/_migrate-v21-theme.mjs [--apply]

const SERVER = process.env.OCTOPUS_SERVER_URL ?? 'http://localhost:3001'
const apply = process.argv.includes('--apply')

async function json(url, init) {
  const res = await fetch(`${SERVER}${url}`, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

const { cabins } = await json('/api/cabins')
const targets = cabins.filter((c) => (c.cockpit_prefs?.theme ?? 'terminal') !== 'terminal')

if (targets.length === 0) {
  console.log('nothing to migrate — all cabins already terminal')
  process.exit(0)
}

for (const cabin of targets) {
  const from = cabin.cockpit_prefs?.theme ?? '(none)'
  console.log(`${apply ? 'MIGRATE' : 'PLAN'} ${cabin.id} ${cabin.name}: ${from} → terminal (v${cabin.version})`)
  if (!apply) continue
  const prefs = { ...(cabin.cockpit_prefs ?? {}), theme: 'terminal' }
  await json(`/api/cabins/${cabin.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: cabin.version, cockpit_prefs: prefs }),
  })
}

console.log(apply ? `migrated ${targets.length} cabin(s)` : `dry-run: ${targets.length} cabin(s); re-run with --apply`)
