import type { IAgentProvider, SendQueryOptions, MessageChunk } from '../../types'

export class FauxPiProvider implements IAgentProvider {
  private chunkSequence: MessageChunk[]

  constructor(chunks?: MessageChunk[]) {
    this.chunkSequence = chunks ?? [
      { type: 'message_start', messageId: 'faux-msg-1' },
      { type: 'text_delta', content: 'Hello from faux provider. ', messageId: 'faux-msg-1' },
      { type: 'text_delta', content: 'This is a deterministic test response.', messageId: 'faux-msg-1' },
      { type: 'text_done', messageId: 'faux-msg-1' },
      { type: 'message_stop', messageId: 'faux-msg-1' },
      {
        type: 'result',
        content: 'Hello from faux provider. This is a deterministic test response.',
        sessionId: 'faux-session-1',
        tokens: { input: 10, output: 15, total: 25 },
        costUsd: 0,
      },
    ]
  }

  getType(): string {
    return 'pi'
  }

  async *sendQuery(
    _prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    _options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    for (const chunk of this.chunkSequence) {
      yield chunk
    }
  }
}

export function fauxWithToolCall(): FauxPiProvider {
  return new FauxPiProvider([
    { type: 'message_start', messageId: 'faux-msg-2' },
    { type: 'text_delta', content: 'Let me check the files.', messageId: 'faux-msg-2' },
    { type: 'tool_call_start', toolCallId: 'faux-tool-1', toolName: 'Bash', messageId: 'faux-msg-2' },
    { type: 'tool_call', toolCallId: 'faux-tool-1', toolName: 'Bash', toolInput: { command: 'ls' }, messageId: 'faux-msg-2' },
    { type: 'tool_result', toolCallId: 'faux-tool-1', content: 'file1.txt\nfile2.txt' },
    { type: 'text_delta', content: 'Found 2 files.', messageId: 'faux-msg-2' },
    { type: 'text_done', messageId: 'faux-msg-2' },
    { type: 'message_stop', messageId: 'faux-msg-2' },
    {
      type: 'result',
      content: 'Found 2 files.',
      sessionId: 'faux-session-2',
      tokens: { input: 20, output: 30, total: 50 },
    },
  ])
}
