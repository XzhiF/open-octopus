import 'package:flutter/material.dart';

import '../app/theme.dart';

/// 圆角玻璃面板（原型 `.pnl`）。
class RoundedPanel extends StatelessWidget {
  const RoundedPanel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(14),
    this.radius = Octo.rL,
    this.borderColor,
    this.gradient,
    this.onTap,
    this.margin = EdgeInsets.zero,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Color? borderColor;
  final Gradient? gradient;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry margin;

  @override
  Widget build(BuildContext context) {
    final content = Container(
      margin: margin,
      padding: padding,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: borderColor ?? Octo.hairline),
        gradient: gradient ?? Octo.panelGradient,
        boxShadow: const [
          BoxShadow(color: Color(0x2E000000), blurRadius: 24, offset: Offset(0, 8)),
        ],
      ),
      child: child,
    );
    if (onTap == null) return content;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(radius),
        onTap: onTap,
        child: content,
      ),
    );
  }
}

/// 带左缘色条的卡片（原型 `.todo`：border-left:3px solid var(--c)）。
class AccentPanel extends StatelessWidget {
  const AccentPanel({
    super.key,
    required this.child,
    required this.accent,
    this.padding = const EdgeInsets.fromLTRB(17, 13, 14, 13),
    this.onTap,
    this.borderColor,
    this.margin = EdgeInsets.zero,
  });

  final Widget child;
  final Color accent;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final Color? borderColor;
  final EdgeInsetsGeometry margin;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        RoundedPanel(
          padding: padding,
          onTap: onTap,
          margin: margin,
          borderColor: borderColor,
          child: child,
        ),
        Positioned(
          left: 0,
          top: 12,
          bottom: 12,
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
    );
  }
}

/// 药丸标签（原型 `.bdg` / `.st`）。
class StatusPill extends StatelessWidget {
  const StatusPill({
    super.key,
    required this.label,
    required this.color,
    this.fontSize = 9.5,
    this.padding = const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
  });

  final String label;
  final Color color;
  final double fontSize;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color.withValues(alpha: .12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: .3)),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: Octo.mono,
          fontSize: fontSize,
          fontWeight: FontWeight.w800,
          letterSpacing: .5,
          color: color,
          height: 1,
        ),
      ),
    );
  }
}

/// 小标题 + 渐隐横线（原型 `.sec`）。
class SectionTitle extends StatelessWidget {
  const SectionTitle(this.label, {super.key, this.trailing});

  final String label;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 4, 2, 0),
      child: Row(
        children: [
          Text(
            label,
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: .7,
              color: Color(0xD92EE6D6),
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 8), trailing!],
          const SizedBox(width: 9),
          Expanded(
            child: Container(
              height: 1,
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [Color(0x422EE6D6), Colors.transparent],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 主按钮（原型 `.primary`）：青绿渐变、圆角 18。
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.busy = false,
    this.height = 52,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  final double height;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    return Opacity(
      opacity: enabled ? 1 : .55,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(Octo.rL),
          onTap: enabled ? onPressed : null,
          child: Container(
            height: height,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              gradient: Octo.accentGradient,
              borderRadius: BorderRadius.circular(Octo.rL),
              boxShadow: const [
                BoxShadow(color: Color(0x422EE6D6), blurRadius: 26, offset: Offset(0, 10)),
              ],
            ),
            child: busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation(Color(0xFF06131A)),
                    ),
                  )
                : Text(
                    label,
                    style: const TextStyle(
                      fontFamily: Octo.mono,
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.6,
                      color: Color(0xFF06131A),
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}

/// 虚线幽灵按钮（原型 `.ghost`）。
class GhostButton extends StatelessWidget {
  const GhostButton({super.key, required this.label, this.onTap, this.icon});

  final String label;
  final VoidCallback? onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(Octo.rL),
        onTap: onTap,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(vertical: 15),
          decoration: BoxDecoration(
            color: Octo.teal.withValues(alpha: .04),
            borderRadius: BorderRadius.circular(Octo.rL),
            border: Border.all(color: Octo.teal.withValues(alpha: .4), style: BorderStyle.solid),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 15, color: Octo.teal),
                const SizedBox(width: 8),
              ],
              Text(
                label,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  letterSpacing: .3,
                  color: Octo.teal,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 顶部圆形/方形小按钮（原型 `.bar .back` / `.bar .act`）。
class BarIconButton extends StatelessWidget {
  const BarIconButton({
    super.key,
    required this.child,
    this.onTap,
    this.round = false,
    this.primaryStyle = false,
  });

  final Widget child;
  final VoidCallback? onTap;
  final bool round;
  final bool primaryStyle;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(round ? 999 : Octo.rS + 2),
        onTap: onTap,
        child: Container(
          height: 30,
          constraints: const BoxConstraints(minWidth: 30),
          padding: primaryStyle
              ? const EdgeInsets.symmetric(horizontal: 12)
              : EdgeInsets.zero,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(round ? 999 : Octo.rS + 2),
            color: primaryStyle
                ? Octo.teal.withValues(alpha: .08)
                : Colors.white.withValues(alpha: .05),
            border: Border.all(
              color: primaryStyle ? Octo.teal.withValues(alpha: .4) : Octo.hairlineSoft,
            ),
          ),
          child: child,
        ),
      ),
    );
  }
}
