import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../core/models/quote.dart';
import 'panel.dart';

/// 引用条（原型 `mobile-v1.html` G 屏 `.quote`）：
/// `正在回复` + 问题原文 + 来源 / 轮次 / 依据条数。
///
/// 硬规则（design 34 §3）：这里不出现任何「通过 / 退回」按钮；人回完话还是
/// 正常消息，状态由 agent 改。
class QuoteBar extends StatelessWidget {
  const QuoteBar({
    super.key,
    required this.quote,
    this.evidenceCount,
    this.onClose,
    this.margin = const EdgeInsets.fromLTRB(16, 10, 16, 6),
  });

  final SessionQuote quote;

  /// 依据条数（从会话快照里数出来的工具行）；null / 0 时不显示。
  final int? evidenceCount;
  final VoidCallback? onClose;
  final EdgeInsetsGeometry margin;

  @override
  Widget build(BuildContext context) {
    final accent = quote.stage.isReview ? Octo.pink : Octo.amber;
    final evidence = evidenceCount;

    return Container(
      margin: margin,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(Octo.rL),
        border: Border.all(color: accent.withValues(alpha: .22)),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0x1AFF6FB5), Color(0x990E0B22)],
        ),
        boxShadow: const [
          BoxShadow(color: Color(0x2E000000), blurRadius: 18, offset: Offset(0, 6)),
        ],
      ),
      child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(17, 10, 13, 11),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    _CloseDot(onTap: onClose),
                    const SizedBox(width: 7),
                    const Text(
                      '正在回复',
                      style: TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 8.5,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.6,
                        color: Octo.pink,
                      ),
                    ),
                    const Spacer(),
                    StatusPill(label: quote.stage.label, color: accent, fontSize: 8.5),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  quote.question,
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    height: 1.5,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 6),
                Text.rich(
                  TextSpan(
                    style: const TextStyle(
                      fontFamily: Octo.mono,
                      fontSize: 9.5,
                      height: 1.4,
                      letterSpacing: .3,
                      color: Octo.dim,
                    ),
                    children: [
                      TextSpan(text: quote.sourceLine),
                      if (evidence != null && evidence > 0) ...[
                        const TextSpan(text: '   '),
                        TextSpan(
                          text: '依据 $evidence 条',
                          style: const TextStyle(
                            color: Octo.teal,
                            decoration: TextDecoration.underline,
                            decorationStyle: TextDecorationStyle.dotted,
                            decorationColor: Color(0x8C2EE6D6),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
          Positioned(
            left: 0,
            top: 10,
            bottom: 10,
            child: IgnorePointer(
              child: Container(
                width: 3,
                decoration: BoxDecoration(
                  color: accent,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 关闭引用（舱系规则：✕ 放容器最左）。
class _CloseDot extends StatelessWidget {
  const _CloseDot({this.onTap});

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    if (onTap == null) return const SizedBox(width: 16, height: 16);
    return Material(
      color: Colors.transparent,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: Container(
          width: 16,
          height: 16,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.white.withValues(alpha: .06),
            border: Border.all(color: Octo.hairlineSoft),
          ),
          child: const Icon(Icons.close, size: 10, color: Octo.metal2),
        ),
      ),
    );
  }
}
