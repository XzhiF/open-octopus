"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/** xyflow 的实例片段：这里只用到 fitView，避免把整包类型拖进依赖。 */
interface FitViewLike {
  fitView: (options?: { padding?: number; duration?: number; minZoom?: number; maxZoom?: number }) => void
}

/**
 * 自动拟合的缩放下限（20%）。
 * xyflow 的 ReactFlow 默认 minZoom = 0.5，而 fitView 会被它钳住 —— 横向主干的图很宽
 * （实测 matt-spec-dev 内容宽 2790 流内 px），0.5 时 1238px 的 pane 根本装不下，
 * fitView 于是「居中但装不进」：两端节点照旧被裁。这里显式放宽，同时留一条下限：
 * 再小文字就成蚁群了，宁可让用户自己平移。
 */
export const FIT_MIN_ZOOM = 0.2

/** 允许用户手动缩到比自动拟合更小，看整条流水线全貌。 */
export const USER_MIN_ZOOM = 0.1

interface UseDagAutoFitOptions {
  /** 四周留白比例（与 xyflow fitView 同义） */
  padding?: number
  /**
   * 结构指纹（一般传节点数）。变了就重拟合一次 —— 动态子工作流的体内节点是
   * 运行时长出来的，首帧拟合时它们还不存在，不补一次就会一直缺一块。
   */
  contentKey?: string | number
}

/**
 * DAG 视口的「别把节点切在外面」兜底。
 *
 * 为什么需要（2026-10-30 横向布局实测）：横向主干的图是**宽扁**形状，而运行台里
 * DAG pane 的实际高度会被下面的日志台挤压 —— 组件挂载时按当时的 pane 尺寸 fitView，
 * 日志台一展开 pane 变矮，fit 的缩放是按旧高度算的，于是左右两端（spec-resolve、
 * ship-pr）直接被 pane 裁掉：实测 zoom 0.5 时 7 个主干节点里 3 个出界。
 * 纵向布局时代同样的过期拟合表现为「上下要滚动」，不太扎眼；横向后必须处理。
 *
 * 规则：容器尺寸真变了 → 重新 fitView；但用户自己滚轮缩放或拖动过画布 → 从此不再
 * 抢镜头（点节点不算：左键点节点是「聚焦到该通道」的正常操作，不该关掉自动拟合）。
 *
 * @returns containerRef 挂到 ReactFlow 的外层 div（回调 ref，div 迟到也能补订阅），
 *          onInit 传给 ReactFlow，movedRef 供测试/调用方观察接管状态
 */
export function useDagAutoFit<T extends HTMLElement>({ padding = 0.2, contentKey }: UseDagAutoFitOptions = {}) {
  // 用「元素进 state」而不是 useRef 对象：viewer 在还没有 flow 数据时是提前 return 的，
  // div 根本不存在 —— 那时挂的 effect 拿到 null 就再也不重跑，pane 后来被日志台挤矮
  // 也没人拟合（2026-10-30 实测：运行台里 7 个主干节点 3 个出界，正是这条路径）。
  // 回调 ref 把节点变化变成一次重渲染，effect 于是能在 div 真正出现时补上订阅。
  const [element, setElement] = useState<T | null>(null)
  const containerRef = useCallback((node: T | null) => { setElement(node) }, [])
  const instanceRef = useRef<FitViewLike | null>(null)
  const movedRef = useRef(false)
  const sizeRef = useRef({ w: 0, h: 0 })

  const onInit = useCallback((instance: unknown) => {
    instanceRef.current = instance as FitViewLike
    // 挂载即拟合一次：替代原先 onInit + setTimeout(50) 的定时 hack（慢机器上 50ms
    // 内节点还没测完，拟合结果本身就是过期的）。
    // maxZoom 1 = 图小也不放大到 100% 以上，两三个节点的流不至于撑成巨物；
  // minZoom 见 FIT_MIN_ZOOM —— 不带它，宽图在窄 pane 里会「居中但两端出界」。
    instanceRef.current?.fitView({ padding, minZoom: FIT_MIN_ZOOM, maxZoom: 1 })
  }, [padding])

  const fit = useCallback(() => {
    if (movedRef.current) return
    instanceRef.current?.fitView({ padding, minZoom: FIT_MIN_ZOOM, maxZoom: 1 })
  }, [padding])

  useEffect(() => {
    const el = element
    // jsdom / 老浏览器没有 ResizeObserver：没有就不兜底，不炸组件
    if (!el || typeof ResizeObserver === "undefined") return

    let frame = 0
    // 基线取观察起始时的尺寸：ResizeObserver 在 observe 时就会立刻回调一次，
    // 而那次尺寸和 onInit 拟合时是同一个 —— 不预置基线就会白重拟合一次（镜头抖一下）。
    const initial = el.getBoundingClientRect()
    sizeRef.current = { w: initial.width, h: initial.height }
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect()
      // 2px 以内当抖动忽略（窗口过渡动画、滚动条出现都会带来几像素）
      if (Math.abs(width - sizeRef.current.w) < 2 && Math.abs(height - sizeRef.current.h) < 2) return
      sizeRef.current = { w: width, h: height }
      // 尺寸连续变化（拖动分隔条）时合并到下一帧，只拟合一次
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    })
    observer.observe(el)

    const takeOver = () => { movedRef.current = true }
    const onPointerDown = (event: Event) => {
      // 背景（pane）上的按下 = 平移意图；节点/边上的按下是点击操作，不算接管
      if ((event.target as HTMLElement).closest(".react-flow__node, .react-flow__edge")) return
      takeOver()
    }
    el.addEventListener("pointerdown", onPointerDown)
    el.addEventListener("wheel", takeOver, { passive: true })

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      el.removeEventListener("pointerdown", onPointerDown)
      el.removeEventListener("wheel", takeOver)
    }
  }, [element, fit])

  // 结构变化（体内节点迟到）→ 补一次拟合。fitView 只在首帧跑过一次的话，
  // 后长出来的节点永远在视口外。
  useEffect(() => {
    if (contentKey === undefined) return
    fit()
  }, [contentKey, fit])

  return { containerRef, onInit, movedRef }
}
