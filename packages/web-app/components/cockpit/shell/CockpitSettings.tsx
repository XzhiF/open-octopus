'use client'

// v21 二轮（原型 settings 弹窗）·「更多 → 设置」：
//   声音（音效）/ 外观（主题色 · 窗口透明度）/ 场景（随机跃迁）/ 原型演练（自动回流）。
//
// 偏好真源：
//   · 音效 / 主题色 / 窗口透明度 ← cockpit_prefs（本机落库，700ms 防抖）
//   · 随机跃迁 ← CockpitState.autoWarp
//   · 自动回流 ← sim-auto store（仅 DEV + ?demo=1 生效）
//
// 设置窗本身不跟随窗口透明度（方便边调边看，原型同口径）。

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { THEMES, type CockpitTheme } from '@/components/cabin/cockpit'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useSimAuto, setSimAuto } from '../fx/sim-auto'
import { setCockpitSettingsOpen, useCockpitSettingsOpen } from './settings-store'

const THEME_ORDER = Object.keys(THEMES) as CockpitTheme[]

const SETTINGS_LAYER_PRIORITY = 85

export function CockpitSettings() {
  const open = useCockpitSettingsOpen()
  const { prefs, applyPrefs } = useCockpit()
  const { autoWarp, setAutoWarp, layer } = useCockpitState()
  const simAuto = useSimAuto()

  const close = () => setCockpitSettingsOpen(false)

  useEffect(() => {
    if (!open) return
    return layer.register('cockpit-settings', SETTINGS_LAYER_PRIORITY, close)
  }, [open, layer])

  if (!open) return null

  const alpha = Math.round(prefs.winAlpha * 100)

  return (
    <div
      className="ck12-setwrap"
      data-testid="cockpit-settings"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="ck12-setmodal" role="dialog" aria-modal="true" aria-label="设置">
        <div className="ck12-sh">
          <button
            type="button"
            className="ck12-sx ck12-hexbtn"
            title="关闭"
            aria-label="关闭设置"
            data-testid="cockpit-settings-close"
            onClick={close}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
          <span className="ck12-st">
            <b>设置</b>
            <span>SETTINGS · 舱内偏好（本地）</span>
          </span>
        </div>

        <div className="ck12-sb">
          <div className="ck12-sgrp">声音</div>
          <div className="ck12-srow">
            <span className="ck12-sk">
              <b>音效</b>
              <span>点击 / 发送 / 回传的合成音（⌥M 快速切换）</span>
            </span>
            <button
              type="button"
              className={`ck12-sw${prefs.sound ? ' is-on' : ''}`}
              aria-pressed={prefs.sound}
              data-testid="cockpit-setting-sound"
              title={prefs.sound ? '关闭音效' : '开启音效'}
              onClick={() => applyPrefs({ ...prefs, sound: !prefs.sound })}
            />
          </div>

          <div className="ck12-sgrp">外观</div>
          <div className="ck12-srow">
            <span className="ck12-sk">
              <b>主题色</b>
              <span>按钮高亮 / 星流 / 跃迁光效跟随主题</span>
            </span>
            <span className="ck12-swatches">
              {THEME_ORDER.map((key) => {
                const theme = THEMES[key]
                return (
                  <button
                    key={key}
                    type="button"
                    className={`ck12-tsw${prefs.theme === key ? ' is-on' : ''}`}
                    aria-label={`主题 ${theme.name}`}
                    title={theme.name}
                    data-testid={`cockpit-theme-${key}`}
                    style={{ background: `linear-gradient(135deg, ${theme.a}, ${theme.b} 55%, ${theme.c})` }}
                    onClick={() => applyPrefs({ ...prefs, theme: key })}
                  />
                )
              })}
            </span>
          </div>
          <div className="ck12-srow">
            <span className="ck12-sk">
              <b>窗口透明度</b>
              <span>通讯台 / 面板 / 弹窗的整体不透明度</span>
            </span>
            <span className="ck12-slider">
              <input
                type="range"
                min={40}
                max={100}
                step={2}
                value={alpha}
                aria-label="窗口透明度"
                data-testid="cockpit-setting-alpha"
                onChange={(event) => {
                  const next = Math.max(40, Math.min(100, Number(event.target.value))) / 100
                  applyPrefs({ ...prefs, winAlpha: next })
                }}
              />
              <b>{alpha}%</b>
            </span>
          </div>

          <div className="ck12-sgrp">场景</div>
          <div className="ck12-srow">
            <span className="ck12-sk">
              <b>随机跃迁</b>
              <span>每 45–105 秒自动切下一幕（⌥W 手动跃迁）</span>
            </span>
            <button
              type="button"
              className={`ck12-sw${autoWarp ? ' is-on' : ''}`}
              aria-pressed={autoWarp}
              data-testid="cockpit-setting-warp"
              title={autoWarp ? '关闭随机跃迁' : '开启随机跃迁'}
              onClick={() => setAutoWarp(!autoWarp)}
            />
          </div>

          <div className="ck12-sgrp">原型演练</div>
          <div className="ck12-srow">
            <span className="ck12-sk">
              <b>自动回流</b>
              <span>约 34 秒一次随机回传 · 仅开发模式（?demo=1）生效</span>
            </span>
            <button
              type="button"
              className={`ck12-sw${simAuto ? ' is-on' : ''}`}
              aria-pressed={simAuto}
              data-testid="cockpit-setting-simauto"
              title={simAuto ? '关闭自动回流' : '开启自动回流'}
              onClick={() => setSimAuto(!simAuto)}
            />
          </div>

          <div className="ck12-snote">
            手动单条 / 连发回流在「更多 → 模拟」。设置即时生效，落在本机舱偏好。
          </div>
        </div>
      </div>
    </div>
  )
}
