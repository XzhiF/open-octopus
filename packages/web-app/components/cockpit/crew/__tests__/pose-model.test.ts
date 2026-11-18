// v22 姿态/片段模型单测：13 支视频片段 + 12 个语义姿态 + mood 双向映射。
// 立绘真源在 docs/cabin-design/assets/v22（vite 把 webm/png import 变成 URL 字符串）。

import { describe, it, expect, vi } from 'vitest'
import {
  ACTION_POSES,
  AMBIENT_CLIPS,
  CLIPS,
  MOOD_POSE,
  POSE_CLIP,
  POSE_CLIP_VARIANTS,
  POSE_META,
  POSE_MOOD,
  POSE_ORDER,
  POSE_SRC,
  clipPose,
  clipVariants,
  nextAmbientClip,
  nextClip,
  poseClip,
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

describe('pose-model · v22 纯视频立绘', () => {
  it('图鉴顺序 = 12 个新键，旧键（happy/worried/salute）已剔除', () => {
    expect(POSE_ORDER).toEqual(V21_KEYS)
    expect(new Set(POSE_ORDER).size).toBe(12)
    for (const gone of ['happy', 'worried', 'salute']) {
      expect(POSE_ORDER as readonly string[]).not.toContain(gone)
    }
  })

  it('13 支片段 = 用户指定顺序（旧 3 + 新 10，重复姿态各自保留）', () => {
    expect(CLIPS).toHaveLength(13)
    expect(CLIPS.map((c) => c.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(CLIPS.map((c) => c.pose)).toEqual([
      'wink', 'thinking', 'command',
      'alert', 'concerned', 'command', 'idle', 'ready', 'smile', 'thinking', 'typing', 'wink', 'working',
    ])
    expect(CLIPS.filter((c) => c.batch === '旧')).toHaveLength(3)
    expect(CLIPS.filter((c) => c.batch === '新')).toHaveLength(10)
    // command / thinking / wink 各出现两次（图鉴不合并）。
    for (const dup of ['command', 'thinking', 'wink'] as PoseKey[]) {
      expect(CLIPS.filter((c) => c.pose === dup), dup).toHaveLength(2)
    }
  })

  it('每支片段都有 webm 与缩略图 URL，序号与文件名对齐', () => {
    for (const [index, clip] of CLIPS.entries()) {
      expect(clip.src, String(clip.no)).toMatch(/v22\/\d{2}-[a-z]+\.webm$/)
      expect(clip.thumb, String(clip.no)).toMatch(/v22\/thumbs\/\d{2}-[a-z]+\.png$/)
      expect(clip.src).toContain(`${String(index + 1).padStart(2, '0')}-${clip.pose}.webm`)
      expect(clip.thumb).toContain(`${String(index + 1).padStart(2, '0')}-${clip.pose}.png`)
    }
  })

  it('每个姿态都有元数据、兜底静图与粒子效果', () => {
    for (const key of POSE_ORDER) {
      const meta = POSE_META[key]
      expect(meta, key).toBeTruthy()
      expect(meta.cn.length, key).toBeGreaterThan(0)
      expect(meta.en.length, key).toBeGreaterThan(0)
      expect(meta.line.length, key).toBeGreaterThan(0)
      expect(meta.fps, key).toBeGreaterThan(0)
      expect(FX, key).toContain(meta.fx)
      expect(POSE_SRC[key], key).toMatch(/pose-.+\.png/)
    }
  })

  it('pose → 片段：12 个姿态都落在有效下标；重复姿态取最早一支', () => {
    for (const key of POSE_ORDER) {
      const index = poseClip(key)
      expect(index, key).toBeGreaterThanOrEqual(0)
      expect(index, key).toBeLessThan(CLIPS.length)
      expect(POSE_CLIP[key], key).toBe(index)
    }
    expect(poseClip('wink')).toBe(0)
    expect(poseClip('thinking')).toBe(1)
    expect(poseClip('command')).toBe(2)
    // 没有专属片段的姿态落到语义最近的片段。
    expect(poseClip('cheer')).toBe(poseClip('smile'))
    expect(poseClip('sleep')).toBe(poseClip('idle'))
    expect(clipPose(poseClip('ready'))).toBe('ready')
  })

  it('片段回环：nextClip 13 → 0，-1 → 12', () => {
    expect(nextClip(12)).toBe(0)
    expect(nextClip(0, -1)).toBe(12)
    expect(nextClip(5, 3)).toBe(8)
  })

  it('重复姿态有变体：动作事件可在两支之间交替', () => {
    expect(POSE_CLIP_VARIANTS.command).toEqual([2, 5])
    expect(POSE_CLIP_VARIANTS.thinking).toEqual([1, 9])
    expect(POSE_CLIP_VARIANTS.wink).toEqual([0, 11])
    expect(clipVariants('command')).toEqual([2, 5])
    expect(clipVariants('alert')).toEqual([3])
    expect(clipVariants('cheer')).toEqual([8])
    for (const key of POSE_ORDER) {
      const variants = clipVariants(key)
      expect(variants.length, key).toBeGreaterThan(0)
      for (const index of variants) expect(CLIPS[index], key).toBeTruthy()
    }
  })

  it('待命自走池只含日常片段，且不会连续重复当前段', () => {
    // alert / concerned / typing 是强事件语义，不进自走池。
    expect(AMBIENT_CLIPS).not.toContain(3)
    expect(AMBIENT_CLIPS).not.toContain(4)
    expect(AMBIENT_CLIPS).not.toContain(10)
    expect(AMBIENT_CLIPS).toContain(6)

    const spy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const first = AMBIENT_CLIPS.find((index) => index !== 6)
      expect(nextAmbientClip(6)).toBe(first)
      expect(nextAmbientClip(6)).not.toBe(6)
      spy.mockReturnValue(0.999)
      expect(nextAmbientClip(6)).not.toBe(6)
    } finally {
      spy.mockRestore()
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
})
