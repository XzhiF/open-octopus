import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../core/format.dart';
import '../../core/models/telemetry.dart';

/// 通讯台头（原型 E / E3–E9）：`✦ 星核 · model · ctx · tok · ≡ 轮次`。
///
/// 一行只放读数，不放动作文案 —— 点哪枚芯片就向下（底部抽屉）展开哪份明细。
class ConsoleBar extends StatelessWidget {
  const ConsoleBar({
    super.key,
    required this.model,
    required this.contextUsage,
    required this.usage,
    required this.turns,
    this.onCoreTap,
    this.onModelTap,
    this.onCtxTap,
    this.onTokTap,
    this.onTurnsTap,
  });

  final String model;
  final ContextUsage? contextUsage;
  final SessionUsage usage;
  final int turns;
  final VoidCallback? onCoreTap;
  final VoidCallback? onModelTap;
  final VoidCallback? onCtxTap;
  final VoidCallback? onTokTap;
  final VoidCallback? onTurnsTap;

  @override
  Widget build(BuildContext context) {
    final ctx = contextUsage;
    final pct = ctx?.clampedPercentage ?? 0;
    final tone = _ctxTone(ctx);
    final tokLabel = usage.totalCalls > 0 ? formatTokNum(usage.tokens) : '--';

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 7, 12, 0),
      child: Row(
        children: [
          _CoreOrb(onTap: onCoreTap),
          const SizedBox(width: 6),
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  _ConsoleChip(
                    label: 'model',
                    value: model,
                    valueColor: Octo.green,
                    onTap: onModelTap,
                  ),
                  const SizedBox(width: 6),
                  _ConsoleChip(
                    label: 'ctx',
                    value: ctx == null
                        ? '--'
                        : '${ctx.estimated ? '~' : ''}${pct.toStringAsFixed(1)}%',
                    valueColor: tone,
                    fill: pct / 100,
                    showBar: true,
                    onTap: onCtxTap,
                  ),
                  const SizedBox(width: 6),
                  _ConsoleChip(
                    label: 'tok',
                    value: tokLabel,
                    valueColor: Octo.teal,
                    onTap: onTokTap,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 6),
          _ConsoleChip(
            label: '',
            value: '≡ $turns轮',
            valueColor: Octo.teal,
            strongBorder: true,
            onTap: onTurnsTap,
          ),
        ],
      ),
    );
  }

  static Color _ctxTone(ContextUsage? ctx) {
    if (ctx == null) return Octo.dim;
    final pct = ctx.clampedPercentage;
    if (pct >= 85) return Octo.red;
    if (pct >= 60) return Octo.amber;
    return Octo.teal;
  }
}

/// 星核按钮：28px 圆球，径向青晕；点开四栏抽屉。
class _CoreOrb extends StatelessWidget {
  const _CoreOrb({this.onTap});

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: Container(
          width: 28,
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: Octo.teal.withValues(alpha: .4)),
            gradient: const RadialGradient(
              center: Alignment(0, -.2),
              radius: .6,
              colors: [Color(0x2E2EE6D6), Color(0x9E0A0818)],
            ),
            boxShadow: [
              BoxShadow(color: Octo.teal.withValues(alpha: .2), blurRadius: 12),
            ],
          ),
          // ✦ 的 ink box 在等宽字体里天然偏下 ~2dp；往上提一点才是视觉正中。
          child: Transform.translate(
            offset: const Offset(0, -2),
            child: const Text(
              '✦',
              style: TextStyle(fontSize: 12, height: 1, color: Octo.teal),
            ),
          ),
        ),
      ),
    );
  }
}

class _ConsoleChip extends StatelessWidget {
  const _ConsoleChip({
    required this.label,
    required this.value,
    required this.valueColor,
    this.fill = 0,
    this.showBar = false,
    this.strongBorder = false,
    this.onTap,
  });

  final String label;
  final String value;
  final Color valueColor;

  /// 0–1：ctx 芯片里的整格淡填充宽度。
  final double fill;
  final bool showBar;
  final bool strongBorder;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Container(
          height: 24,
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: const Color(0xA8100D28),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: strongBorder
                  ? Octo.teal.withValues(alpha: .38)
                  : Octo.hairline,
            ),
          ),
          child: Stack(
            // 非 Positioned 的文本行按 Stack 默认对齐会贴顶 —— 芯片字要正中。
            alignment: Alignment.center,
            children: [
              if (showBar && fill > 0)
                Positioned.fill(
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: FractionallySizedBox(
                      widthFactor: fill.clamp(0, 1).toDouble(),
                      heightFactor: 1,
                      child: ColoredBox(
                        color: valueColor.withValues(alpha: .14),
                      ),
                    ),
                  ),
                ),
              if (showBar)
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 2,
                  child: Stack(
                    children: [
                      Positioned.fill(child: ColoredBox(color: Octo.hairline)),
                      Positioned.fill(
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: FractionallySizedBox(
                            widthFactor: fill.clamp(0, 1).toDouble(),
                            heightFactor: 1,
                            child: ColoredBox(color: valueColor),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (label.isNotEmpty) ...[
                      Text(
                        label,
                        style: const TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 10.5,
                          height: 1,
                          letterSpacing: .2,
                          color: Octo.dim,
                        ),
                      ),
                      const SizedBox(width: 4),
                    ],
                    Text(
                      value,
                      style: TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 10.5,
                        height: 1,
                        letterSpacing: .2,
                        fontWeight: FontWeight.w700,
                        color: valueColor,
                      ),
                    ),
                    if (label.isNotEmpty) ...[
                      const SizedBox(width: 3),
                      const Text(
                        '▾',
                        style: TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 8,
                          height: 1,
                          color: Color(0xB38D86B8),
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
