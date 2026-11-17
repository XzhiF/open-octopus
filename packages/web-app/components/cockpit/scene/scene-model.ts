// 舱景三幕（原型 cockpit-v21.html SCENES，逐字对齐）。
//
// 场景是「跃迁」的可见结果：每次 travel() 切下一幕；首屏固定第一幕。
// 文件真源在 docs/cabin-design/assets（与原型共用），静态 import 只把 URL 进
// bundle，真正下载发生在 <img src>。单张 ~3MB：只加载当前幕，空闲预取下一幕。

import sceneBridge from '../../../../../docs/cabin-design/assets/scene-bridge.png'
import sceneCruise from '../../../../../docs/cabin-design/assets/scene-cruise.png'
import sceneNebula from '../../../../../docs/cabin-design/assets/scene-nebula.png'

export interface CockpitSceneDef {
  key: 'bridge' | 'cruise' | 'nebula'
  /** 长名（HUD SCENE pill / 场景点 title）。 */
  name: string
  /** 短名（console footer）。 */
  short: string
  file: string
  /** 原型里的赤经赤纬读数（纯氛围，不是天文数据）。 */
  coord: string
}

export const SCENES: readonly CockpitSceneDef[] = [
  { key: 'bridge', name: '舰桥 · 日落', short: '舰桥·日落', file: sceneBridge, coord: 'RA 17h42m · DEC −28°' },
  { key: 'cruise', name: '星空 · 巡航', short: '星空·巡航', file: sceneCruise, coord: 'RA 05h35m · DEC −05°' },
  { key: 'nebula', name: '星云 · 门', short: '星云·门', file: sceneNebula, coord: 'RA 18h20m · DEC +38°' },
]

export const SCENE_COUNT = SCENES.length

export function sceneAt(index: number): CockpitSceneDef {
  return SCENES[((index % SCENE_COUNT) + SCENE_COUNT) % SCENE_COUNT]
}
