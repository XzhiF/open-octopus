// 舱内音效（WebAudio 合成 · 无外部素材 · 首次手势后启动）。逐字对照原型
// docs/cabin-design/index.html AudioEngine（1647-1657）：环境低鸣（55Hz sine +
// 82.4Hz triangle 经 lowpass + LFO）+ 操作 blip + 成功 chime。sound pref 控制总开关。

type OscType = OscillatorType

class CabinAudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private enabled = true
  private ambient = false

  private ensure(): void {
    if (this.ctx || typeof window === 'undefined') return
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      this.ctx = new AC()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.enabled ? 0.5 : 0
      this.master.connect(this.ctx.destination)
      this.startAmbient()
    } catch { /* WebAudio 不可用 → 静默降级 */ }
  }

  resume(): void {
    this.ensure()
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
  }

  private startAmbient(): void {
    const c = this.ctx
    if (!c || !this.master || this.ambient) return
    this.ambient = true
    const g = c.createGain(); g.gain.value = 0.045
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 200
    const o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = 55
    const o2 = c.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 82.4
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07
    const lg = c.createGain(); lg.gain.value = 55
    lfo.connect(lg); lg.connect(f.frequency)
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(this.master)
    o1.start(); o2.start(); lfo.start()
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