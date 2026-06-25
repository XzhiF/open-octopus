import type { ErrorTracker, ErrorRecord } from '../error-tracker'

export interface ErrorsResponse {
  total: number
  by_category: Record<string, number>
  recent: {
    id: string
    timestamp: string
    category: string
    message: string
    stack?: string
    context: {
      execution_id?: string
      node_id?: string
      workflow_name?: string
    }
  }[]
}

export class ErrorResolver {
  constructor(private errorTracker: ErrorTracker) {}

  getErrors(): ErrorsResponse {
    const allErrors = this.errorTracker.getErrors()
    const byCategory: Record<string, number> = {}
    for (const e of allErrors) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1
    }

    const recent = this.errorTracker.getRecentErrors(50).map(e => ({
      id: e.id,
      timestamp: new Date(e.timestamp).toISOString(),
      category: e.category,
      message: e.message,
      stack: e.stack,
      context: {
        execution_id: e.context.execution_id as string | undefined,
        node_id: e.context.node_id as string | undefined,
        workflow_name: e.context.workflow_name as string | undefined,
      },
    }))

    return { total: allErrors.length, by_category: byCategory, recent }
  }
}
