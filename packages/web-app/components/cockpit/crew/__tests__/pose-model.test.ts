// v21 姿态模型单测：12 套新键 + mood 双向映射 + 静态阶段帧数。
// 立绘真源在 docs/cabin-design/assets（vite 把 png import 变成 URL 字符串）。

import { describe, it, expect } from 'vitest'
import {
  ACTION_POSES,
  FALLBACK_SHEETS,
  MOTION_SHEETS,
  MOOD_POSE,
  POSE_META,
  POSE_MOOD,
  POSE_ORDER,
  POSE_SRC,
  POSE_THUMBS,
  fallbackSource,
  framesFor,
  poseSource,
  type PoseFx,
  type PoseKey,
} from '../pose-model'

const V21_KEYS: PoseKey[] = [
  'idle', 'working', 'thinking', 'alert', 'smile', 'concerned',
  'cheer', 'wink', 'sleep', 'ready', 'command', 'typing',
]

const FX: PoseFx[] = [
  'none', 'ambient', 'spark', 'bubble', 'sweat', 'heart',
  'confetti', 'sparkle', 'zzz', 'shine', 'beam', 'keys',
]

describe('pose-model · v21 12 套立绘', () => {
  it('图鉴顺序 = 12 个新键，旧键（happy/worried/salute）已剔除', () => {
    expect(POSE_ORDER).toEqual(V21_KEYS)
    expect(new Set(POSE_ORDER).size).toBe(12)
    for (const gone of ['happy', 'worried', 'salute']) {
      expect(POSE_ORDER as readonly string[]).not.toContain(gone)
    }
  })

  it('每个姿态都有元数据、单帧资产、缩略图与粒子效果', () => {
    for (const key of POSE_ORDER) {
      const meta = POSE_META[key]
      expect(meta, key).toBeTruthy()
      expect(meta.cn.length, key).toBeGreaterThan(0)
      expect(meta.en.length, key).toBeGreaterThan(0)
      expect(meta.line.length, key).toBeGreaterThan(0)
      expect(meta.fps, key).toBeGreaterThan(0)
      expect(FX, key).toContain(meta.fx)
      expect(POSE_SRC[key], key).toMatch(/pose-.+\.png/)
      expect(POSE_THUMBS[key], key).toBe(POSE_SRC[key])
    }
  })

  it('mood → pose：happy→smile、worried→concerned、boot→idle（开机待命）', () => {
    expect(MOOD_POSE.happy).toBe('smile')
    expect(MOOD_POSE.worried).toBe('concerned')
    expect(MOOD_POSE.boot).toBe('idle')
    expect(MOOD_POSE.sleep).toBe('sleep')
  })

  it('pose → mood：反向映射回到语义 mood 键（数据层不改名）', () => {
    expect(POSE_MOOD.smile).toBe('happy')
    expect(POSE_MOOD.concerned).toBe('worried')
    expect(POSE_MOOD.ready).toBe('boot')
    expect(POSE_MOOD.command).toBe('working')
    expect(POSE_MOOD.typing).toBe('working')
    for (const key of POSE_ORDER) expect(POSE_MOOD[key], key).toBeTruthy()
  })

  it('动作姿态 = cheer / command / ready（敬礼换成待令）', () => {
    expect(ACTION_POSES).toEqual(['cheer', 'command', 'ready'])
  })

  it('静态阶段：motion/fallback 为空 → 全部单帧，回退链已到终点', () => {
    expect(Object.keys(MOTION_SHEETS)).toHaveLength(0)
    expect(Object.keys(FALLBACK_SHEETS)).toHaveLength(0)
    for (const key of POSE_ORDER) {
      expect(framesFor(key), key).toBe(1)
      const source = poseSource(key)
      expect(source.frames, key).toBe(1)
      expect(source.src, key).toBe(POSE_SRC[key])
      expect(fallbackSource(key, source.src), key).toBeNull()
    }
  })
})
