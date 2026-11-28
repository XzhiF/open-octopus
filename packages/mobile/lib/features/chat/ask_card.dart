import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../core/ask_question.dart';
import '../../core/haptics.dart';

/// 提问卡（原型 E10 / E11）：`AskUserQuestion` 直接长在转录里。
///
/// 所有问题平铺在同一张卡里，一次滚完、一次提交；单选圆点、多选方框，
/// 「其他」选中后就地出输入框。「先讨论」= 不回答，把问题交回 agent 澄清。
class AskQuestionCard extends StatefulWidget {
  const AskQuestionCard({
    super.key,
    required this.questions,
    this.answered = false,
    this.answeredSummary,
    this.onAnswer,
    this.enabled = true,
  });

  final List<AskQuestion> questions;

  /// 历史里已经作答（后面已有用户消息）。
  final bool answered;
  final String? answeredSummary;

  /// 提交 / 先讨论都走这条：把正文当一条用户消息发出去。
  final ValueChanged<String>? onAnswer;

  /// 跑动中 / 只读时禁用。
  final bool enabled;

  @override
  State<AskQuestionCard> createState() => _AskQuestionCardState();
}

class _AskQuestionCardState extends State<AskQuestionCard> {
  final Map<int, Set<String>> _selected = {};
  final Map<int, TextEditingController> _other = {};
  bool _submitted = false;
  bool _discussSent = false;
  String? _localSummary;
  bool _expanded = false;

  bool get _readOnly => widget.answered || _submitted;
  bool get _canAct => widget.enabled && widget.onAnswer != null;

  @override
  void initState() {
    super.initState();
    for (var i = 0; i < widget.questions.length; i++) {
      final controller = TextEditingController();
      controller.addListener(_onOtherChanged);
      _other[i] = controller;
    }
  }

  @override
  void dispose() {
    for (final controller in _other.values) {
      controller.removeListener(_onOtherChanged);
      controller.dispose();
    }
    super.dispose();
  }

  void _onOtherChanged() => setState(() {});

  Set<String> _selectionOf(int index) => _selected[index] ?? const <String>{};

  String? _answerOf(int index) {
    final q = widget.questions[index];
    return answerFor(q, _selectionOf(index), _other[index]?.text ?? '');
  }

  bool get _allAnswered =>
      widget.questions.isNotEmpty &&
      List.generate(widget.questions.length, _answerOf).every((v) => v != null);

  void _toggle(int index, AskQuestion question, String label) {
    if (_readOnly || !_canAct) return;
    Haptics.tap();
    setState(() {
      final current = Set<String>.from(_selectionOf(index));
      if (question.multiSelect) {
        if (!current.remove(label)) current.add(label);
      } else {
        current
          ..clear()
          ..add(label);
      }
      _selected[index] = current;
    });
  }

  bool _isOtherSelected(int index, AskQuestion question) =>
      _selectionOf(index).contains(otherLabelOf(question));

  void _submit() {
    if (!_allAnswered || _readOnly || !_canAct) return;
    final text = formatAskAnswer(widget.questions, _selected, {
      for (final entry in _other.entries) entry.key: entry.value.text,
    });
    Haptics.tap();
    setState(() {
      _submitted = true;
      _localSummary = [
        for (var i = 0; i < widget.questions.length; i++) _answerOf(i),
      ].whereType<String>().join('；');
    });
    widget.onAnswer?.call(text);
  }

  void _chatAbout() {
    if (_readOnly || !_canAct) return;
    final text = formatAskChatAbout(widget.questions, _selected, {
      for (final entry in _other.entries) entry.key: entry.value.text,
    });
    Haptics.tap();
    setState(() {
      _submitted = true;
      _discussSent = true;
    });
    widget.onAnswer?.call(text);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.questions.isEmpty) return const SizedBox.shrink();

    if (_readOnly) return _buildAnswered();

    final count = widget.questions.length;
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(Octo.rL),
        border: Border.all(color: Octo.teal.withValues(alpha: .3)),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0x172EE6D6), Color(0xD9100D28)],
        ),
        boxShadow: const [
          BoxShadow(
            color: Color(0x4D000000),
            blurRadius: 30,
            offset: Offset(0, 12),
          ),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          _header(
            leading: '?',
            label: '要你定',
            trailing: count == 1 ? '1 个问题' : '$count 个问题 · 一次答完',
          ),
          for (var i = 0; i < count; i++)
            _buildQuestion(i, widget.questions[i]),
          _footer(),
        ],
      ),
    );
  }

  Widget _header({
    required String leading,
    required String label,
    required String trailing,
    Color? tone,
  }) {
    final color = tone ?? Octo.teal;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: color.withValues(alpha: .14))),
      ),
      child: Row(
        children: [
          Container(
            width: 18,
            height: 18,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: color.withValues(alpha: .14),
              border: Border.all(color: color.withValues(alpha: .45)),
            ),
            child: Text(
              leading,
              style: TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10,
                fontWeight: FontWeight.w800,
                color: color,
                height: 1,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            label,
            style: TextStyle(
              fontFamily: Octo.mono,
              fontSize: 8.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
              color: color,
            ),
          ),
          const Spacer(),
          Text(
            trailing,
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 8.5,
              fontWeight: FontWeight.w700,
              letterSpacing: .5,
              color: Octo.dim,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildQuestion(int index, AskQuestion question) {
    final otherSelected = _isOtherSelected(index, question);
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 9, 10, 2),
      decoration: BoxDecoration(
        border: index == 0
            ? null
            : Border(top: BorderSide(color: Octo.teal.withValues(alpha: .12))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Container(
                width: 16,
                height: 16,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Octo.teal.withValues(alpha: .1),
                  border: Border.all(color: Octo.teal.withValues(alpha: .4)),
                ),
                child: Text(
                  '${index + 1}',
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 9,
                    fontWeight: FontWeight.w800,
                    color: Octo.teal,
                    height: 1,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  question.header.isEmpty ? '问题 ${index + 1}' : question.header,
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 8.5,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.1,
                    color: Octo.teal,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2),
            child: Text(
              question.question,
              style: const TextStyle(
                fontSize: 12.5,
                height: 1.6,
                fontWeight: FontWeight.w600,
                color: Colors.white,
              ),
            ),
          ),
          const SizedBox(height: 7),
          for (final option in question.options)
            Padding(
              padding: const EdgeInsets.only(bottom: 5),
              child: _OptionRow(
                option: option,
                multi: question.multiSelect,
                selected: _selectionOf(index).contains(option.label),
                enabled: _canAct,
                onTap: () => _toggle(index, question, option.label),
              ),
            ),
          if (otherSelected)
            Padding(
              padding: const EdgeInsets.only(top: 1, bottom: 6),
              child: TextField(
                controller: _other[index],
                enabled: _canAct,
                maxLines: 2,
                minLines: 1,
                style: const TextStyle(
                  fontFamily: Octo.mono,
                  fontSize: 10.5,
                  height: 1.45,
                  color: Octo.ink,
                ),
                decoration: InputDecoration(
                  hintText: '自己写一句…',
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 11,
                    vertical: 9,
                  ),
                  filled: true,
                  fillColor: const Color(0x9E0A0818),
                  border: _otherBorder(Octo.teal.withValues(alpha: .36)),
                  enabledBorder: _otherBorder(Octo.teal.withValues(alpha: .36)),
                  focusedBorder: _otherBorder(Octo.teal.withValues(alpha: .65)),
                ),
              ),
            ),
        ],
      ),
    );
  }

  OutlineInputBorder _otherBorder(Color color) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(11),
    borderSide: BorderSide(color: color),
  );

  Widget _footer() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 11),
      child: Row(
        children: [
          _GhostButton(label: '先讨论', onTap: _canAct ? _chatAbout : null),
          const SizedBox(width: 8),
          Expanded(
            child: _PrimaryButton(
              label: '提交回答',
              enabled: _allAnswered && _canAct,
              onTap: _allAnswered && _canAct ? _submit : null,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAnswered() {
    final summary =
        widget.answeredSummary ??
        _localSummary ??
        (_discussSent ? '先讨论' : '已回答');
    final discuss = summary == '先讨论';
    final color = discuss ? Octo.amber : Octo.green;
    final subtitle = discuss
        ? '让 agent 先把选项解释清楚'
        : (summary == '已回答' ? '回答已发送' : summary);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        InkWell(
          borderRadius: BorderRadius.circular(13),
          onTap: () => setState(() => _expanded = !_expanded),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(13),
              color: color.withValues(alpha: .06),
              border: Border.all(color: color.withValues(alpha: .24)),
            ),
            child: Row(
              children: [
                Container(
                  width: 18,
                  height: 18,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: color.withValues(alpha: .12),
                    border: Border.all(color: color.withValues(alpha: .4)),
                  ),
                  child: Text(
                    '✓',
                    style: TextStyle(
                      fontFamily: Octo.mono,
                      fontSize: 10,
                      fontWeight: FontWeight.w800,
                      color: color,
                      height: 1,
                    ),
                  ),
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        summary == '先讨论' ? '已转讨论' : '已回答',
                        style: TextStyle(
                          fontSize: 11,
                          height: 1.3,
                          fontWeight: FontWeight.w700,
                          color: color,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 9.5,
                          height: 1.5,
                          color: Octo.metal,
                        ),
                      ),
                    ],
                  ),
                ),
                Text(
                  _expanded ? '收起 ›' : '展开 ›',
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 9.5,
                    color: Octo.dim,
                  ),
                ),
              ],
            ),
          ),
        ),
        if (_expanded)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Container(
              padding: const EdgeInsets.fromLTRB(10, 9, 10, 4),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(13),
                border: Border.all(color: Octo.hairlineSoft),
                color: const Color(0x660A0818),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (var i = 0; i < widget.questions.length; i++) ...[
                    if (i > 0) const SizedBox(height: 8),
                    Text(
                      '${i + 1} · ${widget.questions[i].header.isEmpty ? '问题' : widget.questions[i].header}',
                      style: const TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 8.5,
                        fontWeight: FontWeight.w800,
                        letterSpacing: .8,
                        color: Octo.teal,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      widget.questions[i].question,
                      style: const TextStyle(
                        fontSize: 12,
                        height: 1.5,
                        color: Octo.ink,
                      ),
                    ),
                    for (final option in widget.questions[i].options)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                          '· ${option.label}',
                          style: const TextStyle(
                            fontFamily: Octo.mono,
                            fontSize: 10,
                            height: 1.5,
                            color: Octo.dim,
                          ),
                        ),
                      ),
                  ],
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.option,
    required this.multi,
    required this.selected,
    required this.enabled,
    required this.onTap,
  });

  final AskOption option;
  final bool multi;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(11),
        onTap: enabled ? onTap : null,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(11),
            color: selected
                ? Octo.teal.withValues(alpha: .09)
                : Colors.white.withValues(alpha: .03),
            border: Border.all(
              color: selected
                  ? Octo.teal.withValues(alpha: .5)
                  : Octo.hairlineSoft,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1, right: 9),
                child: _Mark(selected: selected, multi: multi),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      option.label,
                      style: const TextStyle(
                        fontSize: 12,
                        height: 1.35,
                        fontWeight: FontWeight.w600,
                        color: Colors.white,
                      ),
                    ),
                    if (option.description.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        option.description,
                        style: const TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 9.5,
                          height: 1.55,
                          color: Octo.dim,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Mark extends StatelessWidget {
  const _Mark({required this.selected, required this.multi});

  final bool selected;
  final bool multi;

  @override
  Widget build(BuildContext context) {
    if (multi) {
      return Container(
        width: 15,
        height: 15,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(5),
          color: selected ? Octo.teal : const Color(0x800A0818),
          border: Border.all(
            color: selected ? Octo.teal : Octo.metal.withValues(alpha: .42),
          ),
        ),
        child: selected
            ? const Icon(Icons.check, size: 11, color: Color(0xFF06131A))
            : null,
      );
    }
    return Container(
      width: 15,
      height: 15,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: const Color(0x800A0818),
        border: Border.all(
          color: selected ? Octo.teal : Octo.metal.withValues(alpha: .42),
        ),
      ),
      child: selected
          ? Container(
              width: 7,
              height: 7,
              decoration: const BoxDecoration(
                shape: BoxShape.circle,
                color: Octo.teal,
              ),
            )
          : null,
    );
  }
}

class _GhostButton extends StatelessWidget {
  const _GhostButton({required this.label, this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: onTap == null ? .45 : 1,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(11),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(11),
              border: Border.all(color: Octo.hairline),
              color: Colors.white.withValues(alpha: .03),
            ),
            child: Text(
              label,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: Octo.metal,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({
    required this.label,
    required this.enabled,
    this.onTap,
  });

  final String label;
  final bool enabled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: enabled ? 1 : .45,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(11),
          onTap: enabled ? onTap : null,
          child: Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(11),
              gradient: Octo.accentGradient,
              boxShadow: enabled
                  ? const [
                      BoxShadow(
                        color: Color(0x3D2EE6D6),
                        blurRadius: 18,
                        offset: Offset(0, 6),
                      ),
                    ]
                  : null,
            ),
            child: Text(
              label,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 11,
                fontWeight: FontWeight.w800,
                letterSpacing: .8,
                color: Color(0xFF06131A),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
