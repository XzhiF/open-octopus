import 'dart:async';

import 'package:flutter/material.dart';

import '../app/theme.dart';

/// 冷启动的品牌启动页。
///
/// 系统启动页（Android 12+ 的 SplashScreen API）只允许「底色 + 图标」，
/// 所以光环、字标、副标题在这里补：原生那层用同一个底色 [Octo.screen]
/// 接住白屏，Flutter 第一帧起这一层接管，约 1.2 秒后淡出。
///
/// 只出现一次（每次进程冷启动）；切后台回来不会重播。
class SplashGate extends StatefulWidget {
  const SplashGate({
    super.key,
    required this.child,
    this.hold = const Duration(milliseconds: 900),
  });

  final Widget child;

  /// 至少停留多久再开始淡出。太短看不到，太长像卡住。
  final Duration hold;

  @override
  State<SplashGate> createState() => _SplashGateState();
}

class _SplashGateState extends State<SplashGate> with TickerProviderStateMixin {
  late final AnimationController _entry = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 320),
  );
  late final AnimationController _fade = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 320),
    value: 1,
  );
  late final AnimationController _breathe = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  );

  Timer? _timer;
  bool _gone = false;

  @override
  void initState() {
    super.initState();
    _entry.forward();
    _breathe.repeat(reverse: true);
    _timer = Timer(widget.hold, _dismiss);
  }

  Future<void> _dismiss() async {
    if (!mounted) return;
    _breathe.stop();
    await _fade.reverse();
    if (mounted) setState(() => _gone = true);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _entry.dispose();
    _fade.dispose();
    _breathe.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        widget.child,
        if (!_gone)
          Positioned.fill(
            child: FadeTransition(
              opacity: _fade,
              child: IgnorePointer(
                child: _SplashArt(
                  entry: _entry,
                  breathe: _breathe,
                  // 系统「移除动画」开关打开时不呼吸、只静态显示。
                  still: MediaQuery.maybeDisableAnimationsOf(context) ?? false,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _SplashArt extends StatelessWidget {
  const _SplashArt({required this.entry, required this.breathe, required this.still});

  final Animation<double> entry;
  final Animation<double> breathe;
  final bool still;

  @override
  Widget build(BuildContext context) {
    final block = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedBuilder(
          animation: breathe,
          builder: (context, child) {
            final t = still ? 0.35 : breathe.value;
            return Stack(
              alignment: Alignment.center,
              children: [
                // 光环：慢呼吸（透明度 0.22 → 0.65，整体微缩）。
                Transform.scale(
                  scale: 1 + 0.03 * t,
                  child: CustomPaint(
                    size: const Size(192, 192),
                    painter: _RingPainter(opacity: 0.22 + 0.43 * t),
                  ),
                ),
                child!,
              ],
            );
          },
          child: const _SplashMark(size: 124),
        ),
        const SizedBox(height: 26),
        const Text(
          'OCTOPUS',
          style: TextStyle(
            color: Octo.ink,
            fontSize: 22,
            fontWeight: FontWeight.w700,
            letterSpacing: 8,
          ),
        ),
        const SizedBox(height: 10),
        const Text(
          '汐音 · 作战舱',
          style: TextStyle(
            color: Octo.faint,
            fontSize: 13,
            letterSpacing: 3,
          ),
        ),
      ],
    );

    // Material 而不是 ColoredBox：没有 Material 祖先时，debug 下 Text 会被画出
    // 黄色双下划线（Flutter 的「缺少 Material」提示）。
    return Material(
      color: Octo.screen,
      child: Center(
        child: FadeTransition(
          opacity: entry,
          child: ScaleTransition(
            scale: Tween<double>(begin: 0.96, end: 1).animate(
              CurvedAnimation(parent: entry, curve: Curves.easeOutCubic),
            ),
            child: block,
          ),
        ),
      ),
    );
  }
}

/// 与桌面图标同一张立绘：圆角 24%（同 launcher 图标的观感）。
class _SplashMark extends StatelessWidget {
  const _SplashMark({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.24),
        boxShadow: [
          BoxShadow(
            color: Octo.teal.withValues(alpha: 0.16),
            blurRadius: 44,
            spreadRadius: 2,
          ),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: Image.asset('assets/icon/icon.png', fit: BoxFit.cover),
    );
  }
}

class _RingPainter extends CustomPainter {
  const _RingPainter({required this.opacity});

  final double opacity;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4
      ..shader = SweepGradient(
        colors: [
          Octo.teal.withValues(alpha: 0),
          Octo.teal.withValues(alpha: opacity),
          Octo.sky.withValues(alpha: opacity * 0.7),
          Octo.teal.withValues(alpha: 0),
        ],
        stops: const [0.0, 0.35, 0.7, 1.0],
      ).createShader(rect);
    canvas.drawOval(rect.deflate(1), paint);
  }

  @override
  bool shouldRepaint(_RingPainter oldDelegate) => oldDelegate.opacity != opacity;
}
