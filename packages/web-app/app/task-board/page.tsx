"use client"

import { DemandBoard } from "@/components/task-board/DemandBoard"

export default function TaskBoardPage() {
  return (
    <div className="container mx-auto space-y-4 px-4 py-6 lg:px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Task Board</h1>
        <p className="text-muted-foreground">
          Manage demands across the lifecycle pipeline
        </p>
      </div>
      <DemandBoard />
    </div>
  )
}
