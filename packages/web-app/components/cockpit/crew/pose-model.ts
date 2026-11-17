// v21（design 31 §3.5 / §5.5）：汐音 12 姿态元数据 + 资产单源。
//
// 资产真源在 docs/cabin-design/assets（原型与全舱共用一份，不复制进 public）：
//   · pose-*.png        —— 单帧 1024×1536 透明底，v21 重绘的 12 套（运行时真源）；
//   · motion-sheet-*.png —— 12 帧竖叠 sheet（480×8640），v21 静态阶段暂空；
//   · sheet-*.png       —— 双帧回退，v21 静态阶段暂空。
//
// 2026-11-17 v21：整套立绘按 pose-command 的修长比例重画，剔除闭眼 worried/salute
// 与矮胖 happy；姿态键改为 idle/working/thinking/alert/smile/concerned/cheer/wink/
// sleep/ready/command/typing。动画 sheet 由后续 VideoGen 管线补齐（handoff
// xiyin-12-poses）——**先静态确认，再动画化**，所以这里 MOTION/FALLBACK 留空，
// framesFor() 对全部姿态返回 1（单帧静图）。sheet 就绪后只需填这两个表。
//
// mood 是语义键（数据层大量 mood:'happy'|'worried'），**不要跟着 pose 改名**；
// 二者经 MOOD_POSE / POSE_MOOD 双向映射。
//
// 静态 import 只把 URL 进 bundle；图片字节只在 <img src> 真正用到时才下载/解码
// （单激活 sheet ≈16MB 解码内存，换 pose 释放旧图 —— design 29 §14）。

import type { MoodKey } from '@/components/cabin/cockpit'

import poseIdle from '../../../../../docs/cabin-design/assets/pose-idle.png'
import poseWorking from '../../../../../docs/cabin-design/assets/pose-working.png'
import poseThinking from '../../../../../docs/cabin-design/assets/pose-thinking.png'
import poseAlert from '../../../../../docs/cabin-design/assets/pose-alert.png'
import poseSmile from '../../../../../docs/cabin-design/assets/pose-smile.png'
import poseConcerned from '../../../../../docs/cabin-design/assets/pose-concerned.png'
import poseCheer from '../../../../../docs/cabin-design/assets/pose-cheer.png'
import poseWink from '../../../../../docs/cabin-design/assets/pose-wink.png'
import poseSleep from '../../../../../docs/cabin-design/assets/pose-sleep.png'
import poseReady from '../../../../../docs/cabin-design/assets/pose-ready.png'
import poseCommand from '../../../../../docs/cabin-design/assets/pose-command.png'
import poseTyping from '../../../../../docs/cabin-design/assets/pose-typing.png'

export type PoseKey =
  | 'idle' | 'working' | 'thinking' | 'alert' | 'smile' | 'concerned'
  | 'cheer' | 'wink' | 'sleep' | 'ready' | 'command' | 'typing'

/** 图鉴顺序（原型 v21 POSE_ORDER）。 */
export const POSE_ORDER: readonly PoseKey[] = [
  'idle', 'working', 'thinking', 'alert', 'smile', 'concerned',
  'cheer', 'wink', 'sleep', 'ready', 'command', 'typing',
]

/** 粒子层效果名（对应 crew.css 的 .ck12-pfx-<fx>）。 */
export type PoseFx =
  | 'ambient' | 'spark' | 'bubble' | 'ring' | 'sweat' | 'heart'
  | 'confetti' | 'sparkle' | 'zzz' | 'shine' | 'beam' | 'keys'

export interface PoseMeta {
  cn: string
  en: string
  desc: string
  line: string
  fps: number
  fx: PoseFx
}

/** 文案与粒子沿用原型 v21 的 POSE_META / MO_FPS（逐字对齐 cockpit-v21.html）。 */
export const POSE_META: Record<PoseKey, PoseMeta> = {
  idle: { cn: '待命', en: 'IDLE', desc: '静默呼吸 · 随时接单', line: '我在。您说。', fps: 10, fx: 'ambient' },
  working: { cn: '作业', en: 'WORK', desc: '盯执行 · 推进度', line: '这条我在盯，进度实时举给您。', fps: 12, fx: 'spark' },
  thinking: { cn: '思考', en: 'THINK', desc: '整理证据 · 给建议', line: '嗯……我把证据摊开想一下，马上给您建议。', fps: 8, fx: 'bubble' },
  alert: { cn: '警觉', en: 'ALERT', desc: '发现异常 · 举牌', line: '指挥官，有情况，我举上来了。', fps: 10, fx: 'ring' },
  smile: { cn: '愉悦', en: 'SMILE', desc: '消项回执 · 开心', line: '收到～这条消项了，我盯到收口。', fps: 12, fx: 'heart' },
  concerned: { cn: '担忧', en: 'CONCERN', desc: '现场冻结 · 等你', line: '别担心，现场我先停住保留了。', fps: 8, fx: 'sweat' },
  cheer: { cn: '振奋', en: 'CHEER', desc: '验收通过 · 欢呼', line: '验收通过！指挥官，这一轮漂亮！', fps: 14, fx: 'confetti' },
  wink: { cn: '俏皮', en: 'WINK', desc: '眨眼 · 轻松一刻', line: '嘿，别绷太紧，喝口水再拍板。', fps: 10, fx: 'sparkle' },
  sleep: { cn: '休眠', en: 'SLEEP', desc: '长时间无交互 · 打盹', line: '……Zzz（任意键唤醒）', fps: 6, fx: 'zzz' },
  ready: { cn: '待令', en: 'READY', desc: '舰桥接管 · 报到', line: '汐音报到，舰桥接管完毕，全舱正常。', fps: 8, fx: 'shine' },
  command: { cn: '指挥', en: 'CMD', desc: '派单 relay · 出击', line: '收到，派进编队，出击！', fps: 12, fx: 'beam' },
  typing: { cn: '键入', en: 'TYPE', desc: '全息键盘 · 编译', line: '我在编译产物，键声就是进度。', fps: 16, fx: 'keys' },
}

/** mood → pose：开机不再敬礼，待命起步（design 31 §3.5）。 */
export const MOOD_POSE: Record<MoodKey, PoseKey> = {
  boot: 'idle',
  idle: 'idle',
  working: 'working',
  alert: 'alert',
  happy: 'smile',
  sleep: 'sleep',
  thinking: 'thinking',
  cheer: 'cheer',
  wink: 'wink',
  worried: 'concerned',
}

/** pose → mood：只用于台词标签/氛围，不反向改写数据层 mood 键。 */
export const POSE_MOOD: Record<PoseKey, MoodKey> = {
  idle: 'idle',
  working: 'working',
  thinking: 'thinking',
  alert: 'alert',
  smile: 'happy',
  concerned: 'worried',
  cheer: 'cheer',
  wink: 'wink',
  sleep: 'sleep',
  ready: 'boot',
  command: 'working',
  typing: 'working',
}

/** 动作姿态期间 mood 不覆盖 pose（design 29 §9.1）；结束回落 mood pose。 */
export const ACTION_POSES: readonly PoseKey[] = ['cheer', 'command', 'ready']

/** 单帧立绘：v21 静态真源，也是图鉴缩略图。 */
export const POSE_SRC: Record<PoseKey, string> = {
  idle: poseIdle, working: poseWorking, thinking: poseThinking, alert: poseAlert,
  smile: poseSmile, concerned: poseConcerned, cheer: poseCheer, wink: poseWink,
  sleep: poseSleep, ready: poseReady, command: poseCommand, typing: poseTyping,
}

/** 12 帧动画 sheet：**v21 静态阶段留空**，VideoGen 补齐后按 pose 填入即可启用。 */
export const MOTION_SHEETS: Partial<Record<PoseKey, string>> = {}

/** 双帧回退：motion 源缺/解码失败时用；v21 静态阶段同样留空。 */
export const FALLBACK_SHEETS: Partial<Record<PoseKey, string>> = {}

export const POSE_THUMBS: Record<PoseKey, string> = POSE_SRC

export const MOTION_FRAMES = 12
export const FALLBACK_FRAMES = 2
/** 回退双帧的步频（防眨闪，design 29 §9.3）。 */
export const FALLBACK_FPS = 1.6

export interface PoseSource {
  src: string
  frames: number
  fps: number
}

/** 帧数：motion 12 → 双帧 2 → 单帧 1（原型 v21 framesFor）。 */
export function framesFor(pose: PoseKey): number {
  if (MOTION_SHEETS[pose]) return MOTION_FRAMES
  if (FALLBACK_SHEETS[pose]) return FALLBACK_FRAMES
  return 1
}

/** 某姿态的当前帧源：motion sheet → 双帧 → 单帧 pose PNG。 */
export function poseSource(pose: PoseKey): PoseSource {
  const motion = MOTION_SHEETS[pose]
  if (motion) return { src: motion, frames: MOTION_FRAMES, fps: POSE_META[pose].fps }
  const fallback = FALLBACK_SHEETS[pose]
  if (fallback) return { src: fallback, frames: FALLBACK_FRAMES, fps: FALLBACK_FPS }
  return { src: POSE_SRC[pose], frames: 1, fps: POSE_META[pose].fps }
}

/** 解码失败后的下一级回退源：motion → 双帧 → 单帧；已在单帧则返回 null。 */
export function fallbackSource(pose: PoseKey, current: string): PoseSource | null {
  const motion = MOTION_SHEETS[pose]
  const fallback = FALLBACK_SHEETS[pose]
  if (motion && current === motion) {
    return fallback
      ? { src: fallback, frames: FALLBACK_FRAMES, fps: FALLBACK_FPS }
      : { src: POSE_SRC[pose], frames: 1, fps: POSE_META[pose].fps }
  }
  if (fallback && current === fallback) {
    return { src: POSE_SRC[pose], frames: 1, fps: POSE_META[pose].fps }
  }
  return null
}
