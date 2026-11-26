import 'package:flutter/material.dart';

import '../app/theme.dart';

/// 输入区（原型 `.composer`）：快捷词药丸 + 圆角输入框 + 圆形发送键。
class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.onSend,
    this.placeholder = '说点什么…',
    this.helper,
    this.chips = const [],
    this.sending = false,
    this.enabled = true,
  });

  final Future<void> Function(String text) onSend;
  final String placeholder;
  final String? helper;
  final List<String> chips;
  final bool sending;
  final bool enabled;

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

  bool get _canSend => widget.enabled && !widget.sending && _hasText;

  Future<void> _submit() async {
    final text = _controller.text.trim();
    if (text.isEmpty || widget.sending || !widget.enabled) return;
    _controller.clear();
    setState(() => _hasText = false);
    _focus.requestFocus();
    await widget.onSend(text);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(12, 8, 12, MediaQuery.viewPaddingOf(context).bottom > 0 ? 4 : 10),
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
          if (widget.chips.isNotEmpty) ...[
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final chip in widget.chips)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: _Chip(
                        label: chip,
                        onTap: widget.sending
                            ? null
                            : () {
                                _controller.text = chip;
                                _controller.selection =
                                    TextSelection.collapsed(offset: chip.length);
                              },
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
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
                    hintText: widget.placeholder,
                    isDense: true,
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
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
                      borderSide: BorderSide(color: Octo.teal.withValues(alpha: .5)),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              _SendButton(
                enabled: _canSend,
                busy: widget.sending,
                onTap: _canSend ? _submit : null,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: .045),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: Octo.hairline.withValues(alpha: .9)),
          ),
          child: Text(
            label,
            style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: Octo.metal),
          ),
        ),
      ),
    );
  }
}

class _SendButton extends StatelessWidget {
  const _SendButton({required this.enabled, required this.busy, this.onTap});

  final bool enabled;
  final bool busy;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: enabled ? 1 : .4,
      child: Material(
        color: Colors.transparent,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              gradient: Octo.accentGradient,
              boxShadow: [BoxShadow(color: Color(0x422EE6D6), blurRadius: 18, offset: Offset(0, 6))],
            ),
            child: busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation(Color(0xFF06131A)),
                    ),
                  )
                : const Icon(Icons.arrow_upward, size: 19, color: Color(0xFF06131A)),
          ),
        ),
      ),
    );
  }
}
