import 'package:flutter/material.dart';

import '../app/theme.dart';
import 'starfield.dart';

/// 底景：全舱模式同一套场景图 + v22 星流 canvas + 压暗层。
/// 一屏固定两幕：列表/空态 `cruise`，会话/详情 `deepspace`。
class SceneBackground extends StatefulWidget {
  const SceneBackground({
    super.key,
    required this.asset,
    this.starCount = 70,
    this.child,
  });

  /// `assets/scenes/scene-cruise.png`
  final String asset;
  final int starCount;
  final Widget? child;

  static const cruise = 'assets/scenes/scene-cruise.png';
  static const deepspace = 'assets/scenes/scene-deepspace.png';

  @override
  State<SceneBackground> createState() => _SceneBackgroundState();
}

class _SceneBackgroundState extends State<SceneBackground>
    with SingleTickerProviderStateMixin {
  late final AnimationController _breath;

  @override
  void initState() {
    super.initState();
    _breath = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 24),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _breath.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        const ColoredBox(color: Octo.deep),
        AnimatedBuilder(
          animation: _breath,
          builder: (context, child) {
            // 1.02 → 1.06 的极慢呼吸（原型 @keyframes breath）
            final scale = 1.02 + Curves.easeInOut.transform(_breath.value) * 0.04;
            return Transform.scale(scale: scale, child: child);
          },
          child: Image.asset(
            widget.asset,
            fit: BoxFit.cover,
            alignment: const Alignment(0, -0.16),
            gaplessPlayback: true,
            errorBuilder: (_, __, ___) => const ColoredBox(color: Octo.deep),
          ),
        ),
        Starfield(starCount: widget.starCount),
        // 压暗 + 边缘晕影（原型 .grade）
        const DecoratedBox(
          decoration: BoxDecoration(gradient: Octo.gradeGradient),
          child: SizedBox.expand(),
        ),
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              center: const Alignment(0, -0.1),
              radius: 1.05,
              colors: [
                Colors.transparent,
                Octo.deep.withValues(alpha: .52),
              ],
              stops: const [0.4, 1.0],
            ),
          ),
          child: const SizedBox.expand(),
        ),
        if (widget.child != null) widget.child!,
      ],
    );
  }
}
