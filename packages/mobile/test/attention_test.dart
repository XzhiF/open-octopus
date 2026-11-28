import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/models/cabin.dart';
import 'package:octopus_mobile/core/models/chat.dart';
import 'package:octopus_mobile/core/models/quote.dart';

AttentionItem item({
  required String id,
  required String stage,
  String title = '任务甲 · 待回答',
  String? question,
  String? detail,
  String? awaiting = 'person',
  String? subjectKind,
  String? handle,
  String? repo,
  Map<String, dynamic>? ask,
}) =>
    AttentionItem.fromJson({
      'id': id,
      'stage': stage,
      'title': title,
      'awaiting': awaiting,
      'question': question,
      'detail': detail,
      'subject': subjectKind == null ? null : {'kind': subjectKind, 'id': 'subject-1'},
      'handle': handle,
      'repo': repo,
      'ask': ask,
    });

ChatMessage msg(String id, {bool user = false, String type = 'text'}) => ChatMessage(
      id: id,
      sessionId: 's',
      role: user ? 'user' : 'assistant',
      type: type,
      content: '',
      createdAt: '',
    );

void main() {
  group('AttentionItem 信封', () {
    test('解析 ask：decision / phase / message_id / 来源行', () {
      final a = item(
        id: 'ask-1',
        stage: 'answer',
        title: 'phase-2 清理 · 待回答',
        question: '原问题',
        subjectKind: 'task',
        handle: '#1',
        repo: 'xzf',
        ask: {
          'ask_id': 'ask-1',
          'message_id': 'm-1',
          'author_session_id': 's-1',
          'decision': 'spec 和验收清单里的 phase 2 引用，一起清掉吗？',
          'phase': {'index': 2, 'round': 2},
          'options': [
            {'label': '一起清', 'impact': '3 天'},
          ],
        },
      );
      expect(a.ask?.askId, 'ask-1');
      expect(a.ask?.messageId, 'm-1');
      expect(a.ask?.phase.index, 2);
      expect(a.ask?.options.single.impact, '3 天');
      expect(a.phaseLabel, 'P2 · 第 2 轮');
      expect(a.sourceLine, '任务 · #1 · xzf · P2 · 第 2 轮');
      expect(a.quoteText, 'spec 和验收清单里的 phase 2 引用，一起清掉吗？');
      expect(a.subjectName, 'phase-2 清理');
      expect(a.dedupeKey, 'ask-1');
    });

    test('没有信封时按 question → detail → 标题回退', () {
      expect(
        item(id: 'a', stage: 'answer', title: '甲 · 待回答', question: '要不要删？').quoteText,
        '要不要删？',
      );
      expect(
        item(id: 'b', stage: 'start', title: '乙 · 待触发', detail: '已入列，等你触发执行').quoteText,
        '已入列，等你触发执行',
      );
      expect(item(id: 'c', stage: 'review', title: '丙 · 待验收').quoteText, '丙');
      expect(item(id: 'c', stage: 'review', title: '丙 · 待验收').sourceLine, '舱内');
      expect(item(id: 'd', stage: 'answer').dedupeKey, 'd');
    });

    test('phase 只有一轮 / 只有 index 时不拼多余分隔', () {
      final roundOnly = item(
        id: 'r',
        stage: 'answer',
        ask: {'ask_id': 'r', 'phase': {'round': 3}},
      );
      expect(roundOnly.phaseLabel, '第 3 轮');
      final indexOnly = item(
        id: 'i',
        stage: 'answer',
        ask: {'ask_id': 'i', 'phase': {'index': 1}},
      );
      expect(indexOnly.phaseLabel, 'P1');
      expect(item(id: 'n', stage: 'answer').phaseLabel, isNull);
    });
  });

  group('buildAttentionList', () {
    test('非 person 项不列', () {
      final list = buildAttentionList([
        item(id: 'a', stage: 'answer', awaiting: 'person'),
        item(id: 'b', stage: 'answer', awaiting: 'working'),
        item(id: 'c', stage: 'answer', awaiting: null),
      ]);
      expect(list.map((e) => e.id), ['a', 'c']);
    });

    test('同一票据只留第一条，同 id 去重', () {
      final list = buildAttentionList([
        item(id: 'x1', stage: 'answer', ask: {'ask_id': 'ticket-1'}),
        item(id: 'x2', stage: 'answer', ask: {'ask_id': 'ticket-1'}),
        item(id: 'x1', stage: 'blocked'),
        item(id: 'x3', stage: 'blocked'),
      ]);
      expect(list.map((e) => e.id), ['x1', 'x3']);
    });

    test('按 stage 排序，同档保持服务端顺序', () {
      final list = buildAttentionList([
        item(id: 'review1', stage: 'review'),
        item(id: 'start', stage: 'start'),
        item(id: 'answer1', stage: 'answer'),
        item(id: 'review2', stage: 'review'),
        item(id: 'blocked', stage: 'blocked'),
        item(id: 'approval', stage: 'approval'),
      ]);
      expect(
        list.map((e) => e.id),
        ['answer1', 'start', 'review1', 'review2', 'approval', 'blocked'],
      );
    });

    test('notice（已完成知会）不进待办 —— 与 PC inbox 一致', () {
      final list = buildAttentionList([
        item(id: 'done-task-1', stage: 'notice', title: '甲 · 已完成'),
        item(id: 'start', stage: 'start'),
      ]);
      expect(list.map((e) => e.id), ['start']);
    });
  });

  group('标题后缀', () {
    test('逐层剥掉（任务主线程 + 待回答）', () {
      expect(stripAttentionSuffix('app-user · 任务主线程 · 待回答'), 'app-user');
      expect(stripAttentionSuffix('甲 · 委派在问你'), '甲');
      expect(stripAttentionSuffix('乙 · 已完成'), '乙');
      expect(stripAttentionSuffix(' 丙 · 待验收 '), '丙');
      expect(stripAttentionSuffix('没后缀'), '没后缀');
    });
  });

  group('SessionQuote', () {
    test('从 attention 造引用：问题原文 + 来源 + message id', () {
      final q = SessionQuote.fromAttention(item(
        id: 'ask-1',
        stage: 'answer',
        title: '甲 · 待回答',
        question: '原问题',
        subjectKind: 'delegation',
        handle: 'D1',
        ask: {'ask_id': 'ask-1', 'message_id': 'm-9', 'decision': '要定的事'},
      ));
      expect(q.question, '要定的事');
      expect(q.sourceName, '甲');
      expect(q.sourceLine, '委派 · D1');
      expect(q.messageId, 'm-9');
      expect(q.stage, AttentionStage.answer);
    });

    test('依据条数：镜像卡之前同一轮的工具有几个；找不到就 null', () {
      final messages = [
        msg('u0', user: true),
        msg('t1', type: 'tool_call'),
        msg('t2', type: 'tool_call'),
        msg('m-9', user: true),
        msg('u1', user: true),
        msg('t3', type: 'tool_call'),
        msg('mirror', user: true),
      ];
      expect(countEvidence(messages, 'mirror'), 1);
      expect(countEvidence(messages, 'm-9'), 2);
      expect(countEvidence(messages, 'missing'), isNull);
      expect(countEvidence(messages, null), isNull);
      expect(countEvidence(messages, 'u0'), 0);
    });

    test('原生 AskUserQuestion 卡（assistant 行）也数同一轮工具', () {
      final messages = [
        msg('u0', user: true),
        msg('t1', type: 'tool_call'),
        msg('ask', type: 'ask_user_question'),
      ];
      expect(countEvidence(messages, 'ask'), 1);
    });
  });
}
