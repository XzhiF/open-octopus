import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/models/chat.dart';
import 'package:octopus_mobile/widgets/tui.dart';

ChatMessage _msg({
  required String role,
  required String content,
  Map<String, dynamic>? meta,
}) =>
    ChatMessage(
      id: 'm1',
      sessionId: 's1',
      role: role,
      type: 'text',
      content: content,
      createdAt: '2026-11-27T10:00:00Z',
      meta: meta,
    );

void main() {
  testWidgets('系统行不挂汐音头：单独一条暗行', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TuiTranscript(messages: [
          _msg(role: 'system', content: '「测试舱」已就绪', meta: const {'displayType': 'system'}),
        ]),
      ),
    ));

    expect(find.textContaining('已就绪'), findsOneWidget);
    expect(find.textContaining('汐音'), findsNothing);
  });

  testWidgets('assistant 正文仍然挂汐音头', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TuiTranscript(messages: [
          _msg(role: 'assistant', content: '好', meta: const {'displayType': 'text'}),
        ]),
      ),
    ));

    expect(find.textContaining('汐音', findRichText: true), findsOneWidget);
    expect(find.textContaining('好', findRichText: true), findsWidgets);
  });
}
