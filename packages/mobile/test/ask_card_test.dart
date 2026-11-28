import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/ask_question.dart';
import 'package:octopus_mobile/features/chat/ask_card.dart';

const _questions = [
  AskQuestion(
    header: '删除范围',
    question: 'phase 2 删掉后，引用怎么处理？',
    options: [
      AskOption(label: '一起清掉', description: 'spec + 验收清单全删'),
      AskOption(label: '只删 spec', description: '验收清单下一轮再收'),
      AskOption(label: '其他', description: '自己写一句'),
    ],
  ),
  AskQuestion(
    header: '留档',
    question: '要留哪些档？',
    multiSelect: true,
    options: [
      AskOption(label: 'diff 摘要'),
      AskOption(label: '证据截图'),
      AskOption(label: '测试日志'),
    ],
  ),
];

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(
    backgroundColor: const Color(0xFF08060F),
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(12),
      child: SizedBox(width: 360, child: child),
    ),
  ),
);

void main() {
  testWidgets('所有问题平铺；没答完提交不可用，答完拼出桌面同款正文', (tester) async {
    String? sent;
    await tester.pumpWidget(
      _host(AskQuestionCard(questions: _questions, onAnswer: (v) => sent = v)),
    );

    // 两道题同时可见（平铺，不是分步）。
    expect(find.text('删除范围'), findsOneWidget);
    expect(find.text('留档'), findsOneWidget);
    expect(find.text('2 个问题 · 一次答完'), findsOneWidget);

    await tester.tap(find.text('一起清掉'));
    await tester.pump();
    expect(sent, isNull);

    await tester.tap(find.text('diff 摘要'));
    await tester.tap(find.text('证据截图'));
    await tester.pump();

    await tester.tap(find.text('提交回答'));
    await tester.pump();

    expect(sent, isNotNull);
    expect(sent, contains('1. [删除范围] phase 2 删掉后，引用怎么处理？'));
    expect(sent, contains('   → 一起清掉'));
    expect(sent, contains('   → diff 摘要, 证据截图'));
    // 提交后本地收成已答行。
    expect(find.text('已回答'), findsOneWidget);
  });

  testWidgets('「其他」选中后出输入框，文本参与作答', (tester) async {
    String? sent;
    await tester.pumpWidget(
      _host(AskQuestionCard(questions: _questions, onAnswer: (v) => sent = v)),
    );

    await tester.tap(find.text('其他'));
    await tester.pump();
    expect(find.byType(TextField), findsOneWidget);

    await tester.enterText(find.byType(TextField), '先只清三处');
    await tester.tap(find.text('diff 摘要'));
    await tester.pump();
    await tester.tap(find.text('提交回答'));
    await tester.pump();

    expect(sent, contains('→ 先只清三处'));
  });

  testWidgets('先讨论走同一条发送通道，内容不是作答', (tester) async {
    String? sent;
    await tester.pumpWidget(
      _host(AskQuestionCard(questions: _questions, onAnswer: (v) => sent = v)),
    );

    await tester.tap(find.text('先讨论'));
    await tester.pump();

    expect(sent, startsWith('用户想先讨论这些问题'));
    expect(find.text('已转讨论'), findsOneWidget);
  });

  testWidgets('历史里已答：默认收成一行，展开能回看题目', (tester) async {
    await tester.pumpWidget(
      _host(
        const AskQuestionCard(
          questions: _questions,
          answered: true,
          answeredSummary: '一起清掉；diff 摘要',
        ),
      ),
    );

    expect(find.text('已回答'), findsOneWidget);
    expect(find.text('一起清掉；diff 摘要'), findsOneWidget);
    expect(find.text('提交回答'), findsNothing);

    await tester.tap(find.text('展开 ›'));
    await tester.pump();
    expect(find.text('phase 2 删掉后，引用怎么处理？'), findsOneWidget);
  });
}
