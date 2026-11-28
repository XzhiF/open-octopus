import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../core/api.dart';
import '../core/work_phrases.dart';
import '../core/ask_question.dart';
import '../core/format.dart';
import '../core/models/chat.dart';
import '../core/models/telemetry.dart';
import '../features/chat/ask_card.dart';
import '../features/chat/chat_attachments.dart';

/// 会话内容＝桌面同一套 TUI 语法（`❯` / `✦ 汐音 + meta` / `◌` / `▸ tool [✓]` / `✳`）。
/// 换皮肤不换内容：这里只决定字号与配色，不重排信息。
///
/// 2026-11-28 起与原型 §4（E10–E14）对齐：
///   · 我的消息：原来的细金线 + `❯` 不动，垫一层淡琥珀底、左侧加粗到 3px；
///   · 运行态：与全舱 TUI 同一条工作行（转字 + 修仙短语 + 计时），
///     thinking 默认只露最新两行（上缘渐隐），工具逐条打勾；
///   · 回合结束：同样默认留两行 thinking + 工具行，点行头 ▸ 才摊开全文；
///     单条工具还能再点开 input / result 原文。
class TuiTranscript extends StatelessWidget {
  const TuiTranscript({
    super.key,
    required this.messages,
    this.live,
    this.turnStats = const {},
    this.userKeys = const {},
    this.flashUserId,
    this.sessionId,
    this.api,
    this.onAskAnswer,
    this.askEnabled = true,
    this.anchor,
  });

  final List<ChatMessage> messages;
  final LiveTurn? live;

  /// 用户自己摊开 / 收起过程行时的滚动锚点：外层用它脱离「自动贴底」，
  /// 这一层用它把摊开的那一块钉在原地。为空就只是普通展开。
  final TuiScrollAnchor? anchor;

  /// sourceMessageId → 本轮统计（来自会话账本；没有账本行就没有 key）。
  final Map<String, TurnStats> turnStats;

  /// 用户消息 id → 滚动定位用的 key（轮次抽屉跳转）。
  final Map<String, GlobalKey> userKeys;

  /// 刚从轮次抽屉跳过来的那条用户消息：闪一下粉。
  final String? flashUserId;

  /// 产物预览（图片 / 文件）需要的会话与 API；为空时只画文本。
  final String? sessionId;
  final OctopusApi? api;

  /// 提问卡作答：把格式化正文当一条用户消息发回会话。
  final ValueChanged<String>? onAskAnswer;
  final bool askEnabled;

  @override
  Widget build(BuildContext context) {
    final segments = _segment(messages);
    final answered = _answeredAsks(messages);
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
              answeredAsks: answered,
              sessionId: sessionId,
              api: api,
              onAskAnswer: onAskAnswer,
              askEnabled: askEnabled,
              anchor: anchor,
            ),
          );
      }
    }

    final l = live;
    if (l != null && l.hasAnything) {
      rows.add(
        _LiveBlockView(
          key: const ValueKey('__live__'),
          live: l,
          sessionId: sessionId,
          api: api,
          anchor: anchor,
        ),
      );
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

  /// 提问卡是否已作答：同一段里，提问之后出现用户消息就算答过。
  /// 回答正文（`用户回答了以下问题了…`）压成一行摘要供折叠态显示。
  Map<String, String> _answeredAsks(List<ChatMessage> messages) {
    final out = <String, String>{};
    final pending = <ChatMessage>[];
    for (final m in messages) {
      if (m.isUser) {
        for (final ask in pending) {
          out[ask.id] = askAnswerSummary(m.content) ?? '已回答';
        }
        pending.clear();
      } else if (m.displayType == 'ask_user_question') {
        pending.add(m);
      }
    }
    return out;
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

/// 用户自己摊开 / 收起过程行（行头、thinking 窗口、工具小票）时的滚动锚点。
///
/// 两件事：
///   · [onDetach]：人已经在翻旧账了 —— 外层从此别再跟着新消息贴底，
///     直到他主动把滚动条拉回最新；
///   · 摊开的那一块，头在屏幕上的位置不动：摊开前量一次，下一帧按高度差
///     把滚动位置补回去（插入点在视口上方时，页面不会自己往上窜）。
class TuiScrollAnchor {
  const TuiScrollAnchor({this.onDetach, this.onProgrammaticScroll});

  /// 用户主动翻看：外层把「自动贴底」关掉。
  final VoidCallback? onDetach;

  /// 下面这次 jump 是锚点补偿（不是用户滚的），外层别拿它判「用户翻走了」。
  final ValueChanged<bool>? onProgrammaticScroll;

  void toggle(BuildContext context, VoidCallback apply) {
    final before = _globalTop(context);
    final position = Scrollable.maybeOf(context)?.position;
    onDetach?.call();
    apply();
    if (before == null || position == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!context.mounted || !position.hasContentDimensions) return;
      final after = _globalTop(context);
      if (after == null) return;
      final delta = after - before;
      if (delta.abs() < .5) return;
      final target = (position.pixels + delta).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      );
      if ((target - position.pixels).abs() < .5) return;
      onProgrammaticScroll?.call(true);
      try {
        position.jumpTo(target);
      } finally {
        onProgrammaticScroll?.call(false);
      }
    });
  }

  static double? _globalTop(BuildContext context) {
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return null;
    return box.localToGlobal(Offset.zero).dy;
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

/// 我说的那句：原来的 `❯` + 细金线，只在下面垫一层淡琥珀底、左边加粗到 3px。
/// 不加标签块 —— 长句换行只让出 `❯` 那一点宽度，左边不会空一大截。
class _TuiUserRow extends StatelessWidget {
  const _TuiUserRow({super.key, required this.text, this.flash = false});

  final String text;
  final bool flash;

  @override
  Widget build(BuildContext context) {
    // 提问卡的回答正文是给 agent 的结构化块，转录里压成一行摘要；
    // 原始正文仍完整发给了服务端，只是不铺满屏幕。
    final answer = askAnswerSummary(text);
    if (answer != null) return _TuiAnswerRow(summary: answer, flash: flash);

    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Stack(
        children: [
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: flash
                    ? LinearGradient(
                        colors: [
                          Octo.pink.withValues(alpha: .13),
                          Octo.pink.withValues(alpha: .13),
                        ],
                      )
                    : const LinearGradient(
                        begin: Alignment.centerLeft,
                        end: Alignment.centerRight,
                        stops: [0, .64, 1],
                        colors: [
                          Color(0x1CFFB020),
                          Color(0x09FFB020),
                          Color(0x1F100D28),
                        ],
                      ),
              ),
            ),
          ),
          Positioned(
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            child: ColoredBox(
              color: flash ? Octo.pink : Octo.amber.withValues(alpha: .7),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(9, 6, 10, 6),
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
                      height: 1.65,
                      fontWeight: FontWeight.w800,
                      color: Octo.amber,
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
          ),
        ],
      ),
    );
  }
}

/// 提问卡的回答（原型 `.qdone` 的转录侧）：一行带过，不铺结构化正文。
class _TuiAnswerRow extends StatelessWidget {
  const _TuiAnswerRow({required this.summary, this.flash = false});

  final String summary;
  final bool flash;

  @override
  Widget build(BuildContext context) {
    final discuss = summary == '先讨论';
    final color = discuss ? Octo.amber : Octo.green;
    return Container(
      padding: const EdgeInsets.fromLTRB(9, 3, 9, 3),
      decoration: BoxDecoration(
        color: flash ? Octo.pink.withValues(alpha: .13) : Colors.transparent,
        borderRadius: BorderRadius.circular(4),
        border: Border(
          left: BorderSide(
            color: flash ? Octo.pink : color.withValues(alpha: .7),
          ),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: Text(
              '✓',
              style: TextStyle(
                fontFamily: Octo.mono,
                fontSize: 11,
                fontWeight: FontWeight.w800,
                color: color,
              ),
            ),
          ),
          Expanded(
            child: SelectableText(
              discuss ? '已转讨论 · 让 agent 先解释' : '已回答 · $summary',
              style: TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10.5,
                height: 1.65,
                color: discuss ? Octo.amber : Octo.metal,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 完成态的 assistant 块：行头 + 思考两行窗 + 工具行 + 正文。
/// 默认留最后两行 thinking 给「刚才想了什么」做上下文；点行头才摊开全文。
class _AssistantBlockView extends StatefulWidget {
  const _AssistantBlockView({
    super.key,
    required this.messages,
    required this.stats,
    this.answeredAsks = const {},
    this.sessionId,
    this.api,
    this.onAskAnswer,
    this.askEnabled = true,
    this.anchor,
  });

  final List<ChatMessage> messages;
  final TurnStats? stats;

  /// 提问卡 id → 回答摘要（有 key = 已回答）。
  final Map<String, String> answeredAsks;
  final String? sessionId;
  final OctopusApi? api;
  final ValueChanged<String>? onAskAnswer;
  final bool askEnabled;
  final TuiScrollAnchor? anchor;

  @override
  State<_AssistantBlockView> createState() => _AssistantBlockViewState();
}

class _AssistantBlockViewState extends State<_AssistantBlockView> {
  bool _expanded = false;

  /// 用户点行头：摊开 / 收起。锚点留在这一块上，并且从此不跟着新消息贴底。
  void _toggle() {
    void apply() => setState(() => _expanded = !_expanded);
    final anchor = widget.anchor;
    if (anchor == null) {
      apply();
      return;
    }
    anchor.toggle(context, apply);
  }

  @override
  Widget build(BuildContext context) {
    // 过程行（think / tool）按落库顺序排：展开时原样复原那一刻的先后。
    final processRows = widget.messages
        .where(
          (m) => m.displayType == 'thinking' || m.displayType == 'tool_call',
        )
        .toList(growable: false);
    final thinkingRows = processRows
        .where((m) => m.displayType == 'thinking')
        .map((m) => (m.thinkingContent ?? m.content).trim())
        .where((t) => t.isNotEmpty)
        .toList(growable: false);
    final toolRows = widget.messages
        .where((m) => m.displayType == 'tool_call')
        .toList(growable: false);
    final texts = widget.messages
        .where((m) => m.displayType == 'text' && m.content.trim().isNotEmpty)
        .length;
    final steps = thinkingRows.length + toolRows.length + texts;
    final interrupted = widget.messages.any((m) => m.interrupted);
    final error = widget.messages
        .map((m) => m.errorMessage)
        .whereType<String>()
        .firstOrNull;
    final hasProcess = processRows.isNotEmpty;

    final content = <Widget>[];
    void addTextRow(ChatMessage row) {
      content.add(
        Padding(
          padding: const EdgeInsets.only(top: 3),
          child: _TuiAssistantText(text: row.content),
        ),
      );
      final api = widget.api;
      final sessionId = widget.sessionId;
      if (api != null && sessionId != null) {
        content.add(
          ChatAttachments(text: row.content, api: api, sessionId: sessionId),
        );
      }
    }

    for (final row in widget.messages) {
      if (row.displayType == 'text' && row.content.trim().isNotEmpty) {
        addTextRow(row);
      } else if (row.displayType == 'ask_user_question') {
        // 提问前的正文与题目存在同一条消息里，正文先画。
        if (row.content.trim().isNotEmpty) addTextRow(row);
        final questions = parseAskQuestions(row.questions);
        if (questions.isEmpty) continue;
        content.add(
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: AskQuestionCard(
              key: ValueKey('ask-${row.id}'),
              questions: questions,
              answered: widget.answeredAsks.containsKey(row.id),
              answeredSummary: widget.answeredAsks[row.id],
              onAnswer: widget.onAskAnswer,
              enabled: widget.askEnabled,
            ),
          ),
        );
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _MetaLine(
          done: true,
          interrupted: interrupted,
          steps: steps,
          tools: toolRows.length,
          stats: widget.stats,
          expandable: hasProcess,
          expanded: _expanded,
          onTap: hasProcess ? _toggle : null,
        ),
        // 跑完不再把过程摊在正文上面：think / tool 一起收进行头，
        // 点行头才按时间序列全（同全仓 TUI 的 TuiMeta）。
        if (_expanded && processRows.isNotEmpty)
          _MetaBody(rows: processRows, anchor: widget.anchor),
        for (final row in content) row,
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
}

/// 展开态的过程明细（原型 `.metabody` / 桌面 `TuiMeta` 展开体）：
/// 左侧一条细线，think 与 tool 按落库顺序各一行；工具行可再点开 input / result。
class _MetaBody extends StatelessWidget {
  const _MetaBody({required this.rows, this.anchor});

  final List<ChatMessage> rows;
  final TuiScrollAnchor? anchor;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 3, left: 3),
      padding: const EdgeInsets.only(left: 9),
      decoration: const BoxDecoration(
        border: Border(left: BorderSide(color: Color(0x478D86B8))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final row in rows)
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: row.displayType == 'thinking'
                  ? _ThinkRow(
                      text: row.thinkingContent ?? row.content,
                      duration: row.thinkingDuration,
                    )
                  : ToolLine(
                      name: row.toolName ?? 'tool',
                      input: row.toolInputText,
                      result: row.toolResultText,
                      status: row.toolStatus,
                      anchor: anchor,
                    ),
            ),
        ],
      ),
    );
  }
}

/// 过程明细里的一行思考：`◌ 全文…`（不截行，跟随整页滚）。
class _ThinkRow extends StatelessWidget {
  const _ThinkRow({required this.text, this.duration});

  final String text;
  final String? duration;

  @override
  Widget build(BuildContext context) {
    final body = text.trimRight();
    final suffix = duration == null || duration!.isEmpty ? '' : '  ($duration)';
    return Text.rich(
      TextSpan(
        style: const TextStyle(
          fontFamily: Octo.mono,
          fontSize: 10.5,
          height: 1.65,
          color: Octo.dim,
        ),
        children: [
          const TextSpan(
            text: '◌ ',
            style: TextStyle(color: Color(0xCCC9BFFF)),
          ),
          TextSpan(text: '$body$suffix'),
        ],
      ),
    );
  }
}

/// 正在跑的一轮：行头 + 工作行 + 思考两行窗 + 工具行，正文随流出现。
class _LiveBlockView extends StatefulWidget {
  const _LiveBlockView({
    super.key,
    required this.live,
    this.sessionId,
    this.api,
    this.anchor,
  });

  final LiveTurn live;
  final String? sessionId;
  final OctopusApi? api;
  final TuiScrollAnchor? anchor;

  @override
  State<_LiveBlockView> createState() => _LiveBlockViewState();
}

class _LiveBlockViewState extends State<_LiveBlockView> {
  bool _expanded = false;
  Timer? _tick;
  Duration _elapsed = Duration.zero;

  @override
  void initState() {
    super.initState();
    final started = widget.live.startedAt;
    _elapsed = started == null
        ? Duration.zero
        : DateTime.now().difference(started);
    _tick = Timer.periodic(
      const Duration(milliseconds: 120),
      (_) => _syncClock(),
    );
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  void _syncClock() {
    if (!mounted) return;
    final live = widget.live;
    if (live.done) {
      _tick?.cancel();
      _tick = null;
    }
    final started = live.startedAt;
    // 每帧都重画：转字本来就 100ms 一帧，顺手把「done 了要收起来」也算进去
    // （不能只在整秒变化时才 setState，否则收到 result 时不会重画）。
    setState(() {
      _elapsed = started == null
          ? Duration.zero
          : DateTime.now().difference(started);
    });
  }

  @override
  Widget build(BuildContext context) {
    final live = widget.live;
    final tools = live.tools;
    // 过程按到达顺序：think 段与工具交替，不把 thinking 一律提到工具前面。
    final process = live.processItems;
    final thinks = process.where((item) => item.kind == 'thinking').length;
    final steps = tools.length + thinks + (live.text.isEmpty ? 0 : 1);
    final hasProcess = process.isNotEmpty;
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
          tools: tools.length,
          stats: stats,
          elapsed: _elapsed,
          expandable: hasProcess,
          expanded: _expanded,
          onTap: hasProcess ? _toggle : null,
        ),
        // 工作行（转字 / 短语 / 计时）已经不在这里：它钉在输入框上沿，
        // 不跟着消息流一起滚（见 WorkStatusLine）。这里只留过程本身。
        // 跑动中在最下方露两行；出结果的那一刻跟工具调用一起收进行头，
        // 只有展开态才继续摊开（同全仓 TUI）。
        if (!live.done || _expanded)
          for (var i = 0; i < process.length; i++)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: _liveProcessRow(
                process[i],
                active:
                    !live.done && !live.thinkingDone && i == process.length - 1,
              ),
            ),
        if (live.text.trim().isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: _TuiAssistantText(text: live.text),
          ),
          if (widget.api != null && widget.sessionId != null)
            ChatAttachments(
              text: live.text,
              api: widget.api!,
              sessionId: widget.sessionId!,
            ),
        ],
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

  /// 用户点行头 / 点思考窗口：摊开或收起。锚点留在这一块上，
  /// 并且从此不跟着新消息贴底（他只管看，页面别自己翻）。
  void _toggle() {
    void apply() => setState(() => _expanded = !_expanded);
    final anchor = widget.anchor;
    if (anchor == null) {
      apply();
      return;
    }
    anchor.toggle(context, apply);
  }

  /// 一条运行中的过程：thinking 段 = 活窗口；工具 = 打勾行。
  Widget _liveProcessRow(LiveProcessItem item, {required bool active}) {
    if (item.kind == 'thinking') {
      return _ThinkWindow(
        text: item.text,
        expanded: _expanded,
        live: active,
        onToggle: _toggle,
      );
    }
    final tool = widget.live.tools
        .where((t) => t.id == item.toolId)
        .firstOrNull;
    if (tool == null) return const SizedBox.shrink();
    return ToolLine(
      name: tool.name,
      input: tool.inputText,
      result: tool.resultText,
      status: tool.status,
      duration: tool.duration,
      anchor: widget.anchor,
    );
  }
}

/// 阶段只看「现在在干什么」：有工具在跑 = 执行；还在想 = 思考；已经在出字 = 落笔。
WorkPhase _livePhase(LiveTurn live) {
  if (live.tools.any((t) => t.status == 'running')) return WorkPhase.exec;
  if (!live.thinkingDone && live.thinking.trim().isNotEmpty) {
    return WorkPhase.thinking;
  }
  if (live.text.trim().isNotEmpty) return WorkPhase.writing;
  return WorkPhase.thinking;
}

/// 摘要头（原型 `.head`）：
/// `✦ 汐音 已完成 · 9s · 3 步 · 工具 1 · 1.2K tok · ¥0.06 ▸`
/// 跑动中则是 `✦ 汐音 ● 进行中 · 0:12 ▸`。
class _MetaLine extends StatelessWidget {
  const _MetaLine({
    required this.done,
    this.interrupted = false,
    required this.steps,
    required this.tools,
    required this.stats,
    this.elapsed,
    required this.expandable,
    required this.expanded,
    this.onTap,
  });

  final bool done;

  /// 本轮被用户停止 / 断流截断：行头写「已截断」，不冒充「已完成」。
  final bool interrupted;
  final int steps;
  final int tools;
  final TurnStats? stats;
  final Duration? elapsed;
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
    final statsDuration = stats?.durationLabel ?? '';
    final duration = done && statsDuration.isNotEmpty
        ? statsDuration
        : (elapsed == null ? '' : formatWorkElapsed(elapsed!.inSeconds));
    final showTokens = stats != null && stats!.calls > 0;
    // 未定价的「—」不占位置：手机上这行本来就窄，多一个破折号只会换行。
    final cost = stats == null || stats!.calls == 0 || stats!.costUsd == null
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
            if (!done)
              const WidgetSpan(
                alignment: PlaceholderAlignment.middle,
                child: Padding(
                  padding: EdgeInsets.only(left: 6, right: 5),
                  child: _LiveDot(),
                ),
              )
            else
              const TextSpan(text: '  '),
            TextSpan(
              text: !done ? '进行中' : (interrupted ? '已截断' : '已完成'),
              style: TextStyle(
                fontWeight: FontWeight.w700,
                color: !done
                    ? Octo.teal
                    : (interrupted ? Octo.amber : Octo.green),
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
              text: '$steps\u00A0步',
              style: const TextStyle(
                color: Octo.ink,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (tools > 0) ...[
              const TextSpan(text: ' · '),
              TextSpan(
                text: '工具\u00A0$tools',
                style: const TextStyle(color: Octo.teal),
              ),
            ],
            if (showTokens) ...[
              const TextSpan(text: ' · '),
              TextSpan(
                text: '${formatTokNum(stats!.tokens)}\u00A0tok',
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

/// 思考活窗口（原型 `.thinkwin`）：默认只露最新两行，上缘渐隐；
/// 点窗口或行头展开 = 本段全文，换行不截断。
class _ThinkWindow extends StatelessWidget {
  const _ThinkWindow({
    required this.text,
    required this.expanded,
    this.live = false,
    this.onToggle,
  });

  final String text;
  final bool expanded;
  final bool live;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final lines = text
        .split('\n')
        .map((l) => l.trimRight())
        .where((l) => l.trim().isNotEmpty)
        .toList(growable: false);
    if (lines.isEmpty) return const SizedBox.shrink();

    final window = expanded || lines.length <= 2
        ? lines
        : lines.sublist(lines.length - 2);
    final hint = expanded
        ? '全文 · 点行头收起'
        : (live ? '最新 2 行 · 点开全文' : '收尾 2 行 · 点开全部');

    return GestureDetector(
      onTap: onToggle,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.fromLTRB(9, 6, 9, 7),
        decoration: BoxDecoration(
          color: const Color(0x750A0818),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Octo.hairlineSoft),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                const Text(
                  '◌ thinking',
                  style: TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 8,
                    height: 1.2,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.1,
                    color: Color(0xE6C9BFFF),
                  ),
                ),
                const Spacer(),
                Text(
                  hint,
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 8,
                    height: 1.2,
                    fontWeight: FontWeight.w700,
                    letterSpacing: .3,
                    color: Octo.dim,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 3),
            if (expanded)
              // 全文仍然是全文，但最多占半屏（桌面同款 50vh），免得一段几千字
              // 的 thinking 把下面的工具行 / 正文顶出屏幕；窗口内自己可滚。
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * .5,
                ),
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (final line in window)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 1),
                          child: Text(
                            line,
                            style: const TextStyle(
                              fontFamily: Octo.mono,
                              fontSize: 10,
                              height: 1.7,
                              color: Color(0xEBEDEBFA),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              )
            else
              for (var i = 0; i < window.length; i++)
                _windowLine(
                  window[i],
                  // 上一行渐隐做「前面还有」的暗示；最后一行带光标。
                  old: i < window.length - 1,
                  caret: live && i == window.length - 1,
                ),
          ],
        ),
      ),
    );
  }

  Widget _windowLine(String text, {required bool old, required bool caret}) {
    const style = TextStyle(
      fontFamily: Octo.mono,
      fontSize: 10,
      height: 1.65,
      color: Color(0xC68D86B8),
    );
    final base = Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: old ? style : style.copyWith(color: const Color(0xEBEDEBFA)),
    );
    final line = caret
        ? Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(child: base),
              const Padding(padding: EdgeInsets.only(left: 2), child: _Caret()),
            ],
          )
        : base;
    if (!old) return line;
    return Opacity(
      opacity: .55,
      child: ShaderMask(
        blendMode: BlendMode.dstIn,
        shaderCallback: (rect) => const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          stops: [0, .75],
          colors: [Colors.transparent, Colors.black],
        ).createShader(rect),
        child: line,
      ),
    );
  }
}

/// 工作行（原型 `.work`）：转字 + 修仙短语 + 真实计时 —— 与全舱 TUI 同一条。
class _WorkLine extends StatelessWidget {
  const _WorkLine({
    required this.phase,
    required this.elapsed,
    required this.spin,
    required this.seed,
  });

  final WorkPhase phase;
  final int elapsed;
  final String spin;
  final int seed;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Octo.teal.withValues(alpha: .2)),
        gradient: LinearGradient(
          begin: Alignment.centerLeft,
          end: Alignment.centerRight,
          colors: [Octo.teal.withValues(alpha: .1), const Color(0x7A100D28)],
        ),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 12,
            child: Text(
              spin,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 12,
                height: 1,
                color: Octo.teal,
              ),
            ),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              workPhrase(phase, elapsed, seed: seed),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10.5,
                height: 1,
                color: Color(0xE6EDEBFA),
              ),
            ),
          ),
          const SizedBox(width: 7),
          Text(
            formatWorkElapsed(elapsed),
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 10.5,
              height: 1,
              letterSpacing: .4,
              fontFeatures: [FontFeature.tabularFigures()],
              color: Octo.teal,
            ),
          ),
        ],
      ),
    );
  }
}

/// 运行态工作行（钉在输入框上沿，不随消息流滚）：
/// 盲文转字 + 修仙短语 + 真实计时 —— 与全舱 TUI 同一条。
///
/// 之前它跟着回合块一起滚，消息一多就被顶出去了；现在人一抬眼就能在
/// 输入框上面看到「它此刻在干什么」。
class WorkStatusLine extends StatefulWidget {
  const WorkStatusLine({super.key, required this.live});

  final LiveTurn live;

  @override
  State<WorkStatusLine> createState() => _WorkStatusLineState();
}

class _WorkStatusLineState extends State<WorkStatusLine> {
  Timer? _tick;
  Duration _elapsed = Duration.zero;

  @override
  void initState() {
    super.initState();
    _elapsed = _elapsedOf();
    _tick = Timer.periodic(const Duration(milliseconds: 120), (_) => _sync());
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Duration _elapsedOf() {
    final started = widget.live.startedAt;
    return started == null ? Duration.zero : DateTime.now().difference(started);
  }

  void _sync() {
    if (!mounted) return;
    // 回合收口后外层会把它摘掉；这里只负责别让 timer 空转。
    if (widget.live.done) {
      _tick?.cancel();
      _tick = null;
    }
    setState(() => _elapsed = _elapsedOf());
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
      child: _WorkLine(
        phase: _livePhase(widget.live),
        elapsed: _elapsed.inSeconds,
        spin: workSpinGlyph(_elapsed.inMilliseconds / 1000),
        seed: widget.live.startedAt?.millisecondsSinceEpoch ?? 0,
      ),
    );
  }
}

/// 工具行（原型 `.tool`）：`▸ Edit spec/phase-1.md        ✓ 完成`。
/// 有 input / result 时整行可点，展开成原文小票。
class ToolLine extends StatefulWidget {
  const ToolLine({
    super.key,
    required this.name,
    required this.input,
    required this.status,
    this.result,
    this.duration,
    this.anchor,
  });

  final String name;
  final String? input;
  final String? result;
  final String status;
  final String? duration;

  /// 用户点开小票时：锚点留在这一行，别再自动贴底。
  final TuiScrollAnchor? anchor;

  @override
  State<ToolLine> createState() => _ToolLineState();
}

class _ToolLineState extends State<ToolLine> {
  bool _open = false;

  void _toggle() {
    void apply() => setState(() => _open = !_open);
    final anchor = widget.anchor;
    if (anchor == null) {
      apply();
      return;
    }
    anchor.toggle(context, apply);
  }

  @override
  Widget build(BuildContext context) {
    final running = widget.status == 'running';
    final error = widget.status == 'error';
    final (label, color) = running
        ? ('运行中…', Octo.amber)
        : error
        ? ('✗ 失败', Octo.red)
        : ('✓ 完成', Octo.green);
    final arg = shortToolArg(widget.name, widget.input);
    final detail = _toolDetail(widget.input, widget.result);

    final row = Row(
      children: [
        const Padding(
          padding: EdgeInsets.only(right: 6),
          child: Text(
            '▸',
            style: TextStyle(
              fontFamily: Octo.mono,
              fontSize: 10.5,
              height: 1.6,
              color: Octo.teal,
            ),
          ),
        ),
        Expanded(
          child: Text.rich(
            TextSpan(
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10.5,
                height: 1.6,
                color: Octo.dim,
              ),
              children: [
                TextSpan(
                  text: widget.name,
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
                if (widget.duration != null && !running)
                  TextSpan(
                    text: ' ${widget.duration}',
                    style: const TextStyle(color: Octo.faint),
                  ),
              ],
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: 8),
        Text(
          label,
          style: TextStyle(
            fontFamily: Octo.mono,
            fontSize: 9.5,
            height: 1.4,
            fontWeight: FontWeight.w700,
            color: color,
          ),
        ),
      ],
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        InkWell(
          onTap: detail == null ? null : _toggle,
          borderRadius: BorderRadius.circular(6),
          child: row,
        ),
        if (_open && detail != null)
          Container(
            margin: const EdgeInsets.fromLTRB(16, 3, 0, 6),
            padding: const EdgeInsets.fromLTRB(9, 7, 9, 7),
            decoration: BoxDecoration(
              color: const Color(0x990A0818),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Octo.hairlineSoft),
            ),
            child: Text(
              detail,
              maxLines: 16,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 9,
                height: 1.7,
                color: Octo.metal,
              ),
            ),
          ),
      ],
    );
  }

  /// input / result 原文小票。两边都没有就没什么可展开的。
  static String? _toolDetail(String? input, String? result) {
    final parts = <String>[];
    if (input != null && input.trim().isNotEmpty) {
      parts.add('▸ input\n${_prettyJson(input)}');
    }
    if (result != null && result.trim().isNotEmpty) {
      parts.add('▸ result\n${result.trim()}');
    }
    if (parts.isEmpty) return null;
    return _clip(parts.join('\n\n'), 900);
  }

  static String _prettyJson(String raw) {
    try {
      final decoded = jsonDecode(raw);
      return const JsonEncoder.withIndent('  ').convert(decoded);
    } catch (_) {
      return raw;
    }
  }

  static String _clip(String s, int max) =>
      s.length <= max ? s : '${s.substring(0, max)}…';
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

/// 行头那颗「在跑」的小灯：呼吸，不是转圈。
class _LiveDot extends StatefulWidget {
  const _LiveDot();

  @override
  State<_LiveDot> createState() => _LiveDotState();
}

class _LiveDotState extends State<_LiveDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween<double>(
        begin: .35,
        end: 1,
      ).animate(CurvedAnimation(parent: _c, curve: Curves.easeInOut)),
      child: Container(
        width: 5,
        height: 5,
        decoration: const BoxDecoration(
          shape: BoxShape.circle,
          color: Octo.teal,
          boxShadow: [BoxShadow(color: Octo.teal, blurRadius: 8)],
        ),
      ),
    );
  }
}

/// 思考活窗口末尾的光标：1s 闪烁（对齐原型 `caret`）。
class _Caret extends StatefulWidget {
  const _Caret();

  @override
  State<_Caret> createState() => _CaretState();
}

class _CaretState extends State<_Caret> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1000),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) => Opacity(
        opacity: _c.value < .5 ? 1 : 0,
        child: Container(width: 5, height: 10, color: const Color(0xCC2EE6D6)),
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
