import { parseExpression } from 'cron-parser'
import cronstrue from 'cronstrue/dist/cronstrue-i18n'

// ── Interfaces ───────────────────────────────────────────────────────

export interface CronParseResult {
  valid: boolean
  description: string
  nextExecutions: string[]
  error?: string
}

export interface NaturalLanguageCronResult {
  expression: string
  description: string
  nextExecutions: string[]
  confidence: 'high' | 'medium' | 'error'
  error?: string
}

// ── parseCronExpression ──────────────────────────────────────────────

/**
 * Validate a cron expression, generate its Chinese description,
 * and compute the next 5 execution times.
 */
export function parseCronExpression(
  expression: string,
  timezone: string,
): CronParseResult {
  try {
    const description = cronstrue.toString(expression, { locale: 'zh_CN' })
    const nextExecutions = calculateNextExecutions(expression, timezone, 5)

    return {
      valid: true,
      description,
      nextExecutions,
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      valid: false,
      description: '',
      nextExecutions: [],
      error: message,
    }
  }
}

// ── calculateNextExecutions ──────────────────────────────────────────

/**
 * Compute the next N execution times for a cron expression
 * in the given timezone.
 */
export function calculateNextExecutions(
  expression: string,
  timezone: string,
  count: number,
): string[] {
  const interval = parseExpression(expression, { tz: timezone })
  const results: string[] = []

  for (let i = 0; i < count; i++) {
    results.push(interval.next().toISOString())
  }

  return results
}

// ── naturalLanguageToCron ────────────────────────────────────────────

/**
 * Convert Chinese natural-language schedule descriptions to cron
 * expressions using a rule-based engine.
 *
 * Supported patterns:
 *   "每天早上9点"       → 0 9 * * *
 *   "每天下午3点"       → 0 15 * * *
 *   "每天晚上8点"       → 0 20 * * *
 *   "每6小时"           → 0 * /6 * * *
 *   "每30分钟"          → * /30 * * * *
 *   "工作日早上9点"     → 0 9 * * 1-5
 *   "每周一"            → 0 10 * * 1
 *   "每月15号"          → 0 10 15 * *
 */
export function naturalLanguageToCron(
  text: string,
): NaturalLanguageCronResult {
  const trimmed = text.trim()

  // 1. "每天<时段><N>点" — daily at specific hour
  const dailyHourMatch = trimmed.match(
    /^每天(早上|上午|中午|下午|晚上)(\d{1,2})点$/,
  )
  if (dailyHourMatch) {
    const [, period, hourStr] = dailyHourMatch
    const hour = convertTo24Hour(Number(hourStr), period)

    if (hour < 0 || hour > 23) {
      return errorResult(`无效的小时数: ${hourStr}`)
    }

    const expression = `0 ${hour} * * *`
    return successResult(expression)
  }

  // 2. "每<N>小时" — every N hours
  const everyHourMatch = trimmed.match(/^每(\d{1,2})小时$/)
  if (everyHourMatch) {
    const [, hoursStr] = everyHourMatch
    const hours = Number(hoursStr)

    if (hours < 1 || hours > 23) {
      return errorResult(`无效的小时间隔: ${hours}`)
    }

    const expression = `0 */${hours} * * *`
    return successResult(expression)
  }

  // 3. "每<N>分钟" — every N minutes
  const everyMinuteMatch = trimmed.match(/^每(\d{1,2})分钟$/)
  if (everyMinuteMatch) {
    const [, minutesStr] = everyMinuteMatch
    const minutes = Number(minutesStr)

    if (minutes < 1 || minutes > 59) {
      return errorResult(`无效的分钟间隔: ${minutes}`)
    }

    const expression = `*/${minutes} * * * *`
    return successResult(expression)
  }

  // 4. "工作日<时段><N>点" — weekdays at specific hour
  const weekdayHourMatch = trimmed.match(
    /^工作日(早上|上午|中午|下午|晚上)(\d{1,2})点$/,
  )
  if (weekdayHourMatch) {
    const [, period, hourStr] = weekdayHourMatch
    const hour = convertTo24Hour(Number(hourStr), period)

    if (hour < 0 || hour > 23) {
      return errorResult(`无效的小时数: ${hourStr}`)
    }

    const expression = `0 ${hour} * * 1-5`
    return successResult(expression)
  }

  // 5. "每周<weekday>" — weekly on specific day
  const weeklyMatch = trimmed.match(/^每周([一二三四五六日天])$/)
  if (weeklyMatch) {
    const [, dayChar] = weeklyMatch
    const dayNum = weekdayToCronNumber(dayChar)
    const expression = `0 10 * * ${dayNum}`
    return successResult(expression)
  }

  // 6. "每月<N>号" — monthly on specific day
  const monthlyMatch = trimmed.match(/^每月(\d{1,2})号$/)
  if (monthlyMatch) {
    const [, dayStr] = monthlyMatch
    const day = Number(dayStr)

    if (day < 1 || day > 31) {
      return errorResult(`无效的日期: ${dayStr}`)
    }

    const expression = `0 10 ${day} * *`
    return successResult(expression)
  }

  // No pattern matched
  return errorResult(`无法识别的调度描述: "${trimmed}"`)
}

// ── isValidTimezone ──────────────────────────────────────────────────

/**
 * Check whether a string is a valid IANA timezone identifier.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Convert a 12-hour clock number to 24-hour based on the Chinese
 * time-of-day period word.
 */
function convertTo24Hour(hour: number, period: string): number {
  switch (period) {
    case '早上':
    case '上午':
      // 早上/上午: 1-12 → 1-12 (12 AM edge case → 0)
      return hour === 12 ? 0 : hour
    case '中午':
      // 中午: 11 → 11, 12 → 12, 1 → 13
      return hour >= 11 && hour <= 12 ? hour : hour + 12
    case '下午':
      // 下午: 1-11 → 13-23, 12 → 12
      return hour === 12 ? 12 : hour + 12
    case '晚上':
      // 晚上: 1-11 → 13-23, 12 → 0
      return hour === 12 ? 0 : hour + 12
    default:
      return hour
  }
}

/**
 * Map a Chinese weekday character to a cron day-of-week number
 * (0 = Sunday, 1 = Monday, …, 6 = Saturday).
 */
function weekdayToCronNumber(char: string): number {
  const map: Record<string, number> = {
    '日': 0,
    '天': 0,
    '一': 1,
    '二': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
  }
  return map[char] ?? 1
}

/**
 * Build a successful NaturalLanguageCronResult.
 */
function successResult(expression: string): NaturalLanguageCronResult {
  const description = cronstrue.toString(expression, { locale: 'zh_CN' })
  const nextExecutions = calculateNextExecutions(expression, 'Asia/Shanghai', 5)

  return {
    expression,
    description,
    nextExecutions,
    confidence: 'high',
  }
}

/**
 * Build an error NaturalLanguageCronResult.
 */
function errorResult(error: string): NaturalLanguageCronResult {
  return {
    expression: '',
    description: '',
    nextExecutions: [],
    confidence: 'error',
    error,
  }
}
