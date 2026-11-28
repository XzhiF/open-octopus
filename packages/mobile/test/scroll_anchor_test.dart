import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/models/chat.dart';
import 'package:octopus_mobile/core/work_phrases.dart';
import 'package:octopus_mobile/widgets/tui.dart';

ChatMessage _row({
  required String id,
  required String role,
  required String displayType,
  required String content,
  String? sourceId,
  Map<String, dynamic>? extra,
}) => ChatMessage(
  id: id,
  sessionId: 's1',
  role: role,
  type: 'text',
  content: content,
  createdAt: '2026-11-28T10:00:00Z',
  meta: {
    'displayType': displayType,
    if (sourceId != null) 'sourceId': sourceId,
    ...?extra,
  },
);

void main() {
  testWidgets('运行态工作行：转字 + 计时，自己会走（钉在消息流外面）', (tester) async {
    final live = LiveTurn()
      ..started = true
      ..startedAt = DateTime.now()
      ..thinking = '先看 manifest';

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: WorkStatusLine(live: live)),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));

    expect(
      find.textContaining(RegExp('[${kWorkSpin.join()}]')),
      findsOneWidget,
    );
    expect(find.textContaining(RegExp(r'^\d+:\d{2}$')), findsOneWidget);

    // 工作行是自己一格的 widget：转录层里不再画它。
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: TuiTranscript(messages: const [], live: live),
          ),
        ),
      ),
    );
    expect(find.byType(WorkStatusLine), findsNothing);
    expect(find.textContaining(RegExp('[${kWorkSpin.join()}]')), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('摊开过程行：行头留在原地，并通知外层「别再自动贴底」', (tester) async {
    var detached = 0;
    var compensated = 0;
    final anchor = TuiScrollAnchor(
      onDetach: () => detached++,
      onProgrammaticScroll: (active) {
        if (active) compensated++;
      },
    );

    const thinking =
        '第一行：先核对 manifest 里的引用\n'
        '第二行：再看验收清单\n'
        '第三行：最后跑一遍 rg';
    final messages = [
      _row(id: 'u1', role: 'user', displayType: 'user', content: '一起清掉'),
      _row(
        id: 'a1-think',
        role: 'assistant',
        displayType: 'thinking',
        content: thinking,
        sourceId: 'a1',
        extra: {'thinkingContent': thinking},
      ),
      _row(
        id: 'a1-tool',
        role: 'assistant',
        displayType: 'tool_call',
        content: '',
        sourceId: 'a1',
        extra: {
          'toolName': 'Edit',
          'toolInput': '{"file_path":"spec/phase-1.md"}',
          'toolStatus': 'done',
        },
      ),
      _row(
        id: 'a1',
        role: 'assistant',
        displayType: 'text',
        content: '清完了。',
        sourceId: 'a1',
      ),
    ];

    final controller = ScrollController();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 360,
            child: SingleChildScrollView(
              controller: controller,
              child: Column(
                children: [
                  const SizedBox(height: 500),
                  TuiTranscript(messages: messages, anchor: anchor),
                  const SizedBox(height: 500),
                ],
              ),
            ),
          ),
        ),
      ),
    );

    // 停在回合中间（行头在视口里），像人正在看这一段。
    controller.jumpTo(520);
    await tester.pump();

    final head = find.textContaining('汐音', findRichText: true);
    final before = tester.getTopLeft(head).dy;
    await tester.tap(head);
    await tester.pump();
    await tester.pump();

    expect(detached, 1, reason: '用户自己摊开了：外层要脱离自动贴底');
    expect(find.textContaining('第一行：先核对'), findsOneWidget);
    expect(
      (tester.getTopLeft(head).dy - before).abs(),
      lessThan(1),
      reason: '摊开只往下长，行头不该带着整页往上窜',
    );
    // 行头没挪窝，就不需要补偿滚动。
    expect(compensated, 0);
    expect(controller.offset, 520);

    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
  });
}
