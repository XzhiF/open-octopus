'use client'

// v21（design 31 §3.4.7）· 通讯台底缘状态行（原型 .con-f）：
//   SCENE <当前幕短名> · POSE <姿态> · CTX <占用%> · MODEL <模型[·1M]> · TUI SKIN
//   右侧三枚场景点（9×10 六角）—— 点名直接切幕。
//
// 读数是真值（chat 遥测 / state.pose / state.sceneIndex）；缺值写「未就绪」。

import { useCockpitState } from '../state/CockpitStateProvider'
import { SCENES } from '../scene/scene-model'

export function CockpitConsoleFooter() {
  const { chat, pose, sceneIndex, setScene } = useCockpitState()
  const scene = SCENES[sceneIndex] ?? SCENES[0]
  const ctx = chat?.contextUsage?.percentage
  const ctxLabel = ctx == null ? '未就绪' : `${Math.round(ctx)}%`
  const model = chat?.model ?? null
  const modelLabel = model == null
    ? '未就绪'
    : `${model}${chat?.contextWindow === '1m' ? '·1M' : ''}`

  return (
    <div className="ck12-con-f" data-testid="cockpit-console-footer">
      <span>SCENE <b>{scene.short}</b></span>
      <span>POSE <b>{pose}</b></span>
      <span>CTX <b>{ctxLabel}</b></span>
      <span>MODEL <b>{modelLabel}</b></span>
      <span>TUI <b>SKIN</b></span>
      <span className="ck12-con-sp" />
      {SCENES.map((item, index) => (
        <button
          key={item.key}
          type="button"
          className={`ck12-sdot${index === sceneIndex ? ' is-on' : ''}`}
          aria-label={`切到 ${item.name}`}
          aria-pressed={index === sceneIndex}
          title={item.name}
          data-testid={`cockpit-scene-dot-${item.key}`}
          onClick={() => setScene(index)}
        />
      ))}
    </div>
  )
}
