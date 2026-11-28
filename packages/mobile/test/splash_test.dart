import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/widgets/splash.dart';

void main() {
  testWidgets('启动页：先显示字标与副标题，hold 后淡出、把上层界面交出来', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: SplashGate(
          hold: Duration(milliseconds: 100),
          child: Scaffold(body: Text('应用本体')),
        ),
      ),
    );

    expect(find.text('OCTOPUS'), findsOneWidget);
    expect(find.text('汐音 · 作战舱'), findsOneWidget);

    // hold 到期 → 开始淡出（320ms）→ 移除
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('OCTOPUS'), findsNothing);
    expect(find.text('应用本体'), findsOneWidget);
  });

  testWidgets('启动页：系统「移除动画」打开时静态显示，不挂循环动画', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: true),
          child: SplashGate(
            hold: Duration(milliseconds: 100),
            child: Scaffold(body: Text('应用本体')),
          ),
        ),
      ),
    );

    expect(find.text('OCTOPUS'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('OCTOPUS'), findsNothing);
  });
}
