"use client"

import { Handle, Position } from "@xyflow/react"
import type { DagOrientation } from "@/lib/dag-orientation"

/**
 * 进出边挂点与 dagre 流向的唯一映射表。
 * 布局（lib/workflow-parser 的 rankdir）和外观（各节点组件的 Handle）都从这里取，
 * 否则「节点向右流、箭头却从底边出来」这种错位会悄悄回来（2026-10-30 改横向时的风险点）。
 */
export const FALLBACK_ORIENTATION: DagOrientation = "TB"

/**
 * 缺省 TB：只有 workflow-parser 产出的节点会带 data.dagOrientation。
 * 其他画布（工作空间执行树、app/dev 的节点调试页）自己手摆 position、不带这个字段，
 * 于是不受本次改版影响 —— 改的是工作流 DAG，不顺手改掉别人的画布。
 */
const TARGET_POSITION: Record<DagOrientation, Position> = {
  LR: Position.Left,
  TB: Position.Top,
}

const SOURCE_POSITION: Record<DagOrientation, Position> = {
  LR: Position.Right,
  TB: Position.Bottom,
}

/** 纯几何：某流向下的进/出边方向（可单测，DOM 层只是它的消费者）。 */
export function handlePositions(orientation: DagOrientation): { target: Position; source: Position } {
  return { target: TARGET_POSITION[orientation], source: SOURCE_POSITION[orientation] }
}

/**
 * 多路口节点（condition 的 cases[]）的分支口：沿「垂直于流向」的那条轴等分。
 * TB 铺在底边的左右方向，LR 铺在右边的上下方向 —— 轴选错的话所有分支口叠在同一点，
 * 多条 case 边会挤成一条线。
 */
export function branchCrossAxisStyle(
  orientation: DagOrientation,
  index: number,
  total: number,
): React.CSSProperties {
  const share = 100 / (total + 1)
  const offset = `${(index + 1) * share}%`
  return orientation === "LR" ? { top: offset } : { left: offset }
}

type HandleSize = "default" | "small"

const SIZE_CLASS: Record<HandleSize, string> = {
  default: "",
  // 容器（loop / 子工作流）是虚线盒子，挂点压小一档才不压住标题行
  small: "!w-3 !h-3",
}

function handleClass(size: HandleSize, className?: string): string {
  return ["!bg-muted-foreground", SIZE_CLASS[size], className].filter(Boolean).join(" ")
}

interface DagHandleProps {
  orientation?: DagOrientation
  size?: HandleSize
  className?: string
}

/** 上游入口。LR = 左边，TB = 顶边。 */
export function DagTargetHandle({ orientation = FALLBACK_ORIENTATION, size = "default", className }: DagHandleProps) {
  return <Handle type="target" position={handlePositions(orientation).target} className={handleClass(size, className)} />
}

/** 下游出口。LR = 右边，TB = 底边。 */
export function DagSourceHandle({ orientation = FALLBACK_ORIENTATION, size = "default", className }: DagHandleProps) {
  return <Handle type="source" position={handlePositions(orientation).source} className={handleClass(size, className)} />
}

interface DagBranchHandleProps {
  /** 分支口 id（condition 的 case 边按它绑到具体出口），同时用作 React key 的一部分 */
  id: string
  index: number
  total: number
  orientation?: DagOrientation
  style?: React.CSSProperties
}

export function DagBranchHandle({
  id,
  index,
  total,
  orientation = FALLBACK_ORIENTATION,
  style,
}: DagBranchHandleProps) {
  return (
    <Handle
      type="source"
      id={id}
      position={handlePositions(orientation).source}
      style={{ ...branchCrossAxisStyle(orientation, index, total), ...style }}
      className="!w-3 !h-3 !border-2 !border-pop-bg"
    />
  )
}
