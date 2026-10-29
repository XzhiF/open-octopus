// packages/web-app/lib/agent/work-phrases.ts
//
// 流尾工作行的状态词（2026-10-29 用户）：不要一直冷冰冰的「思考中 / 执行工具 /
// 输出中」——像其他 coding agent 一样，干活时给点人味，偶尔轻轻调侃一句。
//
// 规则：
//   · 按阶段分组（阶段语义仍可辨），每 WORK_PHRASE_ROTATE_SECONDS 秒换一句；
//   · 纯函数 + 按耗时取桶 → 同一秒内稳定，不会随机闪烁；
//   · 每句都很短（≤12 字），右侧紧跟秒级计时。

export type WorkPhase = 'thinking' | 'exec' | 'writing'

export const WORK_PHRASES: Record<WorkPhase, readonly string[]> = {
  thinking: [
    '脑内推演中…',
    '正在跟需求对视…',
    '琢磨着呢…',
    '挠头中…',
    '让想象力跑一会儿…',
    '这题有点意思…',
  ],
  exec: [
    '动手了…',
    '正在敲敲打打…',
    '跟终端商量中…',
    '正在翻箱倒柜…',
    '和文件较劲中…',
    '真没摸鱼，在干活…',
  ],
  writing: [
    '落笔中…',
    '码字中…',
    '正在组织语言…',
    '把想法翻译成人话…',
    '键盘都要冒烟了…',
    '别催，在写了…',
  ],
}

/** 每 6 秒轮换一句：够慢到读得完，够快到不无聊。 */
export const WORK_PHRASE_ROTATE_SECONDS = 6

/** 当前该显示哪一句（elapsedSeconds = 整轮已耗时，取整秒）。 */
export function workPhrase(phase: WorkPhase, elapsedSeconds: number): string {
  const list = WORK_PHRASES[phase]
  const bucket = Math.max(0, Math.floor(elapsedSeconds / WORK_PHRASE_ROTATE_SECONDS))
  return list[bucket % list.length]
}
