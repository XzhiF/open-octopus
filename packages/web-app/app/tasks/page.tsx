"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { RefreshCw, Plus } from "lucide-react"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { listJobs, type SchedulerJob } from "@/lib/scheduler-api"
import { groupJobsByStatus, TASK_POOL_COLUMNS } from "@/lib/task-pool"
import { ChatPanel } from "@/components/workspace/chat/chat-panel"
import { useChatStream } from "@/components/workspace/chat/use-chat-stream"

const REFRESH_INTERVAL_MS = 10_000
const FETCH_LIMIT = 100

export default function TasksPage() {
  const [jobs, setJobs] = useState<SchedulerJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null
    return localStorage.getItem("octopus:tasks:activeSession")
  })

  const chat = useChatStream(null, activeSessionId, {
    apiBase: '/api/chat/global',
    onSessionCreated: (id) => setActiveSessionId(id),
  })

  const fetchJobs = useCallback(async () => {
    try {
      // T-10 server default filters trigger_source='cron'; /tasks page needs requirement-type only.
      const data = await listJobs({ page: 1, limit: FETCH_LIMIT, trigger_source: 'requirement' })
      setJobs(data.items)
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchJobs()
    const id = setInterval(fetchJobs, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchJobs])

  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem("octopus:tasks:activeSession", activeSessionId)
    } else {
      localStorage.removeItem("octopus:tasks:activeSession")
    }
  }, [activeSessionId])

  const initialSelectDone = useRef(false)
  useEffect(() => {
    if (chat.sessions.length === 0) return
    if (activeSessionId && !chat.sessions.some((s) => s.id === activeSessionId)) {
      localStorage.removeItem("octopus:tasks:activeSession")
      setActiveSessionId(null)
      initialSelectDone.current = false
      return
    }
    if (!activeSessionId && !initialSelectDone.current) {
      initialSelectDone.current = true
      const first = chat.sessions[0]
      setActiveSessionId(first.id)
      chat.switchSession(first.id)
    }
  }, [activeSessionId, chat.sessions, chat.switchSession])

  const grouped = groupJobsByStatus(jobs)

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PanelGroup direction="horizontal" className="flex-1">
        <Panel defaultSize={75} minSize={50}>
          <div className="flex flex-col h-full min-w-0">
            <header className="flex items-center gap-3 px-6 py-4 border-b border-border">
              <h1 className="text-2xl font-bold tracking-tight">任务池</h1>
              <span className="text-sm text-muted-foreground">
                {jobs.length} 个任务
              </span>
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchJobs}
                  disabled={loading}
                >
                  <RefreshCw className="size-4" />
                  刷新
                </Button>
                <Button
                  size="sm"
                  onClick={() => toast.info('在右侧对话面板描述需求，AI 会生成 WorkflowConfig，预览后点入队')}
                >
                  <Plus className="size-4" />
                  新建任务
                </Button>
              </div>
            </header>

            {error ? (
              <div className="flex-1 flex items-center justify-center text-destructive text-sm">
                {error}
              </div>
            ) : (
              <div className="flex-1 overflow-auto p-4">
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3 min-h-full">
                  {TASK_POOL_COLUMNS.map((col) => (
                    <section
                      key={col.id}
                      data-task-column={col.id}
                      aria-label={col.label}
                      className="flex flex-col gap-2 min-w-0 rounded-md bg-muted/30"
                    >
                      <header className="flex items-center justify-between px-3 py-2 border-b border-border">
                        <h2 className="text-sm font-semibold">{col.label}</h2>
                        <span className="text-xs text-muted-foreground">
                          {grouped[col.id].length}
                        </span>
                      </header>
                      <div className="flex flex-col gap-2 flex-1 p-2 overflow-auto">
                        {grouped[col.id].map((job) => (
                          <TaskCard key={job.id} job={job} />
                        ))}
                        {grouped[col.id].length === 0 && (
                          <div
                            data-empty-column={col.id}
                            className="text-xs text-muted-foreground text-center py-6 border border-dashed rounded-md"
                          >
                            空
                          </div>
                        )}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Panel>

        <PanelResizeHandle className="w-1 bg-border hover:bg-primary/30 transition-colors" />

        <Panel defaultSize={25} minSize={15} maxSize={40} className="min-w-0">
          <div className="h-full">
            <ChatPanel
              messages={chat.messages}
              sessions={chat.sessions}
              activeSessionId={activeSessionId}
              isStreaming={chat.isCurrentSessionStreaming}
              status={chat.status}
              streamStartMs={chat.streamStartMs}
              streamEndState={chat.streamEndState}
              hasMoreMessages={chat.hasMoreMessages}
              onLoadMoreMessages={chat.loadMoreMessages}
              onSendMessage={async (content) => {
                const newSessionId = await chat.sendMessage(content)
                if (!activeSessionId && newSessionId) {
                  setActiveSessionId(newSessionId)
                }
              }}
              onAbort={chat.abort}
              onCreateSession={async () => {
                const sid = await chat.createSession()
                setActiveSessionId(sid)
                return sid
              }}
              onSelectSession={(sid) => {
                setActiveSessionId(sid)
                chat.switchSession(sid)
              }}
              onDeleteSession={(sid) => {
                chat.deleteSession(sid)
                if (activeSessionId === sid) {
                  setActiveSessionId(null)
                }
              }}
              onRenameSession={chat.renameSession}
            />
          </div>
        </Panel>
      </PanelGroup>
    </div>
  )
}

interface TaskCardProps {
  job: SchedulerJob
}

function TaskCard({ job }: TaskCardProps) {
  return (
    <article
      data-task-card
      data-task-status={job.status}
      className="rounded-md border border-border bg-card p-3 text-sm shadow-sm"
    >
      <h3 className="font-medium truncate">{job.name}</h3>
      <dl className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <dt>状态</dt>
          <dd data-task-card-status>{job.status}</dd>
        </div>
        <div className="flex justify-between">
          <dt>创建</dt>
          <dd>{new Date(job.created_at).toLocaleString()}</dd>
        </div>
      </dl>
    </article>
  )
}
