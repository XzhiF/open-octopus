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

/// 右下角站立位 + 地面光晕 + 动作标签（原型 `.stage`）。
/// 动画关掉时整块不画（不给静态图兜底）。
class CrewStage extends StatefulWidget {
  const CrewStage({
    super.key,
    required this.height,
    this.animated = true,
    this.label = '汐音 · 待命 IDLE',
  });

  final double height;
  final bool animated;
  final String label;

  @override
  State<CrewStage> createState() => _CrewStageState();
}

class _CrewStageState extends State<CrewStage> {
  late String _label = widget.label;

  @override
  Widget build(BuildContext context) {
    if (!widget.animated) return const SizedBox.shrink();
    return SizedBox(
      height: widget.height + 26,
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
                  colors: [Octo.teal.withValues(alpha: .22), Colors.transparent],
                  stops: const [0, .72],
                ),
              ),
            ),
          ),
          Positioned(
            right: -10,
            bottom: 0,
            child: CrewFigure(
              height: widget.height,
              animated: widget.animated,
              // 点一下换支，标签跟着走 —— 不然视频换了她还写着「待命」。
              onClipChanged: (clip) => setState(() => _label = '汐音 · ${clip.label}'),
            ),
          ),
          Positioned(
            right: 8,
            bottom: 2,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
              decoration: BoxDecoration(
                color: const Color(0xA80A0818),
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: Octo.edge),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 4,
                    height: 4,
                    decoration: const BoxDecoration(
                      color: Octo.teal,
                      shape: BoxShape.circle,
                      boxShadow: [BoxShadow(color: Octo.teal, blurRadius: 7)],
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    _label,
                    style: const TextStyle(
                      fontFamily: Octo.mono,
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                      letterSpacing: .9,
                      color: Octo.teal,
                    ),
                  ),
                ],
              ),
            ),
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
        boxShadow: [BoxShadow(color: Octo.teal.withValues(alpha: .06), spreadRadius: 3)],
      ),
      clipBehavior: Clip.antiAlias,
      child: Image.asset(
        'assets/crew/xiyin-idle.png',
        fit: BoxFit.cover,
        alignment: const Alignment(0, -.88),
        errorBuilder: (_, _, _) => const Icon(Icons.person_outline, size: 18, color: Octo.teal),
      ),
    );
  }
}
