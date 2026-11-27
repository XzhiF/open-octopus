import 'dart:convert';

import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../core/models/chat.dart';

/// 会话内容＝桌面同一套 TUI 语法（`❯` / `✦ 汐音 + meta` / `◌` / `▸ tool [✓]` / `✳`）。
/// 换皮肤不换内容：这里只决定字号与配色，不重排信息。
class TuiTranscript extends StatelessWidget {
  const TuiTranscript({super.key, required this.messages, this.live});

  final List<ChatMessage> messages;
  final LiveTurn? live;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    var toolsInTurn = 0;
    var stepsInTurn = 0;
    for (final m in messages) {
      if (m.isUser) {
        toolsInTurn = 0;
        stepsInTurn = 0;
        rows.add(_TuiUserRow(text: m.content));
        continue;
      }
      final type = m.displayType;
      if (type == 'thinking') {
        stepsInTurn++;
        rows.add(_TuiThinkRow(
          text: m.thinkingContent ?? m.content,
          duration: m.thinkingDuration,
        ));
      } else if (type == 'tool_call') {
        toolsInTurn++;
        stepsInTurn++;
        rows.add(_TuiToolRow(
          name: m.toolName ?? 'tool',
          input: m.toolInputText,
          status: m.toolStatus,
          duration: m.toolDuration,
        ));
      } else if (type == 'ask_user_question') {
        stepsInTurn++;
        rows.add(_TuiToolRow(
          name: m.toolName ?? 'AskUserQuestion',
          input: m.toolInputText,
          status: 'done',
          duration: null,
        ));
      } else if (type == 'system') {
        // 舱的系统行（就绪说明 / 事件回执）：不是汐音说的，别挂 her 的头。
        if (m.content.trim().isEmpty) continue;
        rows.add(_TuiSystemRow(text: m.content));
      } else {
        if (m.content.trim().isEmpty) continue;
        stepsInTurn++;
        rows.add(_TuiAssistantRow(
          text: m.content,
          tools: toolsInTurn,
          steps: stepsInTurn,
          totalTokens: _tokensOf(m.usage),
          costUsd: m.costUsd,
          done: true,
        ));
      }
    }

    final l = live;
    if (l != null && l.hasAnything) {
      if (l.thinking.isNotEmpty) {
        rows.add(_TuiThinkRow(text: l.thinking, duration: l.thinkingDuration));
      }
      for (final tool in l.tools) {
        rows.add(_TuiToolRow(
          name: tool.name,
          input: tool.inputText,
          status: tool.status,
          duration: tool.duration,
        ));
      }
      if (l.errorMessage != null) {
        rows.add(_TuiErrorRow(code: l.errorCode, message: l.errorMessage!));
      }
      rows.add(_TuiAssistantRow(
        text: l.text,
        tools: l.tools.length,
        steps: l.tools.length + (l.thinking.isEmpty ? 0 : 1) + (l.text.isEmpty ? 0 : 1),
        totalTokens: l.totalTokens,
        costUsd: l.costUsd,
        done: l.done,
        streaming: !l.done,
      ));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in rows) Padding(
          padding: const EdgeInsets.only(bottom: 13),
          child: row,
        ),
      ],
    );
  }
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
  const _TuiUserRow({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(9, 1, 9, 1),
      decoration: const BoxDecoration(
        border: Border(left: BorderSide(color: Color(0x80F5C542), width: 2)),
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

class _TuiAssistantRow extends StatelessWidget {
  const _TuiAssistantRow({
    required this.text,
    required this.tools,
    required this.steps,
    required this.totalTokens,
    required this.costUsd,
    required this.done,
    this.streaming = false,
  });

  final String text;
  final int tools;
  final int steps;
  final int totalTokens;
  final double? costUsd;
  final bool done;
  final bool streaming;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _TuiMetaLine(
          tools: tools,
          steps: steps,
          totalTokens: totalTokens,
          costUsd: costUsd,
          done: done,
          streaming: streaming,
        ),
        if (text.trim().isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Row(
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
            ),
          ),
      ],
    );
  }
}

class _TuiMetaLine extends StatelessWidget {
  const _TuiMetaLine({
    required this.tools,
    required this.steps,
    required this.totalTokens,
    required this.costUsd,
    required this.done,
    required this.streaming,
  });

  final int tools;
  final int steps;
  final int totalTokens;
  final double? costUsd;
  final bool done;
  final bool streaming;

  @override
  Widget build(BuildContext context) {
    const base = TextStyle(
      fontFamily: Octo.mono,
      fontSize: 10.5,
      height: 1.7,
      color: Octo.dim,
    );
    return Text.rich(
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
            text: streaming ? '响应中…' : '已完成',
            style: TextStyle(
              fontWeight: FontWeight.w700,
              color: streaming ? Octo.amber : Octo.green,
            ),
          ),
          const TextSpan(text: ' · '),
          TextSpan(
            text: '$steps 步',
            style: const TextStyle(color: Octo.ink, fontWeight: FontWeight.w600),
          ),
          if (tools > 0) ...[
            const TextSpan(text: ' · '),
            TextSpan(text: '工具 $tools', style: const TextStyle(color: Octo.teal)),
          ],
          if (totalTokens > 0) ...[
            const TextSpan(text: ' · '),
            TextSpan(
              text: '${formatTokenCount(totalTokens)} tok',
              style: const TextStyle(color: Octo.green),
            ),
          ],
          if (costUsd != null && costUsd! > 0) ...[
            const TextSpan(text: ' · '),
            TextSpan(
              text: '¥${(costUsd! * 7).toStringAsFixed(2)}',
              style: const TextStyle(color: Color(0xFFF0A93B)),
            ),
          ],
        ],
      ),
    );
  }
}

class _TuiThinkRow extends StatelessWidget {
  const _TuiThinkRow({required this.text, this.duration});

  final String text;
  final String? duration;

  @override
  Widget build(BuildContext context) {
    if (text.trim().isEmpty) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.only(left: 8),
      decoration: const BoxDecoration(
        border: Border(left: BorderSide(color: Color(0x478D86B8))),
      ),
      child: Text(
        duration == null ? '◌ $text' : '◌ $text  ($duration)',
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

class _TuiToolRow extends StatelessWidget {
  const _TuiToolRow({
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
        style: const TextStyle(fontFamily: Octo.mono, fontSize: 10.5, height: 1.65),
        children: [
          const TextSpan(text: '▸ ', style: TextStyle(color: Octo.teal)),
          TextSpan(
            text: name,
            style: const TextStyle(color: Color(0xFF7FB7FF), fontWeight: FontWeight.w700),
          ),
          if (arg != null) TextSpan(text: ' $arg', style: const TextStyle(color: Octo.dim)),
          if (duration != null && status != 'running')
            TextSpan(text: ' $duration', style: const TextStyle(color: Octo.faint)),
          TextSpan(text: ' $mark', style: TextStyle(color: color, fontWeight: FontWeight.w700)),
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

String _ellipsis(String s, int max) => s.length <= max ? s : '${s.substring(0, max)}…';

int _tokensOf(Map<String, dynamic>? usage) {
  if (usage == null) return 0;
  int n(String k) => (usage[k] as num?)?.toInt() ?? 0;
  return n('inputTokens') + n('outputTokens') + n('cacheReadTokens') + n('cacheCreationTokens');
}

String formatTokenCount(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
  return '$n';
}
