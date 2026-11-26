import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../app/theme.dart';

/// v22 `#warp` 星流的手机端裁剪移植：每屏一组星，30fps，切后台停。
///
/// 不做 180 星全屏那套 —— 手机上每屏只留 70 星（减动效 30 星定格），
/// 画在独立 [CustomPainter] 里，tick 只触发 repaint，不重建 widget 树。
class Starfield extends StatefulWidget {
  const Starfield({super.key, this.starCount = 70, this.enabled = true});

  final int starCount;
  final bool enabled;

  @override
  State<Starfield> createState() => _StarfieldState();
}

class _StarfieldState extends State<Starfield>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  static const _frameInterval = Duration(milliseconds: 33); // ≈30fps

  late final Ticker _ticker;
  final ValueNotifier<int> _frame = ValueNotifier<int>(0);
  final List<_Star> _stars = [];
  final math.Random _rng = math.Random();
  Duration _last = Duration.zero;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _seed();
    _ticker = createTicker(_onTick);
    if (widget.enabled) _ticker.start();
  }

  @override
  void didUpdateWidget(covariant Starfield oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.enabled != widget.enabled) {
      if (widget.enabled) {
        _last = Duration.zero;
        _seed();
        _ticker.start();
      } else {
        _ticker.stop();
        _seed();
        _frame.value++;
      }
    } else if (oldWidget.starCount != widget.starCount) {
      _seed();
      _frame.value++;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!widget.enabled) return;
    if (state == AppLifecycleState.resumed) {
      if (!_ticker.isActive) {
        _last = Duration.zero;
        _ticker.start();
      }
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      _ticker.stop();
    }
  }

  void _seed() {
    _stars.clear();
    final n = widget.enabled ? widget.starCount : 30;
    for (var i = 0; i < n; i++) {
      _stars.add(_Star.random(_rng));
    }
  }

  void _onTick(Duration elapsed) {
    if (_last == Duration.zero) {
      _last = elapsed;
      return;
    }
    final delta = elapsed - _last;
    if (delta < _frameInterval) return;
    final dtMs = math.min(50, delta.inMilliseconds).toDouble();
    _last = elapsed;
    final speed = .00004 * dtMs; // v22 的 sp
    for (final star in _stars) {
      star.pz = star.z;
      star.z -= speed;
      if (star.z <= .02) {
        star
          ..x = (_rng.nextDouble() - .5) * 2
          ..y = (_rng.nextDouble() - .5) * 2
          ..z = 1
          ..pz = 1;
      }
    }
    _frame.value++;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _ticker.dispose();
    _frame.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: RepaintBoundary(
        child: CustomPaint(
          painter: _WarpPainter(stars: _stars, repaint: _frame),
          child: const SizedBox.expand(),
        ),
      ),
    );
  }
}

class _Star {
  _Star(this.x, this.y, this.z) : pz = z;

  factory _Star.random(math.Random rng) => _Star(
        (rng.nextDouble() - .5) * 2,
        (rng.nextDouble() - .5) * 2,
        rng.nextDouble() * .9 + .1,
      );

  double x;
  double y;
  double z;
  double pz;
}

class _WarpPainter extends CustomPainter {
  _WarpPainter({required this.stars, required Listenable repaint})
      : super(repaint: repaint);

  final List<_Star> stars;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty || stars.isEmpty) return;
    final cxx = size.width / 2;
    final cy = size.height * .46;
    final paint = Paint()..strokeCap = StrokeCap.round;

    for (final s in stars) {
      final k = 1 / s.z;
      final pk = 1 / s.pz;
      final x = cxx + s.x * cxx * k * .6;
      final y = cy + s.y * cy * k * .6;
      final px = cxx + s.x * cxx * pk * .6;
      final py = cy + s.y * cy * pk * .6;
      if (x < -30 || x > size.width + 30 || y < -30 || y > size.height + 30) {
        continue;
      }
      paint
        ..color = Octo.teal.withValues(alpha: _clamp((1 - s.z) * .16, .03, .6))
        ..strokeWidth = _clamp((1 - s.z) * .9, .3, 1.6);
      canvas.drawLine(Offset(px, py), Offset(x, y), paint);
    }
  }

  static double _clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);

  @override
  bool shouldRepaint(covariant _WarpPainter oldDelegate) =>
      oldDelegate.stars.length != stars.length;
}
