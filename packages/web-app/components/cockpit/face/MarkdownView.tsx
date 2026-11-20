'use client'

// 只读文档的 Markdown 渲染（2026-11-19 从 CockpitTreeWindow 抽出）：
// 目录窗右栏与聊天文档查看器共用同一套排版（.ck12-ckt-doc / .ck12-ckt-fence）。
// 只做查看用的一小撮语法（标题 / 列表 / 引用 / 行内 code / 代码块），不引入完整渲染器。

import type { ReactNode } from 'react'

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <b key={i}>{part.slice(2, -2)}</b>
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
          return <code key={i}>{part.slice(1, -1)}</code>
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

export function MarkdownView({ src }: { src: string }) {
  const blocks: ReactNode[] = []
  let list: string[] = []
  let fence: string[] | null = null
  let key = 0
  const flushList = () => {
    if (!list.length) return
    const items = list
    blocks.push(
      <ul key={`ul${key++}`}>
        {items.map((item, i) => <li key={i}><InlineText text={item} /></li>)}
      </ul>,
    )
    list = []
  }
  const flushFence = () => {
    if (!fence) return
    blocks.push(<pre key={`pre${key++}`} className="ck12-ckt-fence"><code>{fence.join('\n')}</code></pre>)
    fence = null
  }
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (fence) flushFence()
      else { flushList(); fence = [] }
      continue
    }
    if (fence) { fence.push(line); continue }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flushList()
      const level = heading[1].length
      const inner = <InlineText text={heading[2]} />
      blocks.push(
        level === 1
          ? <h1 key={key++}>{inner}</h1>
          : level === 2
            ? <h2 key={key++}>{inner}</h2>
            : <h3 key={key++}>{inner}</h3>,
      )
      continue
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item) { list.push(item[1]); continue }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushList()
      blocks.push(<blockquote key={key++}><InlineText text={quote[1]} /></blockquote>)
      continue
    }
    flushList()
    if (!line.trim()) continue
    blocks.push(<p key={key++}><InlineText text={line} /></p>)
  }
  flushFence()
  flushList()
  return <>{blocks}</>
}
