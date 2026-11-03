// packages/web-app/lib/agent/work-phrases.ts
//
// 流尾工作行的状态词（2026-10-29 用户）：不要一直冷冰冰的「思考中 / 执行工具 /
// 输出中」——像其他 coding agent 一样，干活时给点人味，偶尔轻轻调侃一句。
// 2026-11-03 用户：普通句保留，修仙风味句再加一倍，每阶段 6 → 18 句。
//
// 规则：
//   · 按阶段分组（阶段语义仍可辨），每 WORK_PHRASE_ROTATE_SECONDS 秒换一句；
//   · 数组按「普通句、修仙句、修仙句」三句一组交错排列——约 12 秒内必轮到一句
//     修仙的，不用先看半分钟普通句；
//   · 每轮用回合起点做种子的 Fisher-Yates 洗牌（2026-11-03 用户：顺序太固定）：
//     seed 相同 → 顺序相同（同一轮内稳定、切走再切回不跳），seed 不同 → 顺序变
//     （每轮开头不一样，短回合也能看到不同句子）；不逐秒随机，避免闪烁；
//   · 每句都很短（≤12 字），右侧紧跟 h/m/s 计时。

export type WorkPhase = 'thinking' | 'exec' | 'writing'

export const WORK_PHRASES: Record<WorkPhase, readonly string[]> = {
  thinking: [
    // 普通 · 修仙 · 修仙 交错
    '脑内推演中…',
    '掐指一算，掐空了…',
    '元神出窍查资料…',
    '正在跟需求对视…',
    '灵台推演天机…',
    '入定，勿扰…',
    '琢磨着呢…',
    '神识扫描中…',
    '内视周天中…',
    '挠头中…',
    '打坐参悟需求…',
    '翻开无字天书…',
    '让想象力跑一会儿…',
    '向祖师爷借个思路…',
    '灵气不足，硬想…',
    '这题有点意思…',
    '渡劫般梳理逻辑…',
    '和心魔辩论中…',
  ],
  exec: [
    '动手了…',
    '催动法器…',
    '开炉炼器…',
    '正在敲敲打打…',
    '引雷淬体…',
    '搬运灵气中…',
    '跟终端商量中…',
    '施展袖里乾坤…',
    '给天道打个补丁…',
    '正在翻箱倒柜…',
    '御剑去改文件…',
    '炼丹炉火正旺…',
    '和文件较劲中…',
    '布阵中，别踩线…',
    '和法宝谈条件…',
    '真没摸鱼，在干活…',
    '渡劫式跑测试…',
    '搬砖，哦不，搬山…',
  ],
  writing: [
    '落笔中…',
    '以文入道…',
    '刻录玉简…',
    '码字中…',
    '笔下生莲…',
    '心法吐真言…',
    '正在组织语言…',
    '灵气化墨…',
    '大道至简，先写…',
    '把想法翻译成人话…',
    '写篇大道真解…',
    '落笔惊动雷劫…',
    '键盘都要冒烟了…',
    '正在凝聚道韵…',
    '字字带修为…',
    '别催，在写了…',
    '写不好就重修…',
    '给答案开个光…',
  ],
}

/** 每 6 秒轮换一句：够慢到读得完，够快到不无聊。 */
export const WORK_PHRASE_ROTATE_SECONDS = 6

/** mulberry32：32 位种子 PRNG，纯函数、跨平台一致（不用 Math.random，保证同 seed 同结果）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 按 seed 洗出该阶段的展示顺序；seed 为 0 时保持原数组顺序（旧行为/测试基线）。 */
function orderedPhrases(phase: WorkPhase, seed: number): readonly string[] {
  const list = WORK_PHRASES[phase]
  if (!seed) return list
  const out = list.slice()
  const rand = mulberry32(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * 当前该显示哪一句（elapsedSeconds = 整轮已耗时，取整秒）。
 * seed = 本轮起点（建议传 turnStartedAt）；同一轮内不变 → 顺序稳定，
 * 不同轮不同 → 每轮开头换一句。不传 seed 时按原数组顺序轮换。
 */
export function workPhrase(phase: WorkPhase, elapsedSeconds: number, seed = 0): string {
  const list = orderedPhrases(phase, seed)
  const bucket = Math.max(0, Math.floor(elapsedSeconds / WORK_PHRASE_ROTATE_SECONDS))
  return list[bucket % list.length]
}