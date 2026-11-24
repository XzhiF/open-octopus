'use client'

// 后台作业详情（2026-11-24 用户 #1 · 活动日志）。
//
// 活动详情窗（右栏「活动」二级）与活动日志大窗共用这一份：
//   · 启动命令 = 后台作业的 description（Bash `run_in_background` 的原命令）；
//   · 识别到的端口 = 命令 + 输出尾里的 localhost / --port / listening on 片段；
//   · 日志尾 = 运行中每 2s 拉一次 `get_task_output`（≤8 KiB）；结束后由服务端
//     回退读 CLI 留下的 output_file 末尾，仍可回看；
//   · 停止作业 = 只停这一个后台任务（`stopTask`），主对话当前轮不受影响；
//     点一次先出二次确认，避免误杀 dev 服务。

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  getBackgroundOutput,
  stopBackgroundTask,
  type BackgroundTaskOutput,
} from '@/lib/agent/api'
import { formatStopwatch } from '@/lib/format'
import {
  activityIsLive,
  backgroundStatusLabel,
  detectPorts,
  type ActivityItem,
} from './activity-model'

type BackgroundItem = Extract<ActivityItem, { kind: 'background' }>

const OUTPUT_POLL_MS = 2_000

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function statusTone(status: string | undefined, live: boolean): string {
  if (live) return 'run'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  return 'stopped'
}

export function CockpitBackgroundDetail({
  sessionId,
  item,
}: {
  sessionId: string | null
  item: BackgroundItem
}) {
  const taskId = item.task.id
  const live = activityIsLive(item)
  const record = item.record
  const status = record?.status
  const tone = statusTone(status, live)

  const [output, setOutput] = useState('')
  const [meta, setMeta] = useState<BackgroundTaskOutput | null>(null)
  const [outErr, setOutErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const preRef = useRef<HTMLPreElement | null>(null)

  // 日志尾：运行中 2s 一轮；结束的那一帧再拉一次（服务端回退读 output_file）。
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const res = await getBackgroundOutput(sessionId, taskId)
        if (!alive) return
        setOutput(res.output)
        setMeta(res)
        setOutErr(null)
      } catch (err) {
        if (!alive) return
        setOutErr(errorText(err))
        if (!live) return
      }
      if (live) timer = window.setTimeout(() => { void tick() }, OUTPUT_POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
  }, [sessionId, taskId, live])

  // 贴合日志尾（用户往上翻时不要抢滚动条）。
  useEffect(() => {
    const pre = preRef.current
    if (!pre) return
    const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48
    if (nearBottom) pre.scrollTop = pre.scrollHeight
  }, [output])

  const ports = useMemo(
    () => detectPorts(item.task.description, output),
    [item.task.description, output],
  )

  const elapsed = useMemo(() => {
    if (!record) return null
    const start = Date.parse(record.started_at)
    if (!Number.isFinite(start)) return null
    const end = record.ended_at ? Date.parse(record.ended_at) : Date.now()
    if (!Number.isFinite(end) || end < start) return null
    return formatStopwatch(end - start)
  }, [record])

  const doStop = async () => {
    if (!sessionId || stopping) return
    setStopping(true)
    try {
      await stopBackgroundTask(sessionId, taskId)
      setConfirming(false)
      toast(`已请求停止 · ${item.task.description}`)
    } catch (err) {
      toast(`停止失败 · ${errorText(err)}`)
    } finally {
      setStopping(false)
    }
  }

  return (
    <>
      <div className="ck12-act-meta">
        <span className={`ck12-act-chip is-${tone}`}>
          {live ? '● 运行中' : `■ ${backgroundStatusLabel(status)}`}
        </span>
        <span className="ck12-act-chip">{item.task.taskType ?? 'bash'}</span>
        <span className="ck12-act-chip">run_in_background</span>
        {elapsed && <span className="ck12-act-chip">时长 {elapsed}</span>}
        <span className="ck12-act-chip ck12-act-chip-id" title={taskId}>id {taskId}</span>
        <span className="ck12-act-sp" />
      </div>

      <div className="ck12-act-body">
        <div className="ck12-act-prompt">
          <div className="k">⌁ 启动命令</div>
          <pre>{item.task.description}</pre>
        </div>

        {ports.length > 0 && (
          <div className="ck12-act-ports">
            <span className="k">↗ 识别到的端口</span>
            {ports.map((port) => (
              <a
                key={port}
                className="ck12-act-port"
                href={`http://localhost:${port}`}
                target="_blank"
                rel="noreferrer"
                data-testid={`cockpit-act-port-${port}`}
              >
                localhost:{port}
              </a>
            ))}
            <span className="hint">来自命令 + 日志尾</span>
          </div>
        )}

        <div className="ck12-act-acts">
          {live && (
            <button
              type="button"
              className="ck12-act-stopbtn"
              data-testid="cockpit-act-stop"
              disabled={stopping}
              onClick={() => setConfirming((open) => !open)}
            >
              ■ 停止作业
            </button>
          )}
          {ports.length > 0 && (
            <a
              className="ck12-act-openurl"
              href={`http://localhost:${ports[0]}`}
              target="_blank"
              rel="noreferrer"
            >
              ↗ 打开 localhost:{ports[0]}
            </a>
          )}
          <span className="hint">
            {live ? '只结束这一个作业 · 主对话继续跑' : '已结束 · 留档只读'}
          </span>
        </div>

        {live && confirming && (
          <div className="ck12-act-stopconfirm" role="alertdialog" aria-label="确认停止后台作业">
            <div className="t">⚠ 确认停止这个后台作业？</div>
            <p>
              只停 <b>{item.task.description}</b>，主对话的当前轮不受影响；
              停止后它会以「已停止」留档。
            </p>
            <div className="row">
              <button type="button" onClick={() => setConfirming(false)} disabled={stopping}>
                继续跑着
              </button>
              <button
                type="button"
                className="danger"
                data-testid="cockpit-act-stop-confirm"
                onClick={() => { void doStop() }}
                disabled={stopping}
              >
                {stopping ? '停止中…' : '停止作业'}
              </button>
            </div>
          </div>
        )}

        <div className="ck12-act-log">
          <div className="k">
            日志尾
            <span className="badge">
              {live
                ? '实时 · 2s'
                : meta?.source === 'file' ? '已结束 · output_file' : '已结束'}
            </span>
            {meta && meta.total_bytes > 0 && (
              <span className="hint">
                {(meta.total_bytes / 1024).toFixed(1)} KiB
                {meta.truncated ? ' · 只显示末尾' : ''}
              </span>
            )}
          </div>
          {outErr && !output ? (
            <div className="err">日志不可读 · {outErr}</div>
          ) : (
            <pre ref={preRef} data-testid="cockpit-act-output">
              {output || (live ? '（还没有输出 · 每 2s 刷新）' : '（这个作业没有留下输出）')}
            </pre>
          )}
        </div>
      </div>

      <div className="ck12-act-tfoot">
        <span className="ck12-act-chip">run_in_background</span>
        <span className="ck12-act-sp" />
        <span>
          {live
            ? '日志尾实时 · SDK get_task_output（≤8 KiB）'
            : '留档 · 读自 output_file 末尾'}
        </span>
      </div>
    </>
  )
}
