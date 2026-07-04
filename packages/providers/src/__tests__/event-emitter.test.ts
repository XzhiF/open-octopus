import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from '../shared/event-emitter'

type TestEvents = {
  'message': { text: string; from: string }
  'disconnect': { reason: string }
  'ping': undefined
}

describe('EventEmitter', () => {
  // ─────────────────────────────────────────────────
  // on / emit
  // ─────────────────────────────────────────────────

  describe('on and emit', () => {
    it('should call listener when event is emitted', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener = vi.fn()

      emitter.on('message', listener)
      emitter.emit('message', { text: 'hello', from: 'alice' })

      expect(listener).toHaveBeenCalledOnce()
      expect(listener).toHaveBeenCalledWith({ text: 'hello', from: 'alice' })
    })

    it('should call all listeners for the same event', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener1 = vi.fn()
      const listener2 = vi.fn()

      emitter.on('message', listener1)
      emitter.on('message', listener2)
      emitter.emit('message', { text: 'hi', from: 'bob' })

      expect(listener1).toHaveBeenCalledOnce()
      expect(listener2).toHaveBeenCalledOnce()
    })

    it('should return true when listeners exist', () => {
      const emitter = new EventEmitter<TestEvents>()
      emitter.on('message', vi.fn())

      const result = emitter.emit('message', { text: 'test', from: 'x' })
      expect(result).toBe(true)
    })

    it('should return false when no listeners exist', () => {
      const emitter = new EventEmitter<TestEvents>()

      const result = emitter.emit('message', { text: 'test', from: 'x' })
      expect(result).toBe(false)
    })

    it('should handle events with undefined payload', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener = vi.fn()

      emitter.on('ping', listener)
      emitter.emit('ping')

      expect(listener).toHaveBeenCalledOnce()
    })

    it('should not call listeners for other events', () => {
      const emitter = new EventEmitter<TestEvents>()
      const messageListener = vi.fn()
      const disconnectListener = vi.fn()

      emitter.on('message', messageListener)
      emitter.on('disconnect', disconnectListener)
      emitter.emit('message', { text: 'hi', from: 'a' })

      expect(messageListener).toHaveBeenCalledOnce()
      expect(disconnectListener).not.toHaveBeenCalled()
    })
  })

  // ─────────────────────────────────────────────────
  // off
  // ─────────────────────────────────────────────────

  describe('off', () => {
    it('should remove a specific listener', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener = vi.fn()

      emitter.on('message', listener)
      emitter.off('message', listener)
      emitter.emit('message', { text: 'test', from: 'a' })

      expect(listener).not.toHaveBeenCalled()
    })

    it('should only remove the specified listener, not others', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener1 = vi.fn()
      const listener2 = vi.fn()

      emitter.on('message', listener1)
      emitter.on('message', listener2)
      emitter.off('message', listener1)
      emitter.emit('message', { text: 'test', from: 'a' })

      expect(listener1).not.toHaveBeenCalled()
      expect(listener2).toHaveBeenCalledOnce()
    })

    it('should be safe to call off for a listener that was never added', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener = vi.fn()

      expect(() => emitter.off('message', listener)).not.toThrow()
    })

    it('should be safe to call off for an event with no listeners', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener = vi.fn()

      expect(() => emitter.off('disconnect', listener)).not.toThrow()
    })
  })

  // ─────────────────────────────────────────────────
  // once
  // ─────────────────────────────────────────────────

  describe('once', () => {
    it('should call listener only once', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener = vi.fn()

      emitter.once('message', listener)
      emitter.emit('message', { text: 'first', from: 'a' })
      emitter.emit('message', { text: 'second', from: 'b' })

      expect(listener).toHaveBeenCalledOnce()
      expect(listener).toHaveBeenCalledWith({ text: 'first', from: 'a' })
    })

    it('should remove listener after first invocation', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener = vi.fn()

      emitter.once('message', listener)
      emitter.emit('message', { text: 'first', from: 'a' })

      // After first emit, the listener should be gone
      const hadListeners = emitter.emit('message', { text: 'second', from: 'b' })
      expect(hadListeners).toBe(false)
    })

    it('should be removable via off before being triggered', () => {
      const emitter = new EventEmitter<TestEvents>()
      const listener = vi.fn()

      emitter.once('message', listener)
      emitter.off('message', listener)
      emitter.emit('message', { text: 'test', from: 'a' })

      expect(listener).not.toHaveBeenCalled()
    })
  })

  // ─────────────────────────────────────────────────
  // Error handling
  // ─────────────────────────────────────────────────

  describe('error handling', () => {
    it('should catch listener errors and not throw', () => {
      const emitter = new EventEmitter<TestEvents>()

      emitter.on('message', () => {
        throw new Error('listener boom')
      })

      expect(() => {
        emitter.emit('message', { text: 'test', from: 'a' })
      }).not.toThrow()
    })

    it('should continue calling remaining listeners after one throws', () => {
      const emitter = new EventEmitter<TestEvents>()
      const safeListener = vi.fn()

      emitter.on('message', () => {
        throw new Error('listener boom')
      })
      emitter.on('message', safeListener)

      emitter.emit('message', { text: 'test', from: 'a' })

      expect(safeListener).toHaveBeenCalledOnce()
    })

    it('should still return true when a listener throws but others exist', () => {
      const emitter = new EventEmitter<TestEvents>()

      emitter.on('message', () => {
        throw new Error('boom')
      })

      const result = emitter.emit('message', { text: 'test', from: 'a' })
      expect(result).toBe(true)
    })

    it('should catch errors in once listeners', () => {
      const emitter = new EventEmitter<TestEvents>()

      emitter.once('message', () => {
        throw new Error('once boom')
      })

      expect(() => {
        emitter.emit('message', { text: 'test', from: 'a' })
      }).not.toThrow()
    })
  })
})
