import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../core/haptics.dart';

/// 全舱模式那 13 支立绘里随包先带 3 支（其余按需再放，控制安装包体积）。
///
/// 为什么是 WebP 而不是原来的 VP9 alpha WebM：Flutter 在 Android 上的 video_player
/// 走 SurfaceTexture，整帧不透明 —— 带 alpha 的 webm 会显示成一块黑底。
/// 同一份画稿转成带透明通道的 animated WebP 后由 `Image` 解码，alpha 就正常了
/// （480×720 / 12fps / 60 帧循环，3 支合计约 10 MB）。
class CrewClip {
  const CrewClip(this.file, this.label);

  final String file;
  final String label;
}

const kCrewClips = <CrewClip>[
  CrewClip('assets/clips/07-idle.webp', '待命 IDLE'),
  CrewClip('assets/clips/05-concerned.webp', '担忧 WORRIED'),
  CrewClip('assets/clips/09-smile.webp', '愉悦 SMILE'),
];

/// 立绘：一屏最多一支。点一下换下一支（同 v22 的交互）。
///
/// 只有动画一种形态 —— 没有静态兜底图（那张深底画像贴在场景上很难看）。
/// [animated] 关掉就整支不画。
class CrewFigure extends StatefulWidget {
  const CrewFigure({
    super.key,
    this.height = 250,
    this.animated = true,
    this.cycleOnTap = true,
    this.initialIndex = 0,
    this.alignment = Alignment.bottomRight,
    this.onClipChanged,
  });

  final double height;
  final bool animated;
  final bool cycleOnTap;
  final int initialIndex;
  final Alignment alignment;
  final ValueChanged<CrewClip>? onClipChanged;

  @override
  State<CrewFigure> createState() => _CrewFigureState();
}

class _CrewFigureState extends State<CrewFigure> {
  late int _index = widget.initialIndex.clamp(0, kCrewClips.length - 1);

  void _next() {
    if (!widget.cycleOnTap) return;
    Haptics.tap();
    setState(() => _index = (_index + 1) % kCrewClips.length);
    widget.onClipChanged?.call(kCrewClips[_index]);
  }

  @override
  Widget build(BuildContext context) {
    // 关掉动画 = 不画立绘（没有静态兜底图）。
    if (!widget.animated) return const SizedBox.shrink();
    final clip = kCrewClips[_index];
    return GestureDetector(
      onTap: _next,
      child: SizedBox(
        height: widget.height,
        child: Align(
          alignment: widget.alignment,
          child: AspectRatio(
            aspectRatio: 2 / 3,
            child: Image.asset(
              clip.file,
              // 换支时旧帧继续显示，新动画解出第一帧再替换 —— 不再闪一下别的画面。
              gaplessPlayback: true,
              fit: BoxFit.contain,
              alignment: Alignment.bottomCenter,
              errorBuilder: (_, _, _) => const SizedBox.shrink(),
            ),
          ),
        ),
      ),
    );
  }
}

/// 右下角站立位 + 地面光晕（原型 `.stage`）。
/// 动画关掉时整块不画（不给静态图兜底）。不写动作文字标签。
class CrewStage extends StatelessWidget {
  const CrewStage({super.key, required this.height, this.animated = true});

  final double height;
  final bool animated;

  @override
  Widget build(BuildContext context) {
    if (!animated) return const SizedBox.shrink();
    return SizedBox(
      height: height + 26,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            right: 2,
            bottom: 10,
            child: Container(
              width: 196,
              height: 32,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(999),
                gradient: RadialGradient(
                  colors: [
                    Octo.teal.withValues(alpha: .22),
                    Colors.transparent,
                  ],
                  stops: const [0, .72],
                ),
              ),
            ),
          ),
          Positioned(
            right: -10,
            bottom: 0,
            child: CrewFigure(height: height, animated: animated),
          ),
        ],
      ),
    );
  }
}

/// 头像：12px 圆角方块（原型 `.ava`）。
class CrewAvatar extends StatelessWidget {
  const CrewAvatar({super.key, this.size = 36});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Octo.teal.withValues(alpha: .4)),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0x292EE6D6), Color(0x2E7B4DFF)],
        ),
        boxShadow: [
          BoxShadow(color: Octo.teal.withValues(alpha: .06), spreadRadius: 3),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: Image.asset(
        'assets/crew/xiyin-idle.png',
        fit: BoxFit.cover,
        alignment: const Alignment(0, -.88),
        errorBuilder: (_, _, _) =>
            const Icon(Icons.person_outline, size: 18, color: Octo.teal),
      ),
    );
  }
}
