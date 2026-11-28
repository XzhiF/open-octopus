/// 每轮 assistant 的计时 / token / 缓存 / 费用（原型折叠头的 `9s · 1.2K tok · ¥0.06`）。
///
/// 与桌面 `web-app/lib/turn-stats.ts` 同一套归属规则，手机端只做只读投影：
/// ① 账本行带 `message_id` → 精确归到那条 assistant 消息；
/// ② 聊天路径目前多数行不带 message_id → 按「真人用户消息边界」切窗：
///    [本条所属用户消息, 下一条用户消息)。assistant.created_at 是流式中途
///    flush 写入的，不能当窗口终点（结果 chunk 常在它之后到账）。
/// ③ displayType='event' 的 user 行是系统事件卡，不算「人说话」，不能当边界；
/// ④ 同一窗里有多个 assistant 分段时，再按各段自己的 created_at 切一刀；
/// ⑤ `session_compress` 行是后台压缩，不属于任何对话轮，先排除。
library;

import 'models/chat.dart';
import 'models/telemetry.dart';

int? _tsOf(String? iso) {
  if (iso == null || iso.trim().isEmpty) return null;
  return DateTime.tryParse(iso)?.millisecondsSinceEpoch;
}

TurnStats _statsFromRows(List<LlmCallRow> rows) {
  var input = 0;
  var output = 0;
  var cacheRead = 0;
  var cacheCreate = 0;
  var calls = 0;
  int? spanStart;
  int? spanEnd;
  double? cost;
  var costComplete = true;
  final models = <String>[];

  for (final row in rows) {
    calls++;
    input += row.usage.inputTokens;
    output += row.usage.outputTokens;
    cacheRead += row.usage.cacheReadTokens;
    cacheCreate += row.usage.cacheCreationTokens;
    final model = row.model;
    if (model != null && model.isNotEmpty && !models.contains(model)) {
      models.add(model);
    }
    if (row.costUsd != null) {
      cost = (cost ?? 0) + row.costUsd!;
    } else {
      costComplete = false;
    }
    final end = row.timestamp;
    final start = end - row.durationMs;
    spanStart = spanStart == null || start < spanStart ? start : spanStart;
    spanEnd = spanEnd == null || end > spanEnd ? end : spanEnd;
  }

  final span = spanStart != null && spanEnd != null ? spanEnd - spanStart : 0;

  return TurnStats(
    durationMs: span > 0 ? span : 0,
    calls: calls,
    usage: TokenUsage(
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreate,
    ),
    costUsd: cost,
    costComplete: costComplete,
    models: models,
  );
}

/// 消息列表 + 账本行 → sourceMessageId → 本轮统计。
///
/// 折叠块可以包含多个 assistant 分段（注入续写），统计按块内所有分段求和：
/// 同一条用户消息下的小段本来就属于同一轮。
Map<String, TurnStats> buildTurnStats(
  List<ChatMessage> messages,
  List<LlmCallRow> calls,
) {
  final out = <String, TurnStats>{};
  if (messages.isEmpty) return out;

  final usable = calls
      .where((c) => c.sourcePath != 'session_compress')
      .toList(growable: false);
  if (usable.isEmpty) return out;

  final byMessage = <String, List<LlmCallRow>>{};
  for (final call in usable) {
    final id = call.messageId;
    if (id == null || id.isEmpty) continue;
    (byMessage[id] ??= <LlmCallRow>[]).add(call);
  }
  final ordered = [...usable]
    ..sort((a, b) => a.timestamp.compareTo(b.timestamp));

  // 真·用户发言的时间点（事件卡不算）。
  final userStarts =
      messages
          .where((m) => m.isUser && m.displayType != 'event')
          .map((m) => _tsOf(m.createdAt))
          .whereType<int>()
          .toSet()
          .toList()
        ..sort();

  int? fallbackStart;
  for (final m in messages) {
    final t = _tsOf(m.createdAt);
    if (t != null && (fallbackStart == null || t < fallbackStart)) {
      fallbackStart = t;
    }
  }

  bool isHumanStart(int t) => userStarts.contains(t);

  int? turnStartOf(int t) {
    int? start;
    for (final s in userStarts) {
      if (s <= t) {
        start = s;
      } else {
        break;
      }
    }
    if (start != null) return start;
    return fallbackStart != null && fallbackStart <= t ? fallbackStart : null;
  }

  int turnEndOf(int start) {
    if (!isHumanStart(start)) return 1 << 62;
    for (final s in userStarts) {
      if (s > start) return s;
    }
    return 1 << 62;
  }

  // 有过程条目的 assistant 段起点（同一用户窗内的分片边界）。
  final segmentStarts = <({String id, int ts})>[];
  final seen = <String>{};
  for (final m in messages) {
    if (m.isUser) continue;
    if (m.displayType == 'event') continue;
    final id = m.sourceId;
    if (!seen.add(id)) continue;
    final t = _tsOf(m.createdAt);
    if (t != null) segmentStarts.add((id: id, ts: t));
  }
  segmentStarts.sort((a, b) => a.ts.compareTo(b.ts));

  for (final segment in segmentStarts) {
    var rows = byMessage[segment.id] ?? const <LlmCallRow>[];
    if (rows.isEmpty) {
      final start = turnStartOf(segment.ts);
      if (start == null) continue;
      final end = turnEndOf(start);
      final peers = segmentStarts
          .where((s) => s.ts >= start && s.ts < end)
          .toList(growable: false);
      final index = peers.indexWhere((p) => p.id == segment.id);
      // 首段从用户发言起算（标题生成等前置调用也算本轮）；其余从各自起点起算。
      final lo = index > 0 ? peers[index].ts : start;
      final hi = index >= 0 && index + 1 < peers.length
          ? peers[index + 1].ts
          : end;
      rows = ordered
          .where((c) => c.timestamp >= lo && c.timestamp < hi)
          .toList(growable: false);
    }
    if (rows.isEmpty) continue;
    out[segment.id] = _statsFromRows(rows);
  }

  return out;
}
