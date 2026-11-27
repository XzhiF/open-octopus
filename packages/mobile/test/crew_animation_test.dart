import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/widgets/crew_animation.dart';

/// 立绘从 VP9 alpha WebM 换成了带透明通道的 animated WebP ——
/// 这里盯住两件事：解码后 alpha 真的在（不是黑底），而且不止一帧。
void main() {
  testWidgets('立绘 WebP：透明通道保留、至少两帧', (tester) async {
    // 真解码要真实的事件循环，widget test 的假时钟里会挂住。
    await tester.runAsync(() async {
      final data = await rootBundle.load(kCrewClips.first.file);
      final buffer = await ui.ImmutableBuffer.fromUint8List(data.buffer.asUint8List());
      final descriptor = await ui.ImageDescriptor.encoded(buffer);
      final codec = await descriptor.instantiateCodec();

      expect(codec.frameCount, greaterThan(1), reason: '应该是多帧动画');

      final frame = await codec.getNextFrame();
      final image = frame.image;
      final raw = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      expect(raw, isNotNull);

      final w = image.width;
      final h = image.height;
      int alphaAt(int x, int y) => raw!.getUint8((y * w + x) * 4 + 3);

      // 画面四角是立绘外的留白：透明才说明 alpha 没被丢掉（否则就是一块黑底）。
      expect(alphaAt(2, 2), 0);
      expect(alphaAt(w - 3, 2), 0);
      expect(alphaAt(2, h - 3), 0);
      expect(alphaAt(w - 3, h - 3), 0);

      image.dispose();
      codec.dispose();
    });
  });

  testWidgets('立绘只有动画一种形态：关掉就整块不画，没有静态兜底图', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: CrewFigure(animated: false))),
    );
    expect(find.byType(Image), findsNothing);

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: CrewStage(height: 250, animated: false)),
      ),
    );
    // 连地面光晕一起收掉。
    expect(find.byType(Image), findsNothing);
  });

  testWidgets('立绘不带动作文字标签（待命 IDLE / 汐音 · … 都不画）', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: CrewStage(height: 250))),
    );
    expect(find.textContaining('汐音'), findsNothing);
    expect(find.textContaining('待命'), findsNothing);
    expect(find.textContaining('IDLE'), findsNothing);
  });

  testWidgets('主 chat 立绘：开时在面板后，关掉整块不画', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 390,
            height: 600,
            child: Stack(fit: StackFit.expand, children: [CrewBackdrop()]),
          ),
        ),
      ),
    );
    expect(find.byType(CrewFigure), findsOneWidget);

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 390,
            height: 600,
            child: Stack(
              fit: StackFit.expand,
              children: [CrewBackdrop(animated: false)],
            ),
          ),
        ),
      ),
    );
    expect(find.byType(CrewFigure), findsNothing);
    expect(find.byType(Image), findsNothing);
  });
}
