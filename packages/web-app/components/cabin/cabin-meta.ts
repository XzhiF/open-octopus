// 舱 UI 元数据：状态/attention 阶段展示词表 + 原型 dock 模块清单（DOCK_MOD /
// DOCK_PRIMARY / WIN_TITLE 对照 docs/cabin-design/index.html:1278-1280,1341）。
// 纯展示映射，不含业务派生（attention/health/进度一律来自服务端 CabinView，K3）。

import type { CabinStatus, CabinAttentionItem } from '@octopus/shared'

export const CABIN_STATUS_META: Record<CabinStatus, { label: string; dot: string; badge: string }> = {
  draft: { label: '草稿', dot: 'bg-pop-cyan', badge: 'border-pop-bd text-pop-dim' },
  initializing: { label: '初始化', dot: 'bg-pop-amber animate-pulse', badge: 'border-pop-amber/50 text-pop-amber' },
  active: { label: '活跃', dot: 'bg-pop-green', badge: 'border-pop-green/50 text-pop-green' },
  dormant: { label: '休眠', dot: 'bg-pop-cyan', badge: 'border-pop-cyan/50 text-pop-cyan' },
  archived: { label: '封存', dot: 'bg-pop-dim/50', badge: 'border-pop-bd text-pop-dim' },
}

export const ATTENTION_STAGE_META: Record<CabinAttentionItem['stage'], { label: string; tone: string }> = {
  review: { label: '验收', tone: 'border-pop-green/50 text-pop-green' },
  answer: { label: '回答', tone: 'border-pop-cyan/50 text-pop-cyan' },
  adjudicate: { label: '裁决', tone: 'border-pop-amber/50 text-pop-amber' },
  approval: { label: '审批', tone: 'border-pop-yellow/60 text-pop-yellow' },
  blocked: { label: '阻塞', tone: 'border-pop-red/50 text-pop-red' },
}

export const ATTENTION_AWAITING_META: Record<CabinAttentionItem['awaiting'], { label: string; tone: string }> = {
  person: { label: '等你', tone: 'bg-pop-yellow text-pop-bg' },
  working: { label: '运行中', tone: 'bg-pop-cyan/20 text-pop-cyan' },
  idle: { label: '空闲', tone: 'bg-white/[0.06] text-pop-dim' },
  ended: { label: '已结束', tone: 'bg-white/[0.06] text-pop-dim' },
}

/** 原型 WIN_TITLE：浮窗标题。 */
export const CABIN_WIN_TITLE: Record<string, string> = {
  overview: '概览',
  queue: '通讯队列',
  engineering: '工程',
  records: '记录',
  tasks: '任务',
  iterations: '迭代',
  job: '作业详情',
  missions: '作战清单',
  run: '运行',
  tuning: '舱面调校',
  gallery: '汐音立绘',
  usage: '消耗',
}

/** 模块落地阶段（仅占位窗使用；当前可达模块均已实装）。 */
export const CABIN_MODULE_PHASE: Record<string, string> = {
  overview: 'P2',
  queue: 'P3',
  engineering: 'P6',
  records: 'P6',
  tasks: 'P3',
  iterations: 'P4',
  job: 'P6',
  missions: 'P4',
  run: 'P3',
  tuning: 'P5',
  gallery: 'P5',
  usage: 'P4',
}

/** classic-v3：作业坞只留「概览」一个舱模块 —— 任务/工程/记录从概览三入口进入。 */
export const CABIN_DOCK_PRIMARY = ['overview'] as const

/** classic-v3：不再有「更多模块」溢出格。 */
export const CABIN_DOCK_OVERFLOW: readonly string[] = []

/** 原型 WIN_SIZE：浮窗默认尺寸 [w,h]（docs/cabin-design/classic-v3.html）。 */
export const CABIN_WIN_SIZE: Record<string, [number, number]> = {
  overview: [780, 640],
  queue: [720, 640],
  engineering: [860, 620],
  records: [860, 620],
  tasks: [960, 620],
  iterations: [900, 620],
  job: [900, 700],
  missions: [620, 560],
  run: [900, 640],
  tuning: [560, 660],
  gallery: [780, 660],
  usage: [680, 560],
}

/** 门禁 deep_link（模块 key）→ 舱浮窗 id。未知 key 不开窗（回对话）。 */
export function cabinModuleForDeepLink(deepLink: string | undefined): string | null {
  if (deepLink === 'repos') return 'engineering'
  if (deepLink === 'settings') return 'tuning'
  return null
}