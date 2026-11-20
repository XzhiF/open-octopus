import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  __resetBootHandover,
  bootCoversEntrance,
  enterBootLayer,
  leaveBootLayer,
  notifyRealSpriteLive,
  onRealSpriteLive,
} from '../boot-handover'

describe('boot-handover · 门禁期 boot 立绘的状态', () => {
  beforeEach(() => __resetBootHandover())

  it('boot 层在屏才算「盖着出场」；卸载后恢复', () => {
    expect(bootCoversEntrance()).toBe(false)
    enterBootLayer()
    expect(bootCoversEntrance()).toBe(true)
    leaveBootLayer()
    expect(bootCoversEntrance()).toBe(false)
  })

  it('真立绘首帧可画 → 通知所有订阅者；退订后不再收到', () => {
    const first = vi.fn()
    const second = vi.fn()
    const off = onRealSpriteLive(first)
    onRealSpriteLive(second)

    notifyRealSpriteLive()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    off()
    notifyRealSpriteLive()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })
})
