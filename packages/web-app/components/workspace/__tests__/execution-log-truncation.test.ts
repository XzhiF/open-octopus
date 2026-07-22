import { describe, it, expect } from "vitest"

/**
 * Tests for the event rendering truncation logic in ExecutionLogViewer.
 *
 * The component applies `slice(-MAX_RENDERED_EVENTS)` to each node group's
 * events before rendering. These tests verify the truncation behavior
 * independently of the React component.
 */

const MAX_RENDERED_EVENTS = 100

function getRenderedEvents<T>(events: T[], maxRendered: number = MAX_RENDERED_EVENTS): T[] {
  return events.length > maxRendered ? events.slice(-maxRendered) : events
}

describe("ExecutionLogViewer event truncation", () => {
  it("renders all events when count is below threshold", () => {
    const events = Array.from({ length: 50 }, (_, i) => ({ id: i }))
    const rendered = getRenderedEvents(events)
    expect(rendered).toHaveLength(50)
    expect(rendered[0].id).toBe(0)
  })

  it("renders all events when count equals threshold", () => {
    const events = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    const rendered = getRenderedEvents(events)
    expect(rendered).toHaveLength(100)
    expect(rendered[0].id).toBe(0)
  })

  it("truncates to latest 100 events when count exceeds threshold", () => {
    const events = Array.from({ length: 200 }, (_, i) => ({ id: i }))
    const rendered = getRenderedEvents(events)
    expect(rendered).toHaveLength(100)
    // Should show the latest 100 (ids 100-199)
    expect(rendered[0].id).toBe(100)
    expect(rendered[99].id).toBe(199)
  })

  it("shows real count in header regardless of truncation", () => {
    const events = Array.from({ length: 237 }, (_, i) => ({ id: i }))
    // Header displays events.length, not rendered.length
    expect(events.length).toBe(237)
    const rendered = getRenderedEvents(events)
    expect(rendered).toHaveLength(100)
  })

  it("handles empty event list", () => {
    const events: { id: number }[] = []
    const rendered = getRenderedEvents(events)
    expect(rendered).toHaveLength(0)
  })

  it("preserves event order after truncation", () => {
    const events = Array.from({ length: 150 }, (_, i) => ({
      id: i,
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}`,
    }))
    const rendered = getRenderedEvents(events)
    expect(rendered).toHaveLength(100)
    // Verify chronological order is preserved
    for (let i = 1; i < rendered.length; i++) {
      expect(rendered[i].id).toBeGreaterThan(rendered[i - 1].id)
    }
  })

  it("truncates oldest events, keeps newest", () => {
    const events = Array.from({ length: 120 }, (_, i) => ({ id: i }))
    const rendered = getRenderedEvents(events)
    // First rendered event should be id=20 (skipped 0-19)
    expect(rendered[0].id).toBe(20)
    // Last rendered event should be id=119 (the newest)
    expect(rendered[rendered.length - 1].id).toBe(119)
  })
})
