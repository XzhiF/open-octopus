// 舱景清单「单一真源」门禁：scenes.json 是唯一真源，生产与原型都不许各写一份。

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SCENES, SCENE_COUNT, sceneAt } from '../scene-model'

interface ManifestScene {
  key: string
  name: string
  short: string
  file: string
}

// vitest 的 cwd 是 web-app（单独跑）或仓库根（workspace 跑），两种都兜住。
const repoRoot = existsSync(resolve(process.cwd(), 'docs/cabin-design'))
  ? process.cwd()
  : resolve(process.cwd(), '..', '..')
const manifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'docs/cabin-design/assets/scenes.json'), 'utf8'),
) as ManifestScene[]
const prototypeHtml = readFileSync(
  resolve(repoRoot, 'docs/cabin-design/cockpit-v21.html'),
  'utf8',
)

/** 取出原型 `const SCENES=[...]` 块里的条目（由 sync-scenes.mjs 生成）。 */
function prototypeScenes(): Array<Pick<ManifestScene, 'name' | 'short' | 'file'>> {
  const block = prototypeHtml.match(/const SCENES=\[([\s\S]*?)\];/)
  if (!block) throw new Error('原型里找不到 const SCENES=[...] 块')
  return [...block[1].matchAll(
    /\{name:'([^']*)',short:'([^']*)',file:'\.\/assets\/([^']*)'\}/g,
  )].map((hit) => ({ name: hit[1], short: hit[2], file: hit[3] }))
}

describe('舱景单一真源（scenes.json）', () => {
  it('生产 SCENES 与清单同序 · 同 key/name/short', () => {
    expect(SCENES.map(({ key, name, short }) => ({ key, name, short })))
      .toEqual(manifest.map(({ key, name, short }) => ({ key, name, short })))
  })

  it('12 幕 · key 唯一', () => {
    expect(SCENE_COUNT).toBe(12)
    expect(manifest).toHaveLength(12)
    expect(new Set(SCENES.map((scene) => scene.key)).size).toBe(SCENE_COUNT)
  })

  it('原型 SCENES 块与清单一致（改动请跑 sync-scenes.mjs，不要手改原型）', () => {
    expect(prototypeScenes())
      .toEqual(manifest.map(({ name, short, file }) => ({ name, short, file })))
  })

  it('sceneAt 环绕（正负越界都回绕）', () => {
    expect(sceneAt(0).key).toBe(manifest[0].key)
    expect(sceneAt(SCENE_COUNT).key).toBe(manifest[0].key)
    expect(sceneAt(-1).key).toBe(manifest[manifest.length - 1].key)
  })
})
