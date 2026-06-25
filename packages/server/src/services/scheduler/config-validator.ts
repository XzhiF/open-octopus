import { configSchemasByJobType, type JobType, type JobConfig } from '@octopus/shared'
import { ConfigValidationError } from './config-validator-errors'

export { ConfigValidationError }

export function validateConfig(jobType: JobType, config: unknown): JobConfig {
  const schema = configSchemasByJobType[jobType]
  if (!schema) {
    throw new ConfigValidationError(`Unknown job type: ${jobType}`)
  }

  const result = schema.safeParse(config)
  if (!result.success) {
    const details = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ConfigValidationError(`config: ${details}`)
  }

  return result.data as JobConfig
}

export function mergeConfig(existing: JobConfig, updates: Partial<JobConfig>): JobConfig {
  return {
    ...existing,
    ...updates,
    schema_version: existing.schema_version,
    type: existing.type,
  } as JobConfig
}
