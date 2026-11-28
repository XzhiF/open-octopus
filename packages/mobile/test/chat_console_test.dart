import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/models/chat.dart';
import 'package:octopus_mobile/core/models/telemetry.dart';
import 'package:octopus_mobile/core/ask_question.dart';
import 'package:octopus_mobile/core/work_phrases.dart';
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
  testWidgets('回合结束把 think / 工具收进行头；点行头按顺序摊开', (tester) async {
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
          'toolResult': 'done',
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
          body: SingleChildScrollView(
            child: TuiTranscript(
              messages: messages,
              turnStats: const {'a1': stats},
            ),
          ),
        ),
      ),
    );

    // 摘要头：时长 / 步数 / 工具 / tok / 费用都在一行里。
    expect(find.textContaining('汐音', findRichText: true), findsOneWidget);
    expect(find.textContaining('已完成', findRichText: true), findsOneWidget);
    expect(find.textContaining('9s', findRichText: true), findsOneWidget);
    expect(find.textContaining('3 步', findRichText: true), findsOneWidget);
    expect(find.textContaining('工具 1', findRichText: true), findsOneWidget);
    expect(find.textContaining('1.2K tok', findRichText: true), findsOneWidget);
    expect(find.textContaining('¥0.06', findRichText: true), findsOneWidget);

    // 正文直接露出；think / 工具一起收进行头，不铺在正文上面。
    expect(find.textContaining('清完了'), findsOneWidget);
    expect(find.textContaining('第一行：先核对'), findsNothing);
    expect(find.textContaining('最后跑一遍 rg'), findsNothing);
    expect(find.textContaining('Edit'), findsNothing);

    // 点行头展开 = 按落库顺序列出思考全文 + 工具行。
    await tester.tap(find.textContaining('汐音', findRichText: true));
    await tester.pump();

    expect(find.textContaining('第一行：先核对'), findsOneWidget);
    expect(find.textContaining('最后跑一遍 rg'), findsOneWidget);
    expect(find.textContaining('Edit'), findsOneWidget);
    expect(find.textContaining('✓ 完成'), findsOneWidget);

    // 单条工具再点开 = input / result 原文小票。
    expect(find.textContaining('▸ input'), findsNothing);
    await tester.tap(find.textContaining('Edit'));
    await tester.pump();
    expect(find.textContaining('▸ input'), findsOneWidget);
    expect(find.textContaining('spec/phase-1.md'), findsWidgets);
  });

  testWidgets('运行中：工作行转字 + 计时，思考两行，工具逐条打勾', (tester) async {
    final live = LiveTurn()
      ..started = true
      ..startedAt = DateTime.now()
      ..thinking = '先看 manifest\n再核对引用\n最后跑测试'
      ..text = '正在改…';
    live.tools.add(
      LiveTool(
        id: 't1',
        name: 'Read',
        inputText: '{"file_path":"acceptance-plan-r2.json"}',
        status: 'done',
      ),
    );
    live.tools.add(
      LiveTool(
        id: 't2',
        name: 'Edit',
        inputText: '{"file_path":"phase-1-spec.md"}',
        status: 'running',
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: TuiTranscript(messages: const [], live: live),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));

    // 行头：进行中（不是「已完成」）。
    expect(find.textContaining('进行中', findRichText: true), findsOneWidget);
    // 工作行：盲文转字 + 计时（0:00）。
    expect(
      find.textContaining(RegExp('[${kWorkSpin.join()}]')),
      findsOneWidget,
    );
    expect(find.text('0:00'), findsOneWidget);
    // 思考只露最后两行。
    expect(find.textContaining('◌ thinking'), findsOneWidget);
    expect(find.textContaining('最后跑测试'), findsOneWidget);
    expect(find.textContaining('先看 manifest'), findsNothing);
    // 工具：完成的打勾，在跑的写「运行中…」。
    expect(find.textContaining('✓ 完成'), findsOneWidget);
    expect(find.textContaining('运行中…'), findsOneWidget);

    // 出结果的那一刻：think / 工具一起收进行头，不再铺在下面。
    live.done = true;
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.textContaining('已完成', findRichText: true), findsOneWidget);
    expect(find.textContaining('最后跑测试'), findsNothing);
    expect(find.textContaining('✓ 完成'), findsNothing);
    expect(find.textContaining('运行中…'), findsNothing);

    // 手动收掉，免得 ticker / timer 留在测试里。
    await tester.pumpWidget(const SizedBox.shrink());
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
