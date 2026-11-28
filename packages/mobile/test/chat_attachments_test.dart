import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/api.dart';
import 'package:octopus_mobile/features/chat/chat_attachments.dart';

void main() {
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          SystemChannels.platform,
          (call) async => null,
        );
  });

  testWidgets('文件 chip 显示文件名与扩展名，⧉ 只复制文件名', (tester) async {
    final api = OctopusApi('http://127.0.0.1:1');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Padding(
            padding: const EdgeInsets.all(12),
            child: ChatAttachments(
              text: '验收表在 `/tmp/acceptance-plan-r2.json`。',
              api: api,
              sessionId: 's1',
            ),
          ),
        ),
      ),
    );

    expect(find.text('acceptance-plan-r2.json'), findsOneWidget);
    expect(find.text('json'), findsOneWidget);

    await tester.tap(find.text('⧉'));
    await tester.pumpAndSettle();

    expect(find.byType(SnackBar), findsOneWidget);
    expect(
      find.textContaining('已复制 · acceptance-plan-r2.json'),
      findsOneWidget,
    );
  });

  testWidgets('没有产物路径时不占位', (tester) async {
    final api = OctopusApi('http://127.0.0.1:1');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ChatAttachments(text: '清完了，没有生成文件。', api: api, sessionId: 's1'),
        ),
      ),
    );
    expect(find.byType(ChatAttachments), findsOneWidget);
    expect(find.text('▤'), findsNothing);
  });
}
