export interface TransactionStep {
  description: string
  execute: () => void
  undo: () => void
}

export class InstallTransaction {
  private completedUndos: Array<() => void> = []

  addStep(undo: () => void): void {
    this.completedUndos.push(undo)
  }

  async execute(steps: TransactionStep[]): Promise<void> {
    for (const step of steps) {
      try {
        step.execute()
        this.addStep(step.undo)
      } catch (err) {
        // Rollback all completed steps in reverse order
        this.rollback()
        throw err
      }
    }
  }

  rollback(): void {
    // Reverse order undo
    while (this.completedUndos.length > 0) {
      const undo = this.completedUndos.pop()
      if (undo) {
        try {
          undo()
        } catch {
          // Best effort rollback — continue undoing remaining steps
        }
      }
    }
  }
}
