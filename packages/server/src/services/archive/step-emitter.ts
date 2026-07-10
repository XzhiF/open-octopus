export interface StepEmitter {
  stepStart(step: string, detail: string): Promise<void>
  stepProgress(step: string, detail: string): Promise<void>
  stepDone(step: string, data?: Record<string, unknown>): Promise<void>
  stepError(step: string, message: string): Promise<void>
  log(message: string): Promise<void>
  complete(data: Record<string, unknown>): Promise<void>
}

export function createStepEmitter(stream: { writeSSE: (e: { event: string; data: string }) => Promise<void> | void }): StepEmitter {
  const write = async (event: string, data: unknown) => {
    try {
      await stream.writeSSE({ event, data: JSON.stringify(data) })
    } catch {
      // Client disconnected — continue emitting
    }
  }

  return {
    async stepStart(step: string, detail: string) {
      await write("step", { step, status: "running", detail })
    },
    async stepProgress(step: string, detail: string) {
      await write("step", { step, status: "progress", detail })
    },
    async stepDone(step: string, data?: Record<string, unknown>) {
      await write("step", { step, status: "done", data })
    },
    async stepError(step: string, message: string) {
      await write("step", { step, status: "error", detail: message })
    },
    async log(message: string) {
      await write("log", { message })
    },
    async complete(data: Record<string, unknown>) {
      await write("complete", data)
    },
  }
}

export function createNullEmitter(): StepEmitter {
  const noop = async () => {}
  return {
    stepStart: noop,
    stepProgress: noop,
    stepDone: noop,
    stepError: noop,
    log: noop,
    complete: noop,
  }
}
