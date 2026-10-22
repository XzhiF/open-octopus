"use client"

import { useCallback, useState } from "react"
import { FilePlus2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatTab } from "@/components/agent/chat/ChatTab"
import { TaskModal } from "@/components/tasks/task-modal"
import { getTask, type TaskView } from "@/lib/tasks-api"

export default function ConversationPage() {
  const [draftOpen, setDraftOpen] = useState(false)
  const [modalTask, setModalTask] = useState<TaskView | null>(null)

  // Keep the draft workspace live: agent-driven spec writes re-read the task
  // through the same GET the tasks board uses.
  const refreshModalTask = useCallback(async () => {
    if (!modalTask) return
    try {
      setModalTask(await getTask(modalTask.id))
    } catch {
      /* keep the last known task; the modal surfaces its own errors */
    }
  }, [modalTask])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b-[1.5px] border-pop-bd bg-pop-paper px-4 py-3 lg:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-black tracking-tight text-pop-ink">对话</h1>
          <p className="text-xs text-pop-dim">
            与主 Agent 对话；需要产出计划时，从任务草稿开始。
          </p>
        </div>
        <Button size="sm" onClick={() => setDraftOpen(true)}>
          <FilePlus2 className="h-4 w-4" />
          新建任务草稿
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        <ChatTab />
      </div>

      <TaskModal
        open={draftOpen}
        onOpenChange={(open) => {
          setDraftOpen(open)
          if (!open) setModalTask(null)
        }}
        task={modalTask}
        onMutated={refreshModalTask}
        onDraftResolved={(task) => setModalTask(task)}
      />
    </div>
  )
}
