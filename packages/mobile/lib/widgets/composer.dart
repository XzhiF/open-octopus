import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../core/haptics.dart';

/// 输入区（原型 `.composer`）：圆角输入框 + 圆形发送键。
/// 原型定稿不要预设快捷词 —— 输入框上方只留控制行（身份 / 委派）。
///
/// 发送键三个状态（原型 §4）：
///   · 空输入：暗底 + 细边，不可按；
///   · 可发送：亮青渐变，唯一实心钮；
///   · 跑动中：暗底 + 琥珀方键 —— 语义是「停」，不再把转圈塞进亮青圆钮。
class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.onSend,
    this.onStop,
    this.placeholder = '说点什么…',
    this.helper,
    this.sending = false,
    this.enabled = true,
    this.controls,
  });

  final Future<void> Function(String text) onSend;

  /// 跑动中点停止。
  final Future<void> Function()? onStop;
  final String placeholder;
  final String? helper;
  final bool sending;
  final bool enabled;

  /// 输入区上方的一行控制（原型 `.ctrlrow`）：挂着的技能 / 一次性委派。
  final Widget? controls;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focus = FocusNode();
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      final has = _controller.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final text = _controller.text.trim();
    if (text.isEmpty || widget.sending || !widget.enabled) return;
    Haptics.tap();
    _controller.clear();
    setState(() => _hasText = false);
    // 发出去就收键盘、把镜头让给消息流（原型 §4 的交互要求）。
    // 不再 requestFocus —— 键盘一收，聊天面板立刻落到底部的运行态。
    _focus.unfocus();
    FocusManager.instance.primaryFocus?.unfocus();
    await widget.onSend(text);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(
        12,
        8,
        12,
        MediaQuery.viewPaddingOf(context).bottom > 0 ? 4 : 10,
      ),
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Color(0x66080612), Color(0xB8080612)],
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (widget.controls != null) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(2, 0, 2, 8),
              child: Row(children: [widget.controls!]),
            ),
          ],
          if (widget.helper != null) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
              child: Text(
                widget.helper!,
                style: const TextStyle(
                  fontFamily: Octo.mono,
                  fontSize: 10,
                  height: 1.5,
                  color: Octo.faint,
                ),
              ),
            ),
          ],
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: _controller,
                  focusNode: _focus,
                  enabled: widget.enabled,
                  minLines: 1,
                  maxLines: 5,
                  textInputAction: TextInputAction.newline,
                  keyboardType: TextInputType.multiline,
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 11.5,
                    height: 1.45,
                    color: Octo.ink,
                  ),
                  decoration: InputDecoration(
                    hintText: widget.sending
                        ? '正在跑…（点 ■ 停）'
                        : widget.placeholder,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 13,
                      vertical: 13,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: const BorderSide(color: Octo.hairline),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: const BorderSide(color: Octo.hairline),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: BorderSide(
                        color: Octo.teal.withValues(alpha: .5),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              _SendButton(
                hasText: _hasText,
                busy: widget.sending,
                enabled: widget.enabled,
                onSend: _submit,
                onStop: widget.onStop,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SendButton extends StatefulWidget {
  const _SendButton({
    required this.hasText,
    required this.busy,
    required this.enabled,
    required this.onSend,
    this.onStop,
  });

  final bool hasText;
  final bool busy;
  final bool enabled;
  final VoidCallback onSend;
  final Future<void> Function()? onStop;

  @override
  State<_SendButton> createState() => _SendButtonState();
}

class _SendButtonState extends State<_SendButton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _breathe = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1900),
  );

  @override
  void initState() {
    super.initState();
    _syncBreathe();
  }

  @override
  void didUpdateWidget(covariant _SendButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.busy != widget.busy) _syncBreathe();
  }

  void _syncBreathe() {
    if (widget.busy) {
      if (!_breathe.isAnimating) _breathe.repeat(reverse: true);
    } else if (_breathe.isAnimating) {
      _breathe.stop();
    }
  }

  @override
  void dispose() {
    _breathe.dispose();
    super.dispose();
  }

  void _onTap() {
    if (widget.busy) {
      Haptics.tap();
      widget.onStop?.call();
      return;
    }
    if (!widget.hasText || !widget.enabled) return;
    widget.onSend();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.busy) return _build(context, 0);
    return AnimatedBuilder(
      animation: _breathe,
      builder: (context, _) => _build(context, _breathe.value),
    );
  }

  /// [breath] 0–1：跑动中让琥珀外圈缓慢起伏（原型 `btnbreathe`）。
  Widget _build(BuildContext context, double breath) {
    final canSend = widget.hasText && widget.enabled && !widget.busy;
    final busy = widget.busy;
    final shadow = canSend
        ? const [
            BoxShadow(
              color: Color(0x422EE6D6),
              blurRadius: 18,
              offset: Offset(0, 6),
            ),
          ]
        : busy
        ? [
            BoxShadow(
              color: Octo.amber.withValues(alpha: .06 + .06 * breath),
              spreadRadius: 3 + breath,
            ),
            BoxShadow(
              color: Octo.amber.withValues(alpha: .12 + .14 * breath),
              blurRadius: 14 + 10 * breath,
            ),
          ]
        : null;

    return Opacity(
      opacity: !busy && !canSend ? .55 : 1,
      child: Material(
        color: Colors.transparent,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: busy ? _onTap : (canSend ? _onTap : null),
          child: Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: canSend ? Octo.accentGradient : null,
              color: canSend
                  ? null
                  : (busy ? const Color(0xEB0A0818) : const Color(0xB8100D28)),
              border: canSend
                  ? null
                  : Border.all(
                      color: busy
                          ? Octo.amber.withValues(alpha: .55)
                          : const Color(0x38B9B3D9),
                    ),
              boxShadow: shadow,
            ),
            child: busy
                ? Container(
                    width: 12,
                    height: 12,
                    decoration: BoxDecoration(
                      color: Octo.amber,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  )
                : Icon(
                    Icons.arrow_upward,
                    size: 19,
                    color: canSend
                        ? const Color(0xFF06131A)
                        : const Color(0x8C8D86B8),
                  ),
          ),
        ),
      ),
    );
  }
}
