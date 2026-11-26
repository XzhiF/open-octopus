import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/app/theme.dart';
import 'package:octopus_mobile/core/models/cabin.dart';
import 'package:octopus_mobile/core/models/quote.dart';
import 'package:octopus_mobile/widgets/quote_bar.dart';

SessionQuote quote({AttentionStage stage = AttentionStage.answer}) => SessionQuote(
      attentionId: 'ask-1',
      stage: stage,
      question: 'spec 和验收清单里的 phase 2 引用，一起清掉吗？',
      sourceName: 'phase-2 产物清理',
      sourceLine: '任务 · #1 · P2 · 第 2 轮',
      messageId: 'm-1',
    );

Widget harness(Widget child) => MaterialApp(
      theme: buildOctoTheme(),
      home: Scaffold(backgroundColor: Octo.screen, body: child),
    );

Color? pillColor(WidgetTester tester, String label) =>
    tester.widget<Text>(find.text(label)).style?.color;

void main() {
  testWidgets('引用条渲染问题原文、来源与依据条数', (tester) async {
    await tester.pumpWidget(harness(QuoteBar(quote: quote(), evidenceCount: 2)));

    expect(find.text('正在回复'), findsOneWidget);
    expect(find.text('spec 和验收清单里的 phase 2 引用，一起清掉吗？'), findsOneWidget);
    expect(find.textContaining('P2 · 第 2 轮', findRichText: true), findsOneWidget);
    expect(find.textContaining('依据 2 条', findRichText: true), findsOneWidget);
    expect(find.text('待你定'), findsOneWidget);
  });

  testWidgets('依据条数未知 / 为 0 时不显示', (tester) async {
    await tester.pumpWidget(harness(QuoteBar(quote: quote(), evidenceCount: null)));
    expect(find.textContaining('依据', findRichText: true), findsNothing);

    await tester.pumpWidget(harness(QuoteBar(quote: quote(), evidenceCount: 0)));
    expect(find.textContaining('依据', findRichText: true), findsNothing);
  });

  testWidgets('关闭按钮在最左，点击回调', (tester) async {
    var closed = 0;
    await tester.pumpWidget(harness(QuoteBar(
      quote: quote(stage: AttentionStage.review),
      onClose: () => closed++,
    )));

    expect(find.text('待验收'), findsOneWidget);
    expect(find.byIcon(Icons.close), findsOneWidget);
    await tester.tap(find.byIcon(Icons.close));
    expect(closed, 1);
  });

  testWidgets('待你定用琥珀档，待验收用粉色档', (tester) async {
    await tester.pumpWidget(harness(QuoteBar(quote: quote())));
    expect(pillColor(tester, '待你定'), Octo.amber);

    await tester.pumpWidget(harness(QuoteBar(quote: quote(stage: AttentionStage.review))));
    expect(pillColor(tester, '待验收'), Octo.pink);
  });

  testWidgets('没有 onClose 时不画关闭按钮', (tester) async {
    await tester.pumpWidget(harness(QuoteBar(quote: quote())));
    expect(find.byIcon(Icons.close), findsNothing);
  });
}
