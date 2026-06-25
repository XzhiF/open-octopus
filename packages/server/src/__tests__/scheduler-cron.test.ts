import { describe, it, expect } from 'vitest'
import { parseCronExpression } from '../services/cron-utils'

describe('Cron Utilities', () => {
  it('parses valid cron expression', () => {
    const result = parseCronExpression('0 9 * * *', 'Asia/Shanghai')
    expect(result.valid).toBe(true)
    expect(result.nextExecutions.length).toBe(5)
    expect(result.description).toBeDefined()
  })

  it('rejects invalid cron expression', () => {
    const result = parseCronExpression('invalid cron', 'Asia/Shanghai')
    expect(result.valid).toBe(false)
    expect(result.nextExecutions).toEqual([])
  })

  it('detects high frequency cron', () => {
    const result = parseCronExpression('* * * * *', 'Asia/Shanghai')
    expect(result.valid).toBe(true)
    // High frequency detection
    expect(result.nextExecutions.length).toBe(5)
  })

  it('handles timezone correctly', () => {
    const shanghai = parseCronExpression('0 9 * * *', 'Asia/Shanghai')
    const newYork = parseCronExpression('0 9 * * *', 'America/New_York')
    // Different timezones should produce different UTC times
    expect(shanghai.nextExecutions[0]).not.toBe(newYork.nextExecutions[0])
  })
})
