// 舱内音效（WebAudio 合成 · 无外部素材 · 首次手势后启动）。对照原型
// docs/cabin-design/index.html AudioEngine（1647-1657）：操作 blip + 成功 chime。
// 2026-11-23 用户：原型里的环境低鸣（55Hz sine + 82.4Hz triangle 持续垫音）嫌吵，
// 已整体移除；sound pref 现在只开关操作提示音。

type OscType = OscillatorType

class CabinAudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private enabled = true

  private ensure(): void {
    if (this.ctx || typeof window === 'undefined') return
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      this.ctx = new AC()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.enabled ? 0.5 : 0
      this.master.connect(this.ctx.destination)
    } catch { /* WebAudio 不可用 → 静默降级 */ }
  }

  resume(): void {
    this.ensure()
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
  }

  setOn(on: boolean): void {
    this.enabled = on
    this.resume()
    if (this.master) this.master.gain.value = on ? 0.5 : 0
  }

  blip(freq = 660, dur = 0.07, type: OscType = 'sine', vol = 0.16): void {
    if (!this.enabled) return
    this.resume()
    const c = this.ctx
    if (!c || !this.master) return
    try {
      const o = c.createOscillator(); const g = c.createGain()
      o.type = type; o.frequency.value = freq
      g.gain.setValueAtTime(0, c.currentTime)
      g.gain.linearRampToValueAtTime(vol, c.currentTime + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur)
      o.connect(g); g.connect(this.master)
      o.start(); o.stop(c.currentTime + dur + 0.02)
    } catch { /* 忽略单次合成失败 */ }
  }

  chime(): void {
    this.blip(880, 0.12, 'sine', 0.15)
    setTimeout(() => this.blip(1318, 0.16, 'sine', 0.13), 90)
  }
}

export const cabinAudio = new CabinAudioEngine()