'use client'

// v21 二轮（原型 .rmenu / .fanwrap）· 右栏主按钮组：
//   下指令（big）→ 目录 → 活动 → 消耗 → 调试 → 变更 → 更多。
// v22 九轮：「目录」取代原位的「跃迁」，打开本舱 cwd 只读目录窗（⌥F）；
//   跃迁挪进「更多」（⌥W / 点顶部场景名仍可跃迁）。
// v22 十三轮（问题 #1）：「变更」—— 本舱 cwd 的工作区改动（⌥G，只读）。
//   位置在「更多」正上方（倒数第二）；**只有 cwd 本身是独立 git 仓库时才出现**
//   （CabinDetail.cwd_git，服务端按 cabin.path 下有没有 .git 判）。
// v22 十四轮（2026-11-21 用户）：「活动」—— 汐音主会话里正在跑的子代理 /
//   后台作业（⌥V，只读）。**常住按钮**（2026-11-21 用户：不用像「变更」那样
//   按条件出现）；徽标只在有运行中活动时显示。没有活动时点开是空态。
// 「更多」= **纯点击开合**（再点收回；点外面也收），向左横排展开
// （汐音 / 动作 / 日志 / 设置）。不再用悬停开合。
// 2026-11-21 用户：生产代码不再提供「跃迁 / 模拟 / 编队」三项（原型保留）。
// v22 十五轮（2026-11-21 用户）：「对话日志」= 主会话指令时间线面板（关键词搜索 +
//   顶部统计 + 每条 prompt 的 TUI 摘要行），不再把主对话拉高。
//
// 动作全部复用既有入口（不新造面板）：账本 = ledger 面板、调试 = 本舱主会话
// debug 面板（不是某条作业）、目录 = 本舱 cwd 只读窗、动作 = poses 面板、
// 设置 = CockpitSettings 弹窗。作业自身的调试在作业面「调试」页签。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { toggleCrewSettings } from '../crew/crew-settings'
import { toggleCabinTree } from '../face/cabin-tree-store'
import { toggleChanges } from '../face/changes-store'
import { useCockpitState } from '../state/CockpitStateProvider'
import { setCockpitSettingsOpen } from '../shell/settings-store'
import { toggleActivityLog } from './activity-log-store'

const FAN_ITEMS = [
  { id: 'xiyin', glyph: '♡', label: '汐音' },
  { id: 'poses', glyph: '✧', label: '动作' },
  { id: 'log', glyph: '≡', label: '对话日志' },
  // 2026-11-24 用户 #1：全部活动（后台作业 + 子代理，运行中 + 已结束留档）。
  { id: 'actlog', glyph: '▤', label: '活动日志' },
  { id: 'settings', glyph: '⚙', label: '设置' },
] as const

export interface CockpitMenuRailProps {
  /** 运行中的活动数（子代理 + 后台作业）；只影响徽标，不影响按钮常驻。 */
  activityLive?: number
}

export function CockpitMenuRail({ activityLive = 0 }: CockpitMenuRailProps) {
  const {
    chatWindow, openPanel,
    activityOpen, openActivity, closeActivity,
  } = useCockpitState()
  const cabin = useCabinOptional()?.cabin
  /** 变更 = 本舱 cwd 这一个 git 仓库的工作区改动 —— cwd 不是独立仓就不出这个按钮。 */
  const showChanges = cabin?.cwd_git === true
  const [fanOpen, setFanOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // 点击外面收起（原型 pointerdown 监听）。
  useEffect(() => {
    if (!fanOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && wrapRef.current?.contains(target)) return
      setFanOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [fanOpen])

  /** 调试目标 = 本舱主会话（跟汐音的主 chat）。作业调试走它自己的详情页签。 */
  const openDebug = useCallback(() => openPanel('debug'), [openPanel])

  const fanAction = useCallback((id: string) => {
    setFanOpen(false)
    switch (id) {
      case 'xiyin': toggleCrewSettings(); break
      case 'poses': openPanel('poses'); break
      case 'log': openPanel('log'); break
      case 'actlog':
        // 活动日志是「全部活动」大窗：开它时顺手收回右栏浮层，避免两层叠着。
        closeActivity()
        toggleActivityLog()
        break
      case 'settings': setCockpitSettingsOpen(true); break
      default: break
    }
  }, [openPanel, closeActivity])

  const openCommand = useCallback(() => {
    chatWindow.openWithFocus()
    // 与 ⌘K 同义：展开后把焦点送进 composer（portal 槽可能在下一帧才落）。
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="cockpit-composer-slot"] textarea')
        ?.focus()
    })
  }, [chatWindow])

  return (
    <nav className="ck12-rmenu" aria-label="主菜单" data-testid="cockpit-menu-rail">
      <button
        type="button"
        className="ck12-rhex is-big"
        title="下指令 · 回主对话（⌘K）"
        data-testid="cockpit-menu-command"
        onClick={openCommand}
      >
        <span className="ck12-rhex-i" aria-hidden="true">❯</span>
        <span className="ck12-rhex-l">下指令</span>
      </button>

      <button
        type="button"
        className="ck12-rhex"
        title="本舱目录 · 当前 cwd 目录树（⌥F，只读）"
        data-testid="cockpit-menu-cabin-tree"
        onClick={() => toggleCabinTree()}
      >
        <span className="ck12-rhex-i" aria-hidden="true">⌗</span>
        <span className="ck12-rhex-l">目录</span>
      </button>

      {/* v22 十四轮：活动（汐音主会话的后台作业 + 子代理）—— 常住入口。 */}
      <button
        type="button"
        className={`ck12-rhex is-activity${activityOpen ? ' is-on' : ''}`}
        title={
          activityLive > 0
            ? `活动 · ${activityLive} 项后台运行中（⌥V，只读）`
            : '活动 · 当前没有后台作业或子代理（⌥V，只读）'
        }
        aria-expanded={activityOpen}
        data-testid="cockpit-menu-activity"
        onClick={() => (activityOpen ? closeActivity() : openActivity())}
      >
        <span className="ck12-rhex-i" aria-hidden="true">◉</span>
        <span className="ck12-rhex-l">活动</span>
        {activityLive > 0 && (
          <i className="ck12-rnb" data-testid="cockpit-menu-activity-count">{activityLive}</i>
        )}
      </button>

      <button
        type="button"
        className="ck12-rhex"
        title="本舱账本（全域累计 · 只读）"
        data-testid="cockpit-menu-usage"
        onClick={() => openPanel('ledger')}
      >
        <span className="ck12-rhex-i" aria-hidden="true">¥</span>
        <span className="ck12-rhex-l">消耗</span>
      </button>

      <button
        type="button"
        className="ck12-rhex"
        title="调试 inspect · 本舱主会话（常驻 · ⌥D）"
        data-testid="cockpit-menu-debug"
        onClick={openDebug}
      >
        <span className="ck12-rhex-i" aria-hidden="true">⚙</span>
        <span className="ck12-rhex-l">调试</span>
      </button>

      {/* 问题 #1：变更挨着「更多」（倒数第二），且只在 cwd 是独立 git 仓库时出现。 */}
      {showChanges && (
        <button
          type="button"
          className="ck12-rhex"
          title="本舱变更 · cwd 的工作区改动（⌥G，只读）"
          data-testid="cockpit-menu-changes"
          onClick={() => toggleChanges()}
        >
          <span className="ck12-rhex-i" aria-hidden="true">±</span>
          <span className="ck12-rhex-l">变更</span>
        </button>
      )}

      <div className="ck12-morewrap" ref={wrapRef}>
        <button
          type="button"
          className={`ck12-rhex is-more${fanOpen ? ' is-on' : ''}`}
          title="更多 · 点击展开 / 再点收回"
          aria-expanded={fanOpen}
          data-testid="cockpit-menu-more"
          onClick={(event) => {
            event.stopPropagation()
            setFanOpen((open) => !open)
          }}
        >
          <span className="ck12-rhex-i" aria-hidden="true">⋯</span>
          <span className="ck12-rhex-l">更多</span>
        </button>

        <div
          className={`ck12-fanwrap${fanOpen ? ' is-on' : ''}`}
          data-testid="cockpit-menu-fan"
        >
          <span className="ck12-fanlead">MORE</span>
          <div className="ck12-fan">
            {FAN_ITEMS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="ck12-fitem"
                style={{ ['--d' as string]: `${index * 24}ms` }}
                data-testid={`cockpit-fan-${item.id}`}
                onClick={() => fanAction(item.id)}
              >
                <span className="ck12-fitem-h" aria-hidden="true">{item.glyph}</span>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </nav>
  )
}
