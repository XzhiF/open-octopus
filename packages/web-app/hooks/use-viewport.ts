'use client'

import { useEffect, useState } from 'react'

export type Breakpoint = 'wide' | 'medium' | 'narrow'

export interface ViewportInfo {
  width: number
  height: number
  breakpoint: Breakpoint
}

function breakpointFor(width: number): Breakpoint {
  if (width >= 1024) return 'wide'
  if (width >= 768) return 'medium'
  return 'narrow'
}

function readViewport(): ViewportInfo {
  if (typeof window === 'undefined') {
    return { width: 1280, height: 800, breakpoint: 'wide' }
  }
  const width = window.innerWidth
  const height = window.innerHeight
  return { width, height, breakpoint: breakpointFor(width) }
}

/** Viewport size + shell breakpoint, rAF-debounced on resize. */
export function useViewport(): ViewportInfo {
  const [info, setInfo] = useState<ViewportInfo>(readViewport)

  useEffect(() => {
    let frame = 0
    const onResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setInfo(readViewport()))
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return info
}
