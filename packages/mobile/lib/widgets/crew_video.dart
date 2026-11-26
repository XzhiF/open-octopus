import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../app/theme.dart';

/// 全舱模式那 13 支立绘里随包先带 3 支（其余按需再放，控制安装包体积）。
class CrewClip {
  const CrewClip(this.file, this.label);

  final String file;
  final String label;
}

const kCrewClips = <CrewClip>[
  CrewClip('assets/clips/07-idle.webm', '待命 IDLE'),
  CrewClip('assets/clips/05-concerned.webm', '担忧 WORRIED'),
  CrewClip('assets/clips/09-smile.webm', '愉悦 SMILE'),
];

/// 立绘：一屏最多一支。点一下换下一支（同 v22 的交互）。
///
/// VP9 alpha 能否在真机上透明，是 M0 的 spike —— 所以视频路径由设置开关控制，
/// 默认走 [CrewPose] 静帧 + 径向遮罩（已知可看），真机验证通过后再把默认值翻过来。
class CrewFigure extends StatelessWidget {
  const CrewFigure({
    super.key,
    this.height = 250,
    this.videoEnabled = false,
    this.cycleOnTap = true,
    this.initialIndex = 0,
    this.alignment = Alignment.bottomRight,
  });

  final double height;
  final bool videoEnabled;
  final bool cycleOnTap;
  final int initialIndex;
  final Alignment alignment;

  @override
  Widget build(BuildContext context) {
    if (!videoEnabled) {
      return CrewPose(height: height, alignment: alignment);
    }
    return CrewVideo(
      height: height,
      cycleOnTap: cycleOnTap,
      initialIndex: initialIndex,
      alignment: alignment,
    );
  }
}

/// 静帧兜底：立绘 PNG + 径向遮罩（边缘淡出，贴在场景图上不显方框）。
class CrewPose extends StatelessWidget {
  const CrewPose({
    super.key,
    this.height = 250,
    this.alignment = Alignment.bottomRight,
    this.asset = 'assets/crew/xiyin-idle.png',
  });

  final double height;
  final Alignment alignment;
  final String asset;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: SizedBox(
        height: height,
        child: Align(
          alignment: alignment,
          child: ShaderMask(
            blendMode: BlendMode.dstIn,
            shaderCallback: (rect) => const RadialGradient(
              center: Alignment(0, .1),
              radius: .8,
              colors: [Colors.white, Colors.white, Colors.transparent],
              stops: [0, .66, 1],
            ).createShader(rect),
            child: Image.asset(
              asset,
              height: height,
              fit: BoxFit.contain,
              alignment: Alignment.bottomCenter,
              errorBuilder: (_, __, ___) => const SizedBox.shrink(),
            ),
          ),
        ),
      ),
    );
  }
}

/// 立绘视频（VP9 alpha WebM）。解码失败 / 平台不支持 alpha 时退回静帧。
class CrewVideo extends StatefulWidget {
  const CrewVideo({
    super.key,
    this.height = 250,
    this.cycleOnTap = true,
    this.initialIndex = 0,
    this.alignment = Alignment.bottomRight,
    this.onClipChanged,
  });

  final double height;
  final bool cycleOnTap;
  final int initialIndex;
  final Alignment alignment;
  final ValueChanged<CrewClip>? onClipChanged;

  @override
  State<CrewVideo> createState() => _CrewVideoState();
}

class _CrewVideoState extends State<CrewVideo> with WidgetsBindingObserver {
  VideoPlayerController? _controller;
  int _index = 0;
  bool _failed = false;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _index = widget.initialIndex.clamp(0, kCrewClips.length - 1);
    _load(_index);
  }

  Future<void> _load(int index) async {
    final old = _controller;
    _controller = null;
    await old?.dispose();

    final controller = VideoPlayerController.asset(kCrewClips[index].file);
    _controller = controller;
    try {
      await controller.initialize();
      await controller.setLooping(true);
      await controller.setVolume(0);
      await controller.play();
      if (!mounted) return;
      setState(() {
        _ready = true;
        _failed = false;
      });
      widget.onClipChanged?.call(kCrewClips[index]);
    } catch (_) {
      if (!mounted) return;
      setState(() => _failed = true);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final c = _controller;
    if (c == null) return;
    if (state == AppLifecycleState.resumed) {
      c.play().catchError((_) {});
    } else {
      c.pause();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller?.dispose();
    super.dispose();
  }

  void _next() {
    if (!widget.cycleOnTap) return;
    _index = (_index + 1) % kCrewClips.length;
    setState(() => _ready = false);
    _load(_index);
  }

  @override
  Widget build(BuildContext context) {
    if (_failed) return CrewPose(height: widget.height, alignment: widget.alignment);
    final controller = _controller;
    return GestureDetector(
      onTap: _next,
      child: SizedBox(
        height: widget.height,
        child: Align(
          alignment: widget.alignment,
          child: controller == null || !_ready || !controller.value.isInitialized
              ? CrewPose(height: widget.height, alignment: widget.alignment)
              : AspectRatio(
                  aspectRatio: 2 / 3,
                  child: VideoPlayer(controller),
                ),
        ),
      ),
    );
  }
}

/// 右下角站立位 + 地面光晕 + 动作标签（原型 `.stage`）。
class CrewStage extends StatelessWidget {
  const CrewStage({
    super.key,
    required this.height,
    this.videoEnabled = false,
    this.label = '汐音 · 待命 IDLE',
  });

  final double height;
  final bool videoEnabled;
  final String label;

  @override
  Widget build(BuildContext context) {
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
              height: height,
              videoEnabled: videoEnabled,
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
                    '汐音 · $label',
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
        errorBuilder: (_, __, ___) => const Icon(Icons.person_outline, size: 18, color: Octo.teal),
      ),
    );
  }
}
