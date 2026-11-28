import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/models/chat.dart';
import 'package:octopus_mobile/core/models/telemetry.dart';
import 'package:octopus_mobile/core/turn_stats.dart';

ChatMessage _row({
  required String id,
  required String role,
  required String displayType,
  required String createdAt,
  String content = '',
  String? sourceId,
}) => ChatMessage(
  id: id,
  sessionId: 's1',
  role: role,
  type: 'text',
  content: content,
  createdAt: createdAt,
  meta: {
    'displayType': displayType,
    if (sourceId != null) 'sourceId': sourceId,
    if (displayType == 'thinking') 'thinkingContent': content,
  },
);

LlmCallRow _call({
  required int timestamp,
  int durationMs = 0,
  int input = 0,
  int output = 0,
  int cacheRead = 0,
  String? messageId,
  String? sourcePath,
  double? costUsd,
}) => LlmCallRow(
  timestamp: timestamp,
  durationMs: durationMs,
  usage: TokenUsage(
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
  ),
  messageId: messageId,
  sourcePath: sourcePath,
  costUsd: costUsd,
);

int _ms(String iso) => DateTime.parse(iso).millisecondsSinceEpoch;

void main() {
  test('按真人用户消息切窗：两轮的账各归各的', () {
    final messages = [
      _row(
        id: 'u1',
        role: 'user',
        displayType: 'user',
        createdAt: '2026-11-27T10:00:00Z',
      ),
      _row(
        id: 'a1',
        role: 'assistant',
        displayType: 'thinking',
        createdAt: '2026-11-27T10:00:05Z',
        content: '想一下',
        sourceId: 'a1',
      ),
      _row(
        id: 'a1-text',
        role: 'assistant',
        displayType: 'text',
        createdAt: '2026-11-27T10:00:05Z',
        content: '好',
        sourceId: 'a1',
      ),
      _row(
        id: 'u2',
        role: 'user',
        displayType: 'user',
        createdAt: '2026-11-27T10:02:00Z',
      ),
      _row(
        id: 'a2',
        role: 'assistant',
        displayType: 'text',
        createdAt: '2026-11-27T10:02:03Z',
        content: '收到',
        sourceId: 'a2',
      ),
    ];
    final calls = [
      _call(
        timestamp: _ms('2026-11-27T10:00:20Z'),
        durationMs: 15000,
        input: 100,
        output: 20,
        costUsd: .001,
      ),
      _call(
        timestamp: _ms('2026-11-27T10:02:10Z'),
        durationMs: 5000,
        input: 200,
        output: 40,
        costUsd: .002,
      ),
    ];

    final stats = buildTurnStats(messages, calls);
    expect(stats['a1']!.tokens, 120);
    expect(stats['a1']!.durationMs, 15000);
    expect(stats['a1']!.costUsd, closeTo(.001, 1e-9));
    expect(stats['a2']!.tokens, 240);
    expect(stats['a2']!.durationMs, 5000);
    expect(stats['a2']!.costUsd, closeTo(.002, 1e-9));
  });

  test('账本带 message_id 时精确归属，不受时间窗影响', () {
    final messages = [
      _row(
        id: 'u1',
        role: 'user',
        displayType: 'user',
        createdAt: '2026-11-27T10:00:00Z',
      ),
      _row(
        id: 'a1',
        role: 'assistant',
        displayType: 'text',
        createdAt: '2026-11-27T10:00:03Z',
        content: '好',
        sourceId: 'a1',
      ),
    ];
    final calls = [
      _call(
        timestamp: _ms('2026-11-27T11:00:00Z'), // 晚于最后一条用户消息
        input: 50,
        output: 10,
        messageId: 'a1',
      ),
    ];

    final stats = buildTurnStats(messages, calls);
    expect(stats['a1']!.tokens, 60);
  });

  test('事件卡不是用户发言，不能当轮次边界', () {
    final messages = [
      _row(
        id: 'u1',
        role: 'user',
        displayType: 'user',
        createdAt: '2026-11-27T10:00:00Z',
      ),
      _row(
        id: 'a1',
        role: 'assistant',
        displayType: 'text',
        createdAt: '2026-11-27T10:00:02Z',
        content: '好',
        sourceId: 'a1',
      ),
      // 系统写进对话的事件卡：role=user，但 displayType=event。
      _row(
        id: 'ev',
        role: 'user',
        displayType: 'event',
        createdAt: '2026-11-27T10:00:10Z',
        content: '任务状态变更',
      ),
    ];
    final calls = [
      _call(timestamp: _ms('2026-11-27T10:00:30Z'), input: 30, output: 10),
    ];

    final stats = buildTurnStats(messages, calls);
    // 若事件卡被当边界，这一行会落进「事件卡之后」的新窗口而丢失。
    expect(stats['a1']!.tokens, 40);
  });

  test('后台压缩行不属于任何对话轮', () {
    final messages = [
      _row(
        id: 'u1',
        role: 'user',
        displayType: 'user',
        createdAt: '2026-11-27T10:00:00Z',
      ),
      _row(
        id: 'a1',
        role: 'assistant',
        displayType: 'text',
        createdAt: '2026-11-27T10:00:02Z',
        content: '好',
        sourceId: 'a1',
      ),
    ];
    final calls = [
      _call(timestamp: _ms('2026-11-27T10:00:05Z'), input: 10, output: 5),
      _call(
        timestamp: _ms('2026-11-27T10:00:06Z'),
        input: 9999,
        output: 9999,
        sourcePath: 'session_compress',
      ),
    ];

    final stats = buildTurnStats(messages, calls);
    expect(stats['a1']!.tokens, 15);
    expect(stats['a1']!.calls, 1);
  });

  test('未定价轮：token 照常、费用 null、complete=false', () {
    final messages = [
      _row(
        id: 'u1',
        role: 'user',
        displayType: 'user',
        createdAt: '2026-11-27T10:00:00Z',
      ),
      _row(
        id: 'a1',
        role: 'assistant',
        displayType: 'text',
        createdAt: '2026-11-27T10:00:02Z',
        content: '好',
        sourceId: 'a1',
      ),
    ];
    final calls = [
      _call(timestamp: _ms('2026-11-27T10:00:05Z'), input: 10, output: 5),
      _call(
        timestamp: _ms('2026-11-27T10:00:06Z'),
        input: 10,
        output: 5,
        costUsd: .001,
      ),
    ];

    final stats = buildTurnStats(messages, calls)['a1']!;
    expect(stats.tokens, 30);
    expect(stats.costUsd, closeTo(.001, 1e-9));
    expect(stats.costComplete, isFalse);
  });
}
