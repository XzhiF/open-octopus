import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/models/chat.dart';
import 'package:octopus_mobile/core/models/telemetry.dart';
import 'package:octopus_mobile/core/ask_question.dart';
import 'package:octopus_mobile/features/chat/ask_card.dart';
import 'package:octopus_mobile/features/chat/console_bar.dart';
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
  createdAt: '2026-11-27T10:00:00Z',
  meta: {
    'displayType': displayType,
    if (sourceId != null) 'sourceId': sourceId,
    ...?extra,
  },
);

void main() {
  testWidgets('assistant 的 think / 工具默认折成一行摘要，点开才看步骤', (tester) async {
    final messages = [
      _row(id: 'u1', role: 'user', displayType: 'user', content: '一起清掉'),
      _row(
        id: 'a1-think',
        role: 'assistant',
        displayType: 'thinking',
        content: '先核对 manifest 里的引用',
        sourceId: 'a1',
        extra: {'thinkingContent': '先核对 manifest 里的引用'},
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
    const stats = TurnStats(
      durationMs: 9000,
      calls: 2,
      usage: TokenUsage(
        inputTokens: 900,
        outputTokens: 300,
        cacheReadTokens: 0,
      ),
      costUsd: .008,
      costComplete: true,
      models: ['pro'],
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TuiTranscript(
            messages: messages,
            turnStats: const {'a1': stats},
          ),
        ),
      ),
    );

    // 摘要头：时长 / 步数 / 工具 / tok / 费用都在一行里。
    expect(find.textContaining('汐音', findRichText: true), findsOneWidget);
    expect(find.textContaining('已完成', findRichText: true), findsOneWidget);
    expect(find.textContaining('9s', findRichText: true), findsOneWidget);
    expect(find.textContaining('3\u00A0步', findRichText: true), findsOneWidget);
    expect(
      find.textContaining('工具\u00A01', findRichText: true),
      findsOneWidget,
    );
    expect(
      find.textContaining('1.2K\u00A0tok', findRichText: true),
      findsOneWidget,
    );
    expect(find.textContaining('¥0.06', findRichText: true), findsOneWidget);

    // 正文直接露出；过程默认折叠。
    expect(find.textContaining('清完了'), findsOneWidget);
    expect(find.textContaining('先核对 manifest'), findsNothing);
    expect(find.textContaining('spec/phase-1.md'), findsNothing);

    // 点摘要头展开过程。
    await tester.tap(find.textContaining('汐音', findRichText: true));
    await tester.pump();

    expect(find.textContaining('先核对 manifest'), findsOneWidget);
    expect(find.textContaining('spec/phase-1.md'), findsOneWidget);
  });

  testWidgets('AskUserQuestion 直接长成提问卡；答过之后收成一行', (tester) async {
    final ask = _row(
      id: 'a1-ask',
      role: 'assistant',
      displayType: 'ask_user_question',
      content: '动手前先定一件事：',
      sourceId: 'a1',
      extra: {
        'questions': [
          {
            'header': '删除范围',
            'question': 'phase 2 删掉后，引用怎么处理？',
            'multiSelect': false,
            'options': [
              {'label': '一起清掉', 'description': '全删'},
              {'label': '先别动', 'description': '等决定'},
            ],
          },
        ],
      },
    );
    final answer = _row(
      id: 'u2',
      role: 'user',
      displayType: 'user',
      content: '用户回答了以下问题：\n\n1. [删除范围] …\n   → 一起清掉',
    );

    Widget host(List<ChatMessage> messages) => MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(12),
          child: TuiTranscript(messages: messages),
        ),
      ),
    );

    expect(parseAskQuestions(ask.questions), hasLength(1));
    await tester.pumpWidget(host([ask]));
    expect(find.byType(AskQuestionCard), findsOneWidget);
    expect(find.textContaining('动手前先定一件事'), findsOneWidget);
    expect(find.text('phase 2 删掉后，引用怎么处理？'), findsOneWidget);
    expect(find.text('一起清掉'), findsOneWidget);
    expect(find.text('提交回答'), findsOneWidget);

    await tester.pumpWidget(host([ask, answer]));
    await tester.pump();
    expect(find.text('已回答'), findsOneWidget);
    expect(find.text('提交回答'), findsNothing);
    // 回答正文压成一行，不铺结构化块。
    expect(find.textContaining('已回答 · 一起清掉'), findsOneWidget);
  });

  testWidgets('通讯台头显示 model / ctx / tok / 轮次，芯片可点', (tester) async {
    var ctxTap = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ConsoleBar(
            model: 'pro',
            contextUsage: const ContextUsage(
              totalTokens: 6200,
              maxTokens: 100000,
              rawMaxTokens: 100000,
              percentage: 6.2,
            ),
            usage: const SessionUsage(
              totalCalls: 3,
              usage: TokenUsage(inputTokens: 900, outputTokens: 300),
            ),
            turns: 12,
            onCtxTap: () => ctxTap++,
          ),
        ),
      ),
    );

    expect(find.text('pro'), findsOneWidget);
    expect(find.text('6.2%'), findsOneWidget);
    expect(find.text('1.2K'), findsOneWidget);
    expect(find.text('≡ 12轮'), findsOneWidget);

    await tester.tap(find.text('6.2%'));
    expect(ctxTap, 1);
  });
}
