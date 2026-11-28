import 'dart:convert';

import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../core/format.dart';
import '../core/models/chat.dart';
import '../core/models/telemetry.dart';

/// 会话内容＝桌面同一套 TUI 语法（`❯` / `✦ 汐音 + meta` / `◌` / `▸ tool [✓]` / `✳`）。
/// 换皮肤不换内容：这里只决定字号与配色，不重排信息。
///
/// 2026-11-27 起与原型 chat 内场对齐：assistant 的 think / 工具默认折成一行
/// 摘要（步数 · 工具 · tok · 费用），点开才看步骤；正文仍直接露出。
class TuiTranscript extends StatelessWidget {
  const TuiTranscript({
    super.key,
    required this.messages,
    this.live,
    this.turnStats = const {},
    this.userKeys = const {},
    this.flashUserId,
  });

  final List<ChatMessage> messages;
  final LiveTurn? live;

  /// sourceMessageId → 本轮统计（来自会话账本；没有账本行就没有 key）。
  final Map<String, TurnStats> turnStats;

  /// 用户消息 id → 滚动定位用的 key（轮次抽屉跳转）。
  final Map<String, GlobalKey> userKeys;

  /// 刚从轮次抽屉跳过来的那条用户消息：闪一下粉。
  final String? flashUserId;

  @override
  Widget build(BuildContext context) {
    final segments = _segment(messages);
    final rows = <Widget>[];

    for (final segment in segments) {
      switch (segment) {
        case _UserSegment(:final message):
          rows.add(
            _TuiUserRow(
              key: userKeys[message.id],
              text: message.content,
              flash: message.id == flashUserId,
            ),
          );
        case _SystemSegment(:final message):
          if (message.content.trim().isEmpty) continue;
          rows.add(_TuiSystemRow(text: message.content));
        case _AssistantSegment(rows: final part):
          rows.add(
            _AssistantBlockView(
              key: ValueKey(part.isEmpty ? '__empty__' : part.first.sourceId),
              messages: part,
              stats: _statsOf(part),
            ),
          );
      }
    }

    final l = live;
    if (l != null && l.hasAnything) {
      rows.add(_LiveBlockView(key: const ValueKey('__live__'), live: l));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in rows)
          Padding(padding: const EdgeInsets.only(bottom: 13), child: row),
      ],
    );
  }

  TurnStats? _statsOf(List<ChatMessage> rows) {
    for (final row in rows) {
      final stats = turnStats[row.sourceId];
      if (stats != null) return stats;
    }
    return null;
  }

  List<_Segment> _segment(List<ChatMessage> messages) {
    final out = <_Segment>[];
    for (final m in messages) {
      if (m.isUser) {
        out.add(_UserSegment(m));
      } else if (m.displayType == 'system') {
        out.add(_SystemSegment(m));
      } else {
        final last = out.isEmpty ? null : out.last;
        if (last is _AssistantSegment) {
          out[out.length - 1] = _AssistantSegment([...last.rows, m]);
        } else {
          out.add(_AssistantSegment([m]));
        }
      }
    }
    return out;
  }
}

sealed class _Segment {
  const _Segment();
}

class _UserSegment extends _Segment {
  const _UserSegment(this.message);

  final ChatMessage message;
}

class _SystemSegment extends _Segment {
  const _SystemSegment(this.message);

  final ChatMessage message;
}

class _AssistantSegment extends _Segment {
  const _AssistantSegment(this.rows);

  final List<ChatMessage> rows;
}

class _TuiSystemRow extends StatelessWidget {
  const _TuiSystemRow({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.only(left: 8),
      decoration: const BoxDecoration(
        border: Border(left: BorderSide(color: Color(0x338D86B8))),
      ),
      child: Text(
        '· $text',
        style: const TextStyle(
          fontFamily: Octo.mono,
          fontSize: 10.5,
          height: 1.65,
          color: Octo.dim,
        ),
      ),
    );
  }
}

class _TuiUserRow extends StatelessWidget {
  const _TuiUserRow({super.key, required this.text, this.flash = false});

  final String text;
  final bool flash;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 260),
      padding: const EdgeInsets.fromLTRB(9, 2, 9, 2),
      decoration: BoxDecoration(
        color: flash ? Octo.pink.withValues(alpha: .13) : Colors.transparent,
        borderRadius: BorderRadius.circular(4),
        border: Border(
          left: BorderSide(
            color: flash ? Octo.pink : const Color(0x80F5C542),
            width: 2,
          ),
        ),
        boxShadow: flash
            ? [
                BoxShadow(
                  color: Octo.pink.withValues(alpha: .18),
                  blurRadius: 14,
                ),
              ]
            : null,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(right: 6),
            child: Text(
              '❯',
              style: TextStyle(
                fontFamily: Octo.mono,
                fontSize: 11.5,
                fontWeight: FontWeight.w800,
                color: Octo.pink,
              ),
            ),
          ),
          Expanded(
            child: SelectableText(
              text,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 11.5,
                height: 1.65,
                color: Colors.white,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 完成态的 assistant 块：一行摘要头 + 可折叠的过程 + 正文。
class _AssistantBlockView extends StatefulWidget {
  const _AssistantBlockView({
    super.key,
    required this.messages,
    required this.stats,
  });

  final List<ChatMessage> messages;
  final TurnStats? stats;

  @override
  State<_AssistantBlockView> createState() => _AssistantBlockViewState();
}

class _AssistantBlockViewState extends State<_AssistantBlockView> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final process = _processRows(widget.messages);
    final texts = _textRows(widget.messages);
    final steps = process.length + texts.length;
    final tools = widget.messages
        .where((m) => m.displayType == 'tool_call')
        .length;
    final interrupted = widget.messages.any((m) => m.interrupted);
    final error = widget.messages
        .map((m) => m.errorMessage)
        .whereType<String>()
        .firstOrNull;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _MetaLine(
          done: true,
          steps: steps,
          tools: tools,
          stats: widget.stats,
          expandable: process.isNotEmpty,
          expanded: _expanded,
          onTap: process.isEmpty
              ? null
              : () => setState(() => _expanded = !_expanded),
        ),
        if (_expanded && process.isNotEmpty) _MetaBody(rows: process),
        for (final row in texts) ...[
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: _TuiAssistantText(text: row.content),
          ),
        ],
        if (interrupted)
          const Padding(
            padding: EdgeInsets.only(top: 4, left: 9),
            child: Text(
              '◼ 本轮被截断',
              style: TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10,
                color: Octo.faint,
              ),
            ),
          ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: _TuiErrorRow(message: error),
          ),
      ],
    );
  }

  List<ChatMessage> _processRows(List<ChatMessage> rows) => rows
      .where(
        (m) =>
            m.displayType == 'thinking' ||
            m.displayType == 'tool_call' ||
            m.displayType == 'ask_user_question',
      )
      .toList(growable: false);

  List<ChatMessage> _textRows(List<ChatMessage> rows) => rows
      .where((m) => m.displayType == 'text' && m.content.trim().isNotEmpty)
      .toList(growable: false);
}

/// 正在跑的一轮：头上一行，过程默认折叠，正文随流出现。
class _LiveBlockView extends StatefulWidget {
  const _LiveBlockView({super.key, required this.live});

  final LiveTurn live;

  @override
  State<_LiveBlockView> createState() => _LiveBlockViewState();
}

class _LiveBlockViewState extends State<_LiveBlockView> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final live = widget.live;
    final steps =
        live.tools.length +
        (live.thinking.isEmpty ? 0 : 1) +
        (live.text.isEmpty ? 0 : 1);
    final hasProcess = live.thinking.isNotEmpty || live.tools.isNotEmpty;
    final stats = live.totalTokens > 0 || live.costUsd != null
        ? TurnStats(
            durationMs: 0,
            calls: live.totalTokens > 0 ? 1 : 0,
            usage: TokenUsage(
              inputTokens: live.inputTokens,
              outputTokens: live.outputTokens,
              cacheReadTokens: live.cacheReadTokens,
              cacheCreationTokens: live.cacheCreationTokens,
            ),
            costUsd: live.costUsd,
            costComplete: true,
            models: const [],
          )
        : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _MetaLine(
          done: live.done,
          steps: steps,
          tools: live.tools.length,
          stats: stats,
          expandable: hasProcess,
          expanded: _expanded,
          onTap: hasProcess
              ? () => setState(() => _expanded = !_expanded)
              : null,
        ),
        if (_expanded && hasProcess)
          _MetaBody(thinking: live.thinking, tools: live.tools),
        if (live.text.trim().isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: _TuiAssistantText(text: live.text),
          ),
        if (live.errorMessage != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: _TuiErrorRow(
              code: live.errorCode,
              message: live.errorMessage!,
            ),
          ),
      ],
    );
  }
}

/// 摘要头（原型 `.head`）：`✦ 汐音 · 已完成 · 9s · 3 步 · 工具 1 · 1.2K tok · ¥0.06 ▸`。
class _MetaLine extends StatelessWidget {
  const _MetaLine({
    required this.done,
    required this.steps,
    required this.tools,
    required this.stats,
    required this.expandable,
    required this.expanded,
    this.onTap,
  });

  final bool done;
  final int steps;
  final int tools;
  final TurnStats? stats;
  final bool expandable;
  final bool expanded;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    const base = TextStyle(
      fontFamily: Octo.mono,
      fontSize: 10.5,
      height: 1.7,
      color: Octo.dim,
    );
    final duration = stats?.durationLabel ?? '';
    final showTokens = stats != null && stats!.calls > 0;
    final cost = stats == null || stats!.calls == 0
        ? null
        : formatCny(stats!.costUsd, complete: stats!.costComplete);

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Text.rich(
        TextSpan(
          style: base,
          children: [
            const TextSpan(
              text: '✦ 汐音',
              style: TextStyle(
                fontWeight: FontWeight.w800,
                color: Octo.purple,
                shadows: [Shadow(color: Color(0x80C9BFFF), blurRadius: 10)],
              ),
            ),
            const TextSpan(text: '  '),
            TextSpan(
              text: done ? '已完成' : '运行中',
              style: TextStyle(
                fontWeight: FontWeight.w700,
                color: done ? Octo.green : Octo.amber,
              ),
            ),
            if (duration.isNotEmpty) ...[
              const TextSpan(text: ' · '),
              TextSpan(
                text: duration,
                style: const TextStyle(color: Octo.pink),
              ),
            ],
            const TextSpan(text: ' · '),
            TextSpan(
              text: '$steps 步',
              style: const TextStyle(
                color: Octo.ink,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (tools > 0) ...[
              const TextSpan(text: ' · '),
              TextSpan(
                text: '工具 $tools',
                style: const TextStyle(color: Octo.teal),
              ),
            ],
            if (showTokens) ...[
              const TextSpan(text: ' · '),
              TextSpan(
                text: '${formatTokNum(stats!.tokens)} tok',
                style: const TextStyle(color: Octo.green),
              ),
              if (cost != null) ...[
                const TextSpan(text: ' · '),
                TextSpan(
                  text: cost,
                  style: const TextStyle(color: Octo.gold),
                ),
              ],
            ],
            if (expandable) ...[
              const TextSpan(text: ' '),
              TextSpan(
                text: expanded ? '▾' : '▸',
                style: const TextStyle(fontSize: 8.5, color: Octo.teal),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 过程明细（原型 `.metabody`）：左侧细线，think 与工具各一行。
class _MetaBody extends StatelessWidget {
  const _MetaBody({this.rows, this.thinking, this.tools});

  final List<ChatMessage>? rows;
  final String? thinking;
  final List<LiveTool>? tools;

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    if (rows != null) {
      for (final row in rows!) {
        if (row.displayType == 'thinking') {
          final text = row.thinkingContent ?? row.content;
          if (text.trim().isNotEmpty) {
            children.add(
              _ThinkLine(text: text, duration: row.thinkingDuration),
            );
          }
        } else if (row.displayType == 'tool_call' ||
            row.displayType == 'ask_user_question') {
          children.add(
            ToolLine(
              name: row.toolName ?? 'tool',
              input: row.toolInputText,
              status: row.toolStatus,
              duration: row.toolDuration,
            ),
          );
        }
      }
    }
    if (thinking != null && thinking!.trim().isNotEmpty) {
      children.add(_ThinkLine(text: thinking!));
    }
    if (tools != null) {
      for (final tool in tools!) {
        children.add(
          ToolLine(
            name: tool.name,
            input: tool.inputText,
            status: tool.status,
            duration: tool.duration,
          ),
        );
      }
    }

    return Container(
      margin: const EdgeInsets.only(top: 3, left: 3),
      padding: const EdgeInsets.only(left: 9),
      decoration: const BoxDecoration(
        border: Border(left: BorderSide(color: Color(0x478D86B8))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final child in children)
            Padding(padding: const EdgeInsets.only(bottom: 2), child: child),
        ],
      ),
    );
  }
}

class _ThinkLine extends StatelessWidget {
  const _ThinkLine({required this.text, this.duration});

  final String text;
  final String? duration;

  @override
  Widget build(BuildContext context) {
    return Text(
      duration == null ? '◌ $text' : '◌ $text  ($duration)',
      style: const TextStyle(
        fontFamily: Octo.mono,
        fontSize: 10.5,
        height: 1.65,
        color: Octo.dim,
      ),
    );
  }
}

class _TuiAssistantText extends StatelessWidget {
  const _TuiAssistantText({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.only(right: 6),
          child: Text(
            '✳',
            style: TextStyle(
              fontFamily: Octo.mono,
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
              color: Color(0xD9FF6FB5),
            ),
          ),
        ),
        Expanded(
          child: SelectableText(
            text.trimRight(),
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 11.5,
              height: 1.65,
              color: Octo.ink,
            ),
          ),
        ),
      ],
    );
  }
}

/// 工具行（原型 `.tool`）：`▸ Edit spec/phase-1.md [✓]`。
class ToolLine extends StatelessWidget {
  const ToolLine({
    super.key,
    required this.name,
    required this.input,
    required this.status,
    required this.duration,
  });

  final String name;
  final String? input;
  final String status;
  final String? duration;

  @override
  Widget build(BuildContext context) {
    final (mark, color) = switch (status) {
      'error' => ('[✗]', Octo.red),
      'running' => ('[…]', Octo.amber),
      _ => ('[✓]', Octo.green),
    };
    final arg = shortToolArg(name, input);
    return Text.rich(
      TextSpan(
        style: const TextStyle(
          fontFamily: Octo.mono,
          fontSize: 10.5,
          height: 1.65,
        ),
        children: [
          const TextSpan(
            text: '▸ ',
            style: TextStyle(color: Octo.teal),
          ),
          TextSpan(
            text: name,
            style: const TextStyle(
              color: Color(0xFF7FB7FF),
              fontWeight: FontWeight.w700,
            ),
          ),
          if (arg != null)
            TextSpan(
              text: ' $arg',
              style: const TextStyle(color: Octo.dim),
            ),
          if (duration != null && status != 'running')
            TextSpan(
              text: ' $duration',
              style: const TextStyle(color: Octo.faint),
            ),
          TextSpan(
            text: ' $mark',
            style: TextStyle(color: color, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}

class _TuiErrorRow extends StatelessWidget {
  const _TuiErrorRow({this.code, required this.message});

  final String? code;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(9, 7, 9, 7),
      decoration: BoxDecoration(
        color: Octo.red.withValues(alpha: .08),
        borderRadius: BorderRadius.circular(Octo.rS),
        border: Border.all(color: Octo.red.withValues(alpha: .3)),
      ),
      child: Text(
        '✗ ${code ?? 'error'}：$message',
        style: const TextStyle(
          fontFamily: Octo.mono,
          fontSize: 10.5,
          height: 1.6,
          color: Octo.red,
        ),
      ),
    );
  }
}

/// 工具行只显示最关键的那个参数（桌面 TUI 同款：`Read .task/manifest.json`）。
String? shortToolArg(String name, String? rawInput) {
  if (rawInput == null || rawInput.trim().isEmpty) return null;
  Object? input;
  try {
    input = jsonDecode(rawInput);
  } catch (_) {
    input = null;
  }
  if (input is Map) {
    for (final key in const [
      'file_path',
      'path',
      'command',
      'pattern',
      'url',
      'query',
      'description',
      'prompt',
    ]) {
      final v = input[key];
      if (v is String && v.trim().isNotEmpty) return _ellipsis(v.trim(), 64);
    }
  }
  return _ellipsis(rawInput.replaceAll(RegExp(r'\s+'), ' ').trim(), 64);
}

String _ellipsis(String s, int max) =>
    s.length <= max ? s : '${s.substring(0, max)}…';
