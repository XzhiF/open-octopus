import Database from 'better-sqlite3'
import { ScheduleConfigDAO } from '../../db/dao'

interface ExportRow {
  name: string
  workspace_name: string
  job_type: string
  cron_expression: string
  enabled: boolean
  consecutive_failures: number
  last_execution_at: string | null
  last_execution_status: string | null
}

export class ExportService {
  private configDAO: ScheduleConfigDAO

  constructor(configDAO: ScheduleConfigDAO) {
    this.configDAO = configDAO
  }

  exportCSV(range: string, scope: 'all' | 'failed', from?: string, to?: string): string {
    const { start, end } = this.resolveTimeRange(range, from, to)
    const rows = this.getExportData(scope, start, end)

    // CSV header
    const headers = ['Name', 'Workspace', 'Type', 'Cron', 'Status', 'Failures', 'Last Execution', 'Last Status']
    const lines = [headers.join(',')]

    for (const row of rows) {
      const status = row.enabled ? 'enabled' : 'disabled'
      const fields = [
        this.escapeCSV(row.name),
        this.escapeCSV(row.workspace_name),
        row.job_type,
        this.escapeCSV(row.cron_expression),
        status,
        String(row.consecutive_failures),
        row.last_execution_at ?? '',
        row.last_execution_status ?? '',
      ]
      lines.push(fields.join(','))
    }

    return lines.join('\n')
  }

  private resolveTimeRange(range: string, from?: string, to?: string): { start: string; end: string } {
    const now = new Date()
    let start: Date

    if (range === 'custom' && from && to) {
      return { start: from, end: to }
    }

    const rangeMap: Record<string, number> = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    }

    const durationMs = rangeMap[range] ?? rangeMap['24h']
    start = new Date(now.getTime() - durationMs)

    return { start: start.toISOString(), end: now.toISOString() }
  }

  private getExportData(scope: 'all' | 'failed', start: string, end: string): ExportRow[] {
    const allRows = this.configDAO.findAllSchedulesWithWorkspaceInfo()

    return allRows.filter(row => {
      // Time range filter
      if (row.last_execution_at != null) {
        if (row.last_execution_at < start || row.last_execution_at > end) {
          return false
        }
      }
      // Scope filter
      if (scope === 'failed' && row.consecutive_failures <= 0) {
        return false
      }
      return true
    }).map(row => ({
      ...row,
      enabled: row.enabled === 1,
    }))
  }

  private escapeCSV(value: string): string {
    // CSV injection protection: Excel/Sheets interpret cells starting with
    // = + - @ as formulas. Prefix with single quote to neutralize.
    // See: https://owasp.org/www-community/attacks/CSV_Injection
    if (/^[=+\-@\t\r]/.test(value)) {
      value = `'${value}`
    }

    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`
    }
    return value
  }
}
