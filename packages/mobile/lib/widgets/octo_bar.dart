import 'package:flutter/material.dart';

import '../app/theme.dart';
import 'panel.dart';

/// 顶栏（原型 `.bar`）：返回 + 标题（带等宽编号）+ 副标题 + 右侧动作。
class OctoBar extends StatelessWidget {
  const OctoBar({
    super.key,
    required this.title,
    this.num,
    this.subtitle,
    this.onBack,
    this.leading,
    this.actions = const [],
    this.padding = const EdgeInsets.fromLTRB(16, 4, 16, 12),
  });

  final String title;
  final String? num;
  final String? subtitle;
  final VoidCallback? onBack;
  final Widget? leading;
  final List<Widget> actions;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: padding,
      child: Row(
        children: [
          if (leading != null)
            leading!
          else if (onBack != null) ...[
            BarIconButton(
              onTap: onBack,
              child: const Icon(Icons.chevron_left, size: 20, color: Octo.metal2),
            ),
            const SizedBox(width: 11),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Flexible(
                      child: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: OctoText.title,
                      ),
                    ),
                    if (num != null && num!.isNotEmpty) ...[
                      const SizedBox(width: 7),
                      Text(
                        num!,
                        style: const TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 8.5,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.4,
                          color: Octo.teal,
                        ),
                      ),
                    ],
                  ],
                ),
                if (subtitle != null && subtitle!.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    subtitle!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontFamily: Octo.mono,
                      fontSize: 10,
                      letterSpacing: .4,
                      color: Octo.dim,
                    ),
                  ),
                ],
              ],
            ),
          ),
          for (final action in actions) ...[const SizedBox(width: 8), action],
        ],
      ),
    );
  }
}

/// 极细等宽 rail（原型 `.rail`）：`⬡ 书房 PC · LINK 12ms · DECK 4`。
class RailLine extends StatelessWidget {
  const RailLine({super.key, this.left, this.middle, this.right, this.accentMiddle = true});

  final String? left;
  final String? middle;
  final String? right;
  final bool accentMiddle;

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(
      fontFamily: Octo.mono,
      fontSize: 9,
      letterSpacing: .7,
      color: Octo.dim,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
      child: Row(
        children: [
          if (left != null) Text(left!, style: style),
          if (middle != null) ...[
            const SizedBox(width: 10),
            Text(
              middle!,
              style: style.copyWith(color: accentMiddle ? Octo.teal : Octo.dim),
            ),
          ],
          const Spacer(),
          if (right != null) Text(right!, style: style),
        ],
      ),
    );
  }
}
