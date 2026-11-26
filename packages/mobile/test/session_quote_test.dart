import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/app/theme.dart';
import 'package:octopus_mobile/core/models/cabin.dart';
import 'package:octopus_mobile/core/models/quote.dart';
import 'package:octopus_mobile/core/providers.dart';
import 'package:octopus_mobile/core/storage.dart';
import 'package:octopus_mobile/features/chat/session_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_api.dart';

const _session = {
  'id': 's-main',
  'workspaceId': 'ws1',
  'title': '舱主对话',
  'createdAt': '2026-11-26T10:00:00Z',
  'updatedAt': '2026-11-26T10:05:00Z',
  'totalMessageCount': 5,
  'messages': [
    {'id': 'u0', 'role': 'user', 'type': 'text', 'content': '看看 phase 2'},
    {
      'id': 'm-tool-1',
      'role': 'assistant',
      'type': 'tool_call',
      'content': '',
      'metadata': '{"displayType":"tool_call","toolName":"Read","toolStatus":"done"}',
    },
    {
      'id': 'm-tool-2',
      'role': 'assistant',
      'type': 'tool_call',
      'content': '',
      'metadata': '{"displayType":"tool_call","toolName":"Grep","toolStatus":"done"}',
    },
    {'id': 'm-mirror', 'role': 'user', 'type': 'text', 'content': 'phase 2 引用一起清掉吗？'},
    {'id': 'u1', 'role': 'user', 'type': 'text', 'content': '先别动'},
  ],
};

SessionQuote _quote() => const SessionQuote(
      attentionId: 'ask-ask-1',
      stage: AttentionStage.answer,
      question: 'spec 和验收清单里的 phase 2 引用，一起清掉吗？',
      sourceName: 'phase-2 产物清理',
      sourceLine: '任务 · #1 · P2 · 第 2 轮',
      messageId: 'm-mirror',
    );

Future<void> _pumpSession(WidgetTester tester, {SessionQuote? quote}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final api = apiFor(FakeHttpAdapter((options) => jsonBody(_session)));

  await tester.pumpWidget(ProviderScope(
    overrides: [
      storeProvider.overrideWithValue(Store(prefs)),
      apiProvider.overrideWithValue(api),
    ],
    child: MaterialApp(
      theme: buildOctoTheme(),
      home: SessionScreen(
        workspaceId: 'ws1',
        sessionId: 's-main',
        quote: quote,
      ),
    ),
  ));

  // 让快照请求落地 + 首帧渲染（场景层一直在动，不能用 pumpAndSettle）。
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

void main() {
  testWidgets('带引用进会话：引用条 + placeholder 切换 + 依据条数', (tester) async {
    await _pumpSession(tester, quote: _quote());

    expect(find.text('QUOTE'), findsOneWidget);
    expect(find.text('回复'), findsOneWidget);
    expect(find.text('正在回复'), findsOneWidget);
    expect(find.text('spec 和验收清单里的 phase 2 引用，一起清掉吗？'), findsOneWidget);
    expect(find.textContaining('依据 2 条', findRichText: true), findsOneWidget);
    expect(find.text('回复上面这个问题…'), findsOneWidget);
    expect(find.text('说清楚就行：清掉 / 先别动 / 只删 spec 不动验收清单'), findsOneWidget);

    // 会话内容本身照常渲染（TUI 语法不因引用而变）。
    expect(find.textContaining('看看 phase 2', findRichText: true), findsWidgets);

    await _unmount(tester);
  });

  testWidgets('关掉引用条：问题消失，placeholder 回到默认', (tester) async {
    await _pumpSession(tester, quote: _quote());

    await tester.tap(find.byIcon(Icons.close));
    await tester.pump();

    expect(find.text('正在回复'), findsNothing);
    expect(find.text('回复上面这个问题…'), findsNothing);
    expect(find.text('说点什么…'), findsOneWidget);
    expect(find.text('CHAT'), findsOneWidget);
    expect(find.text('舱主对话'), findsOneWidget);

    await _unmount(tester);
  });

  testWidgets('没有引用时：不画引用条、placeholder 是默认话术', (tester) async {
    await _pumpSession(tester);

    expect(find.text('正在回复'), findsNothing);
    expect(find.text('说点什么…'), findsOneWidget);
    expect(find.text('CHAT'), findsOneWidget);

    await _unmount(tester);
  });
}
