// 驾驶舱纯数据 + 派生（K3：mood 由 view 派生，绝不落库）。逐字对照原型
// docs/cabin-design/index.html 的 THEMES / DEFAULT_COCKPIT / CREW / XY_FORMS /
// XY_ICON / XY_LINES / HRANGES / crewState（1532-1764）。prefs 经 cockpit_prefs
// 持久化（autonomy 是行为键，cabin-tools 读取）；其余为舱面氛围 cosmetic。

import type { CabinStatus } from '@octopus/shared'

export type CockpitTheme = 'terminal' | 'hyperion' | 'luna' | 'amber' | 'acid' | 'crimson'
export type CockpitFloat = 'glass' | 'solid' | 'holo'
export type CabinAutonomy = 'off' | 'observe' | 'auto'
export type MoodKey = 'boot' | 'idle' | 'working' | 'alert' | 'happy' | 'sleep' | 'thinking' | 'cheer' | 'wink' | 'worried'
export type CabinMood = 'auto' | MoodKey

export interface CockpitPrefs {
  theme: CockpitTheme
  float: CockpitFloat
  floatAmp: number
  hud: boolean
  scan: number
  grid: number
  glow: number
  particles: number
  blur: number
  charScale: number
  mood: CabinMood
  sound: boolean
  autonomy: CabinAutonomy
  /** C11 自动休眠阈值（分钟）；0 = 关闭自动休眠。 */
  dormantMinutes: number
}

export const THEMES: Record<CockpitTheme, { name: string; a: string; b: string; c: string }> = {
  terminal: { name: '净黑终端', a: '#4FD1D9', b: '#A78BFA', c: '#FF855C' },
  hyperion: { name: '休伯利安', a: '#38BDF8', b: '#60A5FA', c: '#FFC857' },
  luna: { name: '月光王座', a: '#D2A8FF', b: '#F472B6', c: '#FFC857' },
  amber: { name: '琥珀纪元', a: '#FFC857', b: '#FF855C', c: '#4FD1D9' },
  acid: { name: '酸性绿', a: '#A3E635', b: '#7EE787', c: '#4FD1D9' },
  crimson: { name: '赤鸢', a: '#FF5C5C', b: '#F472B6', c: '#FFC857' },
}

export const DEFAULT_COCKPIT: CockpitPrefs = {
  theme: 'terminal', float: 'glass', floatAmp: 5, hud: true, scan: 5, grid: 30,
  glow: 1, particles: 18, blur: 3, charScale: 1, mood: 'auto', sound: true,
  autonomy: 'auto', dormantMinutes: 30,
}

export interface HRange { k: keyof CockpitPrefs; label: string; min: number; max: number; step: number }
export const HRANGES: HRange[] = [
  { k: 'floatAmp', label: '悬浮幅度', min: 0, max: 10, step: 1 },
  { k: 'scan', label: '扫描速度', min: 0, max: 10, step: 1 },
  { k: 'grid', label: '网格密度', min: 12, max: 60, step: 2 },
  { k: 'glow', label: '辉光', min: 0, max: 2, step: 0.1 },
  { k: 'particles', label: '粒子', min: 0, max: 60, step: 1 },
  { k: 'blur', label: '氛围模糊', min: 0, max: 12, step: 1 },
  { k: 'charScale', label: '角色大小', min: 0.6, max: 1.5, step: 0.05 },
]

export const CREW: Record<MoodKey, { label: string; speech: string }> = {
  boot: { label: '初始化', speech: '正在点亮舱系统…' },
  working: { label: '运行中', speech: '盯着工作流呢，放心 ✦' },
  alert: { label: '需要你', speech: '有 %n 件事等你裁决！' },
  happy: { label: '完成', speech: '搞定啦 ✦ 干得漂亮' },
  sleep: { label: '休眠', speech: '舱在休眠 · 随时唤醒我' },
  idle: { label: '待命', speech: '待命 · 下达指令吧' },
  thinking: { label: '思考', speech: '让我推演一下方案…' },
  cheer: { label: '庆祝', speech: '耶！又下一城 ✦' },
  wink: { label: '俏皮', speech: '指挥官，看这边 ✦' },
  worried: { label: '担心', speech: '这里有点不对劲…' },
}

export const XY_FORMS: { k: MoodKey; name: string; tag: string; desc: string }[] = [
  { k: 'idle', name: '待命', tag: 'IDLE', desc: '随时待命，下达指令吧' },
  { k: 'working', name: '运行', tag: 'RUN', desc: '盯着工作流呢，放心' },
  { k: 'alert', name: '需要你', tag: 'ALERT', desc: '有事等你裁决！' },
  { k: 'happy', name: '完成', tag: 'DONE', desc: '搞定啦 ✦ 干得漂亮' },
  { k: 'sleep', name: '休眠', tag: 'SLEEP', desc: '舱在休眠 · 随时唤醒我' },
  { k: 'thinking', name: '思考', tag: 'THINK', desc: '正在推演方案…' },
  { k: 'cheer', name: '庆祝', tag: 'CHEER', desc: '耶！又下一城 ✦' },
  { k: 'wink', name: '俏皮', tag: 'WINK', desc: '指挥官，看这边 ✦' },
  { k: 'worried', name: '担心', tag: 'CARE', desc: '这里有点不对劲…' },
]

export const XY_ICON: Record<MoodKey, string> = {
  idle: '✦', working: '⚡', alert: '❗', happy: '✅', cheer: '🎉', sleep: '💤',
  boot: '⌛', thinking: '💭', wink: '✨', worried: '💦',
}

export const XY_LINES: [string, MoodKey][] = [
  ['指挥官，我在。主 chat 负责下达指令，我负责把消息和待办整理好给你。', 'idle'],
  ['今天的工作树都在并行推进，有回流我会第一时间报给你 ✦', 'working'],
  ['需要验收或裁决时，我会举牌提醒——你只管在主 chat 拍板。', 'alert'],
  ['搞定啦 ✦ 这一轮干得漂亮，给你比个心！', 'cheer'],
  ['指挥官，看这边 ✦ 去画廊看看我别的表情吧？', 'wink'],
  ['嗯…让我推演一下接下来的方案。', 'thinking'],
  ['这里有点不对劲，我已经标记出来了，等你裁决。', 'worried'],
  ['舱面一切正常。想看我别的表情，就多点我几下吧。', 'happy'],
  ['助理汐音，随时待命。把密集的信息交给我，你专注指挥就好。', 'idle'],
]

export const MOOD_OPTIONS: [CabinMood, string][] = [
  ['auto', '自动'], ['working', '运行'], ['alert', '需要你'], ['happy', '完成'],
  ['sleep', '休眠'], ['idle', '待命'], ['boot', '初始化'], ['thinking', '思考'],
  ['cheer', '庆祝'], ['wink', '俏皮'], ['worried', '担心'],
]

/** boot 无独立立绘 → 复用 thinking（原型 XY_IMG.boot=XY_IMG.thinking）。 */
export function moodPortrait(mood: MoodKey): string {
  // 文件名即 mood 语义（对照 docs/cabin-design/index.html 的 XY_IMG）。
  // 2026-11-13：P5 曾把这批 PNG 循环改名（idle 拿到了 alert 的立绘），
  // 已按原型顺序还原；再动这些文件前先做逐 mood 对图，别批量 rename。
  return `/cabin/xiyin-${mood === 'boot' ? 'thinking' : mood}.png`
}

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 合并默认 + 服务端 prefs，逐键校验范围/枚举（malformed → 默认，绝不抛）。 */
export function normalizePrefs(raw: unknown): CockpitPrefs {
  const p = (raw ?? {}) as Record<string, unknown>
  const theme = (typeof p.theme === 'string' && p.theme in THEMES ? p.theme : DEFAULT_COCKPIT.theme) as CockpitTheme
  const float = (p.float === 'glass' || p.float === 'solid' || p.float === 'holo' ? p.float : DEFAULT_COCKPIT.float) as CockpitFloat
  const autonomy = (p.autonomy === 'off' || p.autonomy === 'observe' || p.autonomy === 'auto' ? p.autonomy : DEFAULT_COCKPIT.autonomy) as CabinAutonomy
  const mood = (typeof p.mood === 'string' && (p.mood === 'auto' || p.mood in CREW) ? p.mood : DEFAULT_COCKPIT.mood) as CabinMood
  return {
    theme, float, autonomy, mood,
    floatAmp: clamp(p.floatAmp, 0, 10, DEFAULT_COCKPIT.floatAmp),
    hud: typeof p.hud === 'boolean' ? p.hud : DEFAULT_COCKPIT.hud,
    scan: clamp(p.scan, 0, 10, DEFAULT_COCKPIT.scan),
    grid: clamp(p.grid, 12, 60, DEFAULT_COCKPIT.grid),
    glow: clamp(p.glow, 0, 2, DEFAULT_COCKPIT.glow),
    particles: clamp(p.particles, 0, 60, DEFAULT_COCKPIT.particles),
    blur: clamp(p.blur, 0, 12, DEFAULT_COCKPIT.blur),
    charScale: clamp(p.charScale, 0.6, 1.5, DEFAULT_COCKPIT.charScale),
    sound: typeof p.sound === 'boolean' ? p.sound : DEFAULT_COCKPIT.sound,
    dormantMinutes: clamp(p.dormantMinutes, 0, 1440, DEFAULT_COCKPIT.dormantMinutes),
  }
}

/** --ck-* 变量（原型 applyCockpit 1549-1559）。 */
export function cockpitCssVars(prefs: CockpitPrefs): Record<string, string> {
  const th = THEMES[prefs.theme] ?? THEMES.terminal
  return {
    '--ck-a': th.a, '--ck-b': th.b, '--ck-c': th.c,
    '--ck-glow': String(prefs.glow),
    '--ck-grid': `${prefs.grid}px`,
    '--ck-blur': `${prefs.blur}px`,
    '--ck-float': `${prefs.floatAmp}px`,
    '--ck-char-scale': String(prefs.charScale),
    '--ck-scan-dur': `${prefs.scan === 0 ? 8 : 22 - prefs.scan * 2}s`,
  }
}

export interface MoodInput {
  prefsMood: CabinMood
  override: MoodKey | null
  status: CabinStatus | undefined
  personAttention: number
  running: number
  streaming: boolean
  hasBlocked: boolean
}

/** 前端纯派生（design 07-frontend.md:38）：手动覆盖 → 瞬时 override → boot →
 *  alert → worried → working → thinking → sleep → idle。 */
export function deriveMood(input: MoodInput): MoodKey {
  if (input.prefsMood !== 'auto') return input.prefsMood
  if (input.override) return input.override
  if (!input.status) return 'idle'
  if (input.status === 'initializing') return 'boot'
  if (input.status === 'archived') return 'sleep'
  if (input.personAttention > 0) return 'alert'
  if (input.hasBlocked) return 'worried'
  if (input.running > 0) return 'working'
  if (input.streaming) return 'thinking'
  if (input.status === 'dormant') return 'sleep'
  return 'idle'
}

/** 随机一套舱面风格（原型 randomizeCockpit 1631-1637）。 */
export function randomPrefs(): CockpitPrefs {
  const keys = Object.keys(THEMES) as CockpitTheme[]
  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  const floats: CockpitFloat[] = ['glass', 'solid', 'holo']
  return {
    ...DEFAULT_COCKPIT,
    theme: keys[Math.floor(Math.random() * keys.length)],
    float: floats[Math.floor(Math.random() * 3)],
    floatAmp: Math.round(rnd(0, 10)),
    scan: Math.round(rnd(1, 10)),
    grid: Math.round(rnd(12, 60)),
    glow: +rnd(0.4, 2).toFixed(1),
    particles: Math.round(rnd(6, 50)),
    blur: Math.round(rnd(0, 10)),
    charScale: +rnd(0.7, 1.4).toFixed(2),
    mood: 'auto',
    hud: true,
  }
}