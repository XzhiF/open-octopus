// 舱景（12 幕）—— 元数据单一真源：docs/cabin-design/assets/scenes.json。
//
// 原型 cockpit-v21.html 与生产都从这份清单取 key / name / short / file（原型块由
// `docs/cabin-design/assets/sync-scenes.mjs` 生成，scene-model.test.ts 守漂移）。
// 图片本体同样放在 docs/cabin-design/assets（与原型共用），这里只做静态 import
// 让 Vite 把 URL 收进 bundle；真正下载发生在 <img src>，单张 ~3MB：只加载当前幕，
// 空闲预取下一幕。
//
// 场景是「跃迁」的可见结果：每次 travel() 切下一幕；首屏固定第一幕。

import sceneManifest from '../../../../../docs/cabin-design/assets/scenes.json'
import sceneBridge from '../../../../../docs/cabin-design/assets/scene-bridge.png'
import sceneCruise from '../../../../../docs/cabin-design/assets/scene-cruise.png'
import sceneNebula from '../../../../../docs/cabin-design/assets/scene-nebula.png'
import sceneAurora from '../../../../../docs/cabin-design/assets/scene-aurora.png'
import sceneBlackhole from '../../../../../docs/cabin-design/assets/scene-blackhole.png'
import sceneRing from '../../../../../docs/cabin-design/assets/scene-ring.png'
import scenePort from '../../../../../docs/cabin-design/assets/scene-port.png'
import sceneSolar from '../../../../../docs/cabin-design/assets/scene-solar.png'
import sceneIcemoon from '../../../../../docs/cabin-design/assets/scene-icemoon.png'
import sceneGate from '../../../../../docs/cabin-design/assets/scene-gate.png'
import sceneEarthrise from '../../../../../docs/cabin-design/assets/scene-earthrise.png'
import sceneDeepspace from '../../../../../docs/cabin-design/assets/scene-deepspace.png'

export interface CockpitSceneDef {
  /** 稳定 key（JSON 单一真源）。 */
  key: string
  /** 长名（HUD SCENE pill / 场景点 title）。 */
  name: string
  /** 短名（console footer）。 */
  short: string
  /** 已解析的图片 URL。 */
  file: string
}

/** JSON 只给文件名；打包必须走静态 import（Vite 才能收进产物）。 */
const FILE_URLS: Record<string, string> = {
  'scene-bridge.png': sceneBridge,
  'scene-cruise.png': sceneCruise,
  'scene-nebula.png': sceneNebula,
  'scene-aurora.png': sceneAurora,
  'scene-blackhole.png': sceneBlackhole,
  'scene-ring.png': sceneRing,
  'scene-port.png': scenePort,
  'scene-solar.png': sceneSolar,
  'scene-icemoon.png': sceneIcemoon,
  'scene-gate.png': sceneGate,
  'scene-earthrise.png': sceneEarthrise,
  'scene-deepspace.png': sceneDeepspace,
}

export const SCENES: readonly CockpitSceneDef[] = sceneManifest.map((entry) => {
  const file = FILE_URLS[entry.file]
  if (!file) throw new Error(`舱景图片缺失：${entry.file}（scenes.json 与 assets 不一致）`)
  return { key: entry.key, name: entry.name, short: entry.short, file }
})

export const SCENE_COUNT = SCENES.length

export function sceneAt(index: number): CockpitSceneDef {
  return SCENES[((index % SCENE_COUNT) + SCENE_COUNT) % SCENE_COUNT]
}
