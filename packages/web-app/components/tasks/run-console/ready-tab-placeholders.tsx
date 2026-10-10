// packages/web-app/components/tasks/run-console/ready-tab-placeholders.tsx
//
// 票 07 · ready 三签中的「💬 对话」「▤ 规格」两签占位壳 —— 装配先行防三票互相等：
// 页签条上两签可点可切（tab-assembly 的 ready 行钉死 keys=[chat,spec,nodes]），
// 内容先落占位。后续票各替换各的壳，**不再动装配**：
//   · 票 08 替换 ReadyChatPlaceholder → 草稿期对话只读回放（原型 ⓬ readyChatHtml：
//     「— 只读回放 · 草稿期对话（task-author 全记录）—」整屏 transcript，无输入框）。
//   · 票 09 替换 ReadySpecPlaceholder → 规格只读镜像（原型 readySpecHtml：Phases
//     逐段放行 + 入队清单硬闸 + 批次目录树；改规格走右栏「↩ 回草稿」）。
// 两壳 testid（ready-chat-placeholder / ready-spec-placeholder）是壳层测试与
// 08/09 迁移的锚点。

const SHELL = "mx-auto mt-10 max-w-[560px] rounded-xl border-[1.5px] border-dashed border-pop-bd bg-pop-idle/40 px-6 py-8 text-center font-mono text-[11px] leading-relaxed text-pop-dim"

/** ready 的「💬 对话」内容位（票 08 接入点：只换本组件的返回值）。 */
export function ReadyChatPlaceholder() {
  return (
    <div data-testid="ready-chat-placeholder" className={SHELL}>
      <div className="mb-1 font-black text-pop-ink">— 只读回放 · 草稿期对话 —</div>
      task-author 全记录读取中 / 待接入（票 08）—— 页签可点可切，内容只替换本壳。
    </div>
  )
}

/** ready 的「▤ 规格」内容位（票 09 接入点：只换本组件的返回值）。 */
export function ReadySpecPlaceholder() {
  return (
    <div data-testid="ready-spec-placeholder" className={SHELL}>
      <div className="mb-1 font-black text-pop-ink">— 草稿期 SpecPanel 只读镜像 —</div>
      v4 phases / 入队清单 / 批次目录树待接入（票 09）—— 要改规格走右栏「↩ 回草稿」。
    </div>
  )
}
