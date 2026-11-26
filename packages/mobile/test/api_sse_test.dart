import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/http.dart';
import 'package:octopus_mobile/core/models/cabin.dart';
import 'package:octopus_mobile/core/models/quote.dart';

import 'support/fake_api.dart';

const _askAttention = {
  'attention': [
    {
      'id': 'ask-ask-1',
      'stage': 'answer',
      'awaiting': 'person',
      'title': 'phase-2 清理 · 待回答',
      'question': 'spec 和验收清单里的 phase 2 引用，一起清掉吗？',
      'task_id': 't1',
      'repo': 'xzf',
      'subject': {'kind': 'task', 'id': 't1'},
      'handle': '#1',
      'deep_link': 'ask:ask-1',
      'ask': {
        'ask_id': 'ask-1',
        'message_id': 'm-mirror',
        'author_session_id': 's-author',
        'decision': 'spec 和验收清单里的 phase 2 引用，一起清掉吗？',
        'phase': {'index': 2, 'round': 2},
        'options': [
          {'label': '一起清', 'impact': '3 天'},
        ],
      },
    },
    // 同票据的重复行（作者线程 + 镜像卡）：界面只留一条。
    {
      'id': 'ask-ask-1-dup',
      'stage': 'answer',
      'awaiting': 'person',
      'title': 'phase-2 清理 · 待回答',
      'ask': {'ask_id': 'ask-1', 'message_id': 'm-author'},
    },
    {
      'id': 'review-t2',
      'stage': 'review',
      'awaiting': 'person',
      'title': '首页改版 · 待验收',
      'task_id': 't2',
      'subject': {'kind': 'task', 'id': 't2'},
    },
  ],
  'health': {'running': 1, 'queued': 0, 'dormant': 0, 'workers': 1, 'max': 3},
};

void main() {
  test('attention：ask 信封解析 + 同票据去重 + 排序', () async {
    final api = apiFor(FakeHttpAdapter((options) => jsonBody(_askAttention)));
    final detail = await api.attention('c1');

    expect(detail.attention, hasLength(3));
    final list = detail.attentionList;
    expect(list.map((e) => e.id), ['ask-ask-1', 'review-t2']);

    final quote = SessionQuote.fromAttention(list.first);
    expect(quote.question, 'spec 和验收清单里的 phase 2 引用，一起清掉吗？');
    expect(quote.sourceLine, '任务 · #1 · xzf · P2 · 第 2 轮');
    expect(quote.messageId, 'm-mirror');
    expect(quote.stage, AttentionStage.answer);

    expect(detail.waitCount, 1);
    expect(detail.reviewCount, 1);
    expect(list.last.subjectName, '首页改版');
    expect(list.last.quoteText, '首页改版');
  });

  test('cabinEvents：跨 chunk 的 SSE 帧被正确拼回', () async {
    final api = apiFor(FakeHttpAdapter((options) => sseBody([
          // 故意切在帧中间：心跳 + cabin_view 各一条。
          'event: heartbeat\ndata: {"ts":"2026-11-26T11:00:00Z","hello":true}\n\n' 'event: cabin_vi',
          'ew\ndata: {"cabin_id":"c1"}\n\n',
        ])));

    final events = await api.cabinEvents('c1').take(2).toList();
    expect(events.map((e) => e.event), ['heartbeat', 'cabin_view']);
    expect(events.first.json?['hello'], true);
    expect(events.last.json?['cabin_id'], 'c1');
  });

  test('session 快照：镜像卡之前同一轮的工具数 = 依据条数', () async {
    final api = apiFor(FakeHttpAdapter((options) => jsonBody({
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
        })));

    final session = await api.session('ws1', 's-main');
    expect(session.displayTitle, '舱主对话');
    expect(session.messages, hasLength(5));
    expect(countEvidence(session.messages, 'm-mirror'), 2);
    expect(countEvidence(session.messages, 'not-loaded'), isNull);
  });

  test('非 200 的 JSON 错误被归一成 ApiException', () async {
    final api = apiFor(FakeHttpAdapter((options) => ResponseBody.fromString(
          jsonEncode({'error': '舱不存在'}),
          404,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        )));

    await expectLater(
      api.cabin('missing'),
      throwsA(
        isA<ApiException>()
            .having((e) => e.statusCode, 'statusCode', 404)
            .having((e) => e.message, 'message', '舱不存在'),
      ),
    );
  });
}
