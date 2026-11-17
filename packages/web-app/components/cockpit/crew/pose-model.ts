// v20（design 29 §9）：汐音 12 姿态元数据 + 资产单源。
//
// 资产真源在 docs/cabin-design/assets（原型与全舱共用一份，不复制进 public）：
//   · motion-sheet-*.png —— 12 帧竖叠 sheet（480×8640），运行时真源；
//   · sheet-*.png       —— 双帧回退（motion 源缺/解码失败时）；
//   · pose-*.png        —— 单帧（图鉴缩略图）。
// 静态 import 只把 URL 进 bundle；图片字节只在 <img src> 真正用到时才下载/解码
// （单激活 sheet ≈16MB 解码内存，换 pose 释放旧图 —— design 29 §14）。

import type { MoodKey } from '@/components/cabin/cockpit'

import motionIdle from '../../../../../docs/cabin-design/assets/motion-sheet-idle.png'
import motionWorking from '../../../../../docs/cabin-design/assets/motion-sheet-working.png'
import motionThinking from '../../../../../docs/cabin-design/assets/motion-sheet-thinking.png'
import motionAlert from '../../../../../docs/cabin-design/assets/motion-sheet-alert.png'
import motionWorried from '../../../../../docs/cabin-design/assets/motion-sheet-worried.png'
import motionHappy from '../../../../../docs/cabin-design/assets/motion-sheet-happy.png'
import motionCheer from '../../../../../docs/cabin-design/assets/motion-sheet-cheer.png'
import motionWink from '../../../../../docs/cabin-design/assets/motion-sheet-wink.png'
import motionSleep from '../../../../../docs/cabin-design/assets/motion-sheet-sleep.png'
import motionSalute from '../../../../../docs/cabin-design/assets/motion-sheet-salute.png'
import motionCommand from '../../../../../docs/cabin-design/assets/motion-sheet-command.png'
import motionTyping from '../../../../../docs/cabin-design/assets/motion-sheet-typing.png'

import fallbackIdle from '../../../../../docs/cabin-design/assets/sheet-idle.png'
import fallbackWorking from '../../../../../docs/cabin-design/assets/sheet-working.png'
import fallbackThinking from '../../../../../docs/cabin-design/assets/sheet-thinking.png'
import fallbackAlert from '../../../../../docs/cabin-design/assets/sheet-alert.png'
import fallbackWorried from '../../../../../docs/cabin-design/assets/sheet-worried.png'
import fallbackHappy from '../../../../../docs/cabin-design/assets/sheet-happy.png'
import fallbackCheer from '../../../../../docs/cabin-design/assets/sheet-cheer.png'
import fallbackWink from '../../../../../docs/cabin-design/assets/sheet-wink.png'
import fallbackSleep from '../../../../../docs/cabin-design/assets/sheet-sleep.png'
import fallbackSalute from '../../../../../docs/cabin-design/assets/sheet-salute.png'
import fallbackCommand from '../../../../../docs/cabin-design/assets/sheet-command.png'
import fallbackTyping from '../../../../../docs/cabin-design/assets/sheet-typing.png'

import thumbIdle from '../../../../../docs/cabin-design/assets/pose-idle.png'
import thumbWorking from '../../../../../docs/cabin-design/assets/pose-working.png'
import thumbThinking from '../../../../../docs/cabin-design/assets/pose-thinking.png'
import thumbAlert from '../../../../../docs/cabin-design/assets/pose-alert.png'
import thumbWorried from '../../../../../docs/cabin-design/assets/pose-worried.png'
import thumbHappy from '../../../../../docs/cabin-design/assets/pose-happy.png'
import thumbCheer from '../../../../../docs/cabin-design/assets/pose-cheer.png'
import thumbWink from '../../../../../docs/cabin-design/assets/pose-wink.png'
import thumbSleep from '../../../../../docs/cabin-design/assets/pose-sleep.png'
import thumbSalute from '../../../../../docs/cabin-design/assets/pose-salute.png'
import thumbCommand from '../../../../../docs/cabin-design/assets/pose-command.png'
import thumbTyping from '../../../../../docs/cabin-design/assets/pose-typing.png'

export type PoseKey =
  | 'idle' | 'working' | 'thinking' | 'alert' | 'worried' | 'happy'
  | 'cheer' | 'wink' | 'sleep' | 'salute' | 'command' | 'typing'

export const POSE_ORDER: readonly PoseKey[] = [
  'idle', 'working', 'thinking', 'alert', 'worried', 'happy',
  'cheer', 'wink', 'sleep', 'salute', 'command', 'typing',
]

export interface PoseMeta {
  cn: string
  en: string
  desc: string
  line: string
  fps: number
  fx: string
}

export const POSE_META: Record<PoseKey, PoseMeta> = {
  idle: { cn: '待命', en: 'IDLE', desc: '静默呼吸', line: '汐音待命，舱里一切正常。', fps: 10, fx: 'bubble' },
  working: { cn: '作业', en: 'WORK', desc: '盯执行', line: '盯着呢，执行一有动静我就报。', fps: 12, fx: 'spark' },
  thinking: { cn: '思考', en: 'THINK', desc: '整理证据', line: '让我把证据理一理……', fps: 8, fx: 'bubble' },
  alert: { cn: '警觉', en: 'ALERT', desc: '异常举牌', line: '有回流！看编队。', fps: 10, fx: 'ring' },
  worried: { cn: '担忧', en: 'WORRY', desc: '现场冻结', line: '这条有点险，我先冻住现场。', fps: 8, fx: 'sweat' },
  happy: { cn: '愉悦', en: 'HAPPY', desc: '消项回执', line: '记下了，这就交代下去。', fps: 12, fx: 'heart' },
  cheer: { cn: '振奋', en: 'CHEER', desc: '验收欢呼', line: '验收通过！漂亮！', fps: 14, fx: 'confetti' },
  wink: { cn: '俏皮', en: 'WINK', desc: '眨眼', line: '我在。你说。', fps: 10, fx: 'spark' },
  sleep: { cn: '休眠', en: 'SLEEP', desc: '久置打盹', line: '（打盹）……有回流叫我。', fps: 6, fx: 'zzz' },
  salute: { cn: '敬礼', en: 'SALUTE', desc: '接管报到', line: '汐音报到，舰桥接管完毕，全舱正常。', fps: 8, fx: 'shine' },
  command: { cn: '指挥', en: 'COMMAND', desc: '派单 / relay', line: '派下去了，doer 接手。', fps: 12, fx: 'beam' },
  typing: { cn: '键入', en: 'TYPE', desc: '全息键盘', line: '（全息键盘敲击中……）', fps: 16, fx: 'keys' },
}

/** mood → pose：boot 用敬礼报到；其余同名。 */
export const MOOD_POSE: Record<MoodKey, PoseKey> = {
  boot: 'salute',
  idle: 'idle',
  working: 'working',
  alert: 'alert',
  happy: 'happy',
  sleep: 'sleep',
  thinking: 'thinking',
  cheer: 'cheer',
  wink: 'wink',
  worried: 'worried',
}

/** 动作姿态期间 mood 不覆盖 pose（design 29 §9.1）；结束回落 mood pose。 */
export const ACTION_POSES: readonly PoseKey[] = ['cheer', 'command', 'salute']

export const MOTION_SHEETS: Record<PoseKey, string> = {
  idle: motionIdle, working: motionWorking, thinking: motionThinking, alert: motionAlert,
  worried: motionWorried, happy: motionHappy, cheer: motionCheer, wink: motionWink,
  sleep: motionSleep, salute: motionSalute, command: motionCommand, typing: motionTyping,
}

export const FALLBACK_SHEETS: Record<PoseKey, string> = {
  idle: fallbackIdle, working: fallbackWorking, thinking: fallbackThinking, alert: fallbackAlert,
  worried: fallbackWorried, happy: fallbackHappy, cheer: fallbackCheer, wink: fallbackWink,
  sleep: fallbackSleep, salute: fallbackSalute, command: fallbackCommand, typing: fallbackTyping,
}

export const POSE_THUMBS: Record<PoseKey, string> = {
  idle: thumbIdle, working: thumbWorking, thinking: thumbThinking, alert: thumbAlert,
  worried: thumbWorried, happy: thumbHappy, cheer: thumbCheer, wink: thumbWink,
  sleep: thumbSleep, salute: thumbSalute, command: thumbCommand, typing: thumbTyping,
}

export const MOTION_FRAMES = 12
export const FALLBACK_FRAMES = 2
/** 回退双帧的步频（防眨闪，design 29 §9.3）。 */
export const FALLBACK_FPS = 1.6
