// v22（原型 design 33 / cockpit-v22.html）：汐音 **纯视频立绘** + 13 支动作片段单源。
//
// 资产真源在 docs/cabin-design/assets/v22（原型与全舱共用一份，不复制进 public）：
//   · NN-pose.webm       —— 768×1152 VP9 alpha，13 支（旧批次 3 + 新批次 10）；
//   · thumbs/NN-pose.png —— 图鉴缩略图（视频 1.2s 抽帧，320×480）。
// 13 支由 _motion-v22.mjs 抠像后**统一归一化**：人物高 1040 / 脚底 1105 /
// 躯干中轴 384，切换片段不跳位、比例一致（design 33 §2）。
//
// 片段顺序就是用户指定顺序（点击图鉴卡片 / 真实事件都按 pose → 片段映射）：
//   wink thinking command | alert concerned command idle ready smile thinking typing wink working
// 前 3 支旧批次、后 10 支新批次；command / thinking / wink 各出现两次，图鉴按
// 片段各自保留，互不合并。
//
// mood 仍是语义键（数据层大量 mood:'happy'|'worried'），**不要跟着 pose 改名**；
// 二者经 MOOD_POSE / POSE_MOOD 双向映射。立绘渲染 = mood → pose → 片段。
// 没有专属片段的 pose（cheer / sleep）映射到语义最近的片段（smile / idle）。
//
// 静态 import 只把 URL 进 bundle；webm 字节只在 <video src> 真正用到时才下载。

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

import clip01 from '../../../../../docs/cabin-design/assets/v22/01-wink.webm'
import clip02 from '../../../../../docs/cabin-design/assets/v22/02-thinking.webm'
import clip03 from '../../../../../docs/cabin-design/assets/v22/03-command.webm'
import clip04 from '../../../../../docs/cabin-design/assets/v22/04-alert.webm'
import clip05 from '../../../../../docs/cabin-design/assets/v22/05-concerned.webm'
import clip06 from '../../../../../docs/cabin-design/assets/v22/06-command.webm'
import clip07 from '../../../../../docs/cabin-design/assets/v22/07-idle.webm'
import clip08 from '../../../../../docs/cabin-design/assets/v22/08-ready.webm'
import clip09 from '../../../../../docs/cabin-design/assets/v22/09-smile.webm'
import clip10 from '../../../../../docs/cabin-design/assets/v22/10-thinking.webm'
import clip11 from '../../../../../docs/cabin-design/assets/v22/11-typing.webm'
import clip12 from '../../../../../docs/cabin-design/assets/v22/12-wink.webm'
import clip13 from '../../../../../docs/cabin-design/assets/v22/13-working.webm'

import thumb01 from '../../../../../docs/cabin-design/assets/v22/thumbs/01-wink.png'
import thumb02 from '../../../../../docs/cabin-design/assets/v22/thumbs/02-thinking.png'
import thumb03 from '../../../../../docs/cabin-design/assets/v22/thumbs/03-command.png'
import thumb04 from '../../../../../docs/cabin-design/assets/v22/thumbs/04-alert.png'
import thumb05 from '../../../../../docs/cabin-design/assets/v22/thumbs/05-concerned.png'
import thumb06 from '../../../../../docs/cabin-design/assets/v22/thumbs/06-command.png'
import thumb07 from '../../../../../docs/cabin-design/assets/v22/thumbs/07-idle.png'
import thumb08 from '../../../../../docs/cabin-design/assets/v22/thumbs/08-ready.png'
import thumb09 from '../../../../../docs/cabin-design/assets/v22/thumbs/09-smile.png'
import thumb10 from '../../../../../docs/cabin-design/assets/v22/thumbs/10-thinking.png'
import thumb11 from '../../../../../docs/cabin-design/assets/v22/thumbs/11-typing.png'
import thumb12 from '../../../../../docs/cabin-design/assets/v22/thumbs/12-wink.png'
import thumb13 from '../../../../../docs/cabin-design/assets/v22/thumbs/13-working.png'

export type PoseKey =
  | 'idle' | 'working' | 'thinking' | 'alert' | 'smile' | 'concerned'
  | 'cheer' | 'wink' | 'sleep' | 'ready' | 'command' | 'typing'

/** 12 个语义姿态（图鉴/映射仍以姿态为单位；13 支视频是表现层）。 */
export const POSE_ORDER: readonly PoseKey[] = [
  'idle', 'working', 'thinking', 'alert', 'smile', 'concerned',
  'cheer', 'wink', 'sleep', 'ready', 'command', 'typing',
]

/** 粒子层效果名（对应 crew.css 的 .ck12-pfx-<fx>）。
 *  v21 四轮：去掉 'ring'（立绘正中的小圆环，用户要求移除）；alert 姿态改用 none。 */
export type PoseFx =
  | 'none' | 'ambient' | 'spark' | 'bubble' | 'sweat' | 'heart'
  | 'confetti' | 'sparkle' | 'zzz' | 'shine' | 'beam' | 'keys'

export interface PoseMeta {
  cn: string
  en: string
  desc: string
  line: string
  fps: number
  fx: PoseFx
}

/** 文案与粒子沿用原型 v21 的 POSE_META / MO_FPS（逐字对齐 cockpit-v22.html）。 */
export const POSE_META: Record<PoseKey, PoseMeta> = {
  idle: { cn: '待命', en: 'IDLE', desc: '静默呼吸 · 随时接单', line: '我在。您说。', fps: 10, fx: 'ambient' },
  working: { cn: '作业', en: 'WORK', desc: '盯执行 · 推进度', line: '这条我在盯，进度实时举给您。', fps: 12, fx: 'spark' },
  thinking: { cn: '思考', en: 'THINK', desc: '整理证据 · 给建议', line: '嗯……我把证据摊开想一下，马上给您建议。', fps: 8, fx: 'bubble' },
  alert: { cn: '警觉', en: 'ALERT', desc: '发现异常 · 举牌', line: '指挥官，有情况，我举上来了。', fps: 10, fx: 'none' },
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

/** 单帧立绘：**仅作视频解码失败的兜底**（正常路径全程视频，design 33 §3）。
 *  cheer / sleep 没有专属片段，兜底图也让画面不至于空白。 */
export const POSE_SRC: Record<PoseKey, string> = {
  idle: poseIdle, working: poseWorking, thinking: poseThinking, alert: poseAlert,
  smile: poseSmile, concerned: poseConcerned, cheer: poseCheer, wink: poseWink,
  sleep: poseSleep, ready: poseReady, command: poseCommand, typing: poseTyping,
}

export type ClipBatch = '旧' | '新'

export interface Clip {
  /** 1-based 序号（图鉴角标 01…13）。 */
  no: number
  pose: PoseKey
  batch: ClipBatch
  /** VP9 alpha webm（768×1152，归一化后）。 */
  src: string
  /** 图鉴缩略图（320×480 png）。 */
  thumb: string
}

/** 用户指定顺序，逐条对应 assets/v22/NN-pose.webm（design 33 §1）。 */
export const CLIPS: readonly Clip[] = [
  { no: 1, pose: 'wink', batch: '旧', src: clip01, thumb: thumb01 },
  { no: 2, pose: 'thinking', batch: '旧', src: clip02, thumb: thumb02 },
  { no: 3, pose: 'command', batch: '旧', src: clip03, thumb: thumb03 },
  { no: 4, pose: 'alert', batch: '新', src: clip04, thumb: thumb04 },
  { no: 5, pose: 'concerned', batch: '新', src: clip05, thumb: thumb05 },
  { no: 6, pose: 'command', batch: '新', src: clip06, thumb: thumb06 },
  { no: 7, pose: 'idle', batch: '新', src: clip07, thumb: thumb07 },
  { no: 8, pose: 'ready', batch: '新', src: clip08, thumb: thumb08 },
  { no: 9, pose: 'smile', batch: '新', src: clip09, thumb: thumb09 },
  { no: 10, pose: 'thinking', batch: '新', src: clip10, thumb: thumb10 },
  { no: 11, pose: 'typing', batch: '新', src: clip11, thumb: thumb11 },
  { no: 12, pose: 'wink', batch: '新', src: clip12, thumb: thumb12 },
  { no: 13, pose: 'working', batch: '新', src: clip13, thumb: thumb13 },
]

/** 语义姿态 → 首选片段下标（重复姿态取最早出现的一支，与原型 findIndex 一致）。
 *  cheer / sleep 无专属片段：落到语义最近的 smile / idle。 */
export const POSE_CLIP: Record<PoseKey, number> = {
  wink: 0,
  thinking: 1,
  command: 2,
  alert: 3,
  concerned: 4,
  idle: 6,
  ready: 7,
  smile: 8,
  typing: 10,
  working: 12,
  cheer: 8,
  sleep: 6,
}

/** 姿态 → 片段下标（越界/未知一律回闲置）。 */
export function poseClip(pose: PoseKey): number {
  const index = POSE_CLIP[pose]
  return Number.isInteger(index) && index >= 0 && index < CLIPS.length ? index : POSE_CLIP.idle
}

/** 片段下标 → 姿态（图鉴点击/状态上报共用）。 */
export function clipPose(index: number): PoseKey {
  return CLIPS[index]?.pose ?? 'idle'
}

/** 片段连续轮播（图鉴的「下一支」/ 键盘体验用），越界回环。 */
export function nextClip(index: number, step = 1): number {
  const n = CLIPS.length
  return ((index + step) % n + n) % n
}

/** 同一姿态的全部片段（顺序 = CLIPS 顺序）：command/thinking/wink 各两支。
 *  动作事件生成时在变体间交替，避免每次都是同一个动作。 */
export const POSE_CLIP_VARIANTS: Record<PoseKey, readonly number[]> = {
  wink: [0, 11],
  thinking: [1, 9],
  command: [2, 5],
  alert: [3],
  concerned: [4],
  idle: [6],
  ready: [7],
  smile: [8],
  typing: [10],
  working: [12],
  cheer: [8],
  sleep: [6],
}

export function clipVariants(pose: PoseKey): readonly number[] {
  const variants = POSE_CLIP_VARIANTS[pose]
  return variants && variants.length ? variants : [poseClip(pose)]
}

/** 待命自走候选（2026-11-20 用户 #14 二改）：13 支全部参与，抽法用「洗牌袋」——
 *  每轮随机排列一次、抽完再洗。顺序仍是随机的，但一轮内每支必出现一次，
 *  不会像纯随机那样长期漏掉某支。 */
export const AMBIENT_CLIPS: readonly number[] = [
  6,  // 07-idle
  8,  // 09-smile
  11, // 12-wink
  9,  // 10-thinking
  7,  // 08-ready
  12, // 13-working
  1,  // 02-thinking（旧）
  2,  // 03-command（旧）
  0,  // 01-wink（旧）
  3,  // 04-alert
  4,  // 05-concerned
  5,  // 06-command
  10, // 11-typing
]

/** 等待穿插的小动作位：除 alert 主拍外的 12 支（主拍按节奏位单独插入）。
 *  2026-11-19 用户：有待办时一直循环同一支 alert 摇头很呆；2026-11-20 #14：
 *  其余 12 支都要看得到 —— 小动作位从这 12 支里洗牌袋抽取。 */
export const WAITING_OTHERS: readonly number[] = [
  6,  // 07-idle
  8,  // 09-smile
  11, // 12-wink
  9,  // 10-thinking
  7,  // 08-ready
  12, // 13-working
  1,  // 02-thinking（旧）
  0,  // 01-wink（旧）
  2,  // 03-command（旧）
  10, // 11-typing
  5,  // 06-command
  4,  // 05-concerned
]

/** 作业穿插的小动作位：除 working 主拍外的 12 支。长时间跑任务时她原本冻在
 *  13-working 一支，其余表情整段看不到（2026-11-20 用户 #14）。 */
export const WORKING_OTHERS: readonly number[] = [
  6,  // 07-idle
  8,  // 09-smile
  11, // 12-wink
  9,  // 10-thinking
  7,  // 08-ready
  1,  // 02-thinking（旧）
  0,  // 01-wink（旧）
  2,  // 03-command（旧）
  10, // 11-typing
  3,  // 04-alert
  5,  // 06-command
  4,  // 05-concerned
]

/** 洗牌袋状态：order 是本轮随机排列，index 是抽到第几支。 */
export interface ClipBag {
  order: number[]
  index: number
}

export function createClipBag(): ClipBag {
  return { order: [], index: 0 }
}

/** Fisher–Yates 洗牌（rnd 可注入，测试用）。 */
export function shuffleClips(
  candidates: readonly number[],
  rnd: () => number = Math.random,
): number[] {
  const order = [...candidates]
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const swap = order[i]!
    order[i] = order[j]!
    order[j] = swap
  }
  return order
}

/** 从袋里抽下一支：抽完一轮才重洗；新一轮第一支不与当前画面重复。 */
export function nextFromBag(
  bag: ClipBag,
  candidates: readonly number[],
  current: number | null,
  rnd: () => number = Math.random,
): number {
  if (bag.order.length === 0 || bag.index >= bag.order.length) {
    bag.order = shuffleClips(candidates, rnd)
    bag.index = 0
    if (current !== null && bag.order.length > 1 && bag.order[0] === current) {
      const swapWith = 1 + Math.floor(rnd() * (bag.order.length - 1))
      const first = bag.order[0]!
      bag.order[0] = bag.order[swapWith]!
      bag.order[swapWith] = first
    }
  }
  const pick = bag.order[bag.index] ?? candidates[0] ?? poseClip('idle')
  bag.index += 1
  return pick
}
