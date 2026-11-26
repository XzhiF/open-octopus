import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:octopus_mobile/app/theme.dart';
import 'package:octopus_mobile/core/models/quote.dart';
import 'package:octopus_mobile/core/providers.dart';
import 'package:octopus_mobile/core/storage.dart';
import 'package:octopus_mobile/features/cabins/cabin_screen.dart';
import 'package:octopus_mobile/features/chat/session_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_api.dart';

const _askAttentionJson = {
  'id': 'ask-ask-1',
  'stage': 'answer',
  'awaiting': 'person',
  'title': 'phase-2 清理 · 待回答',
  'question': 'spec 和验收清单里的 phase 2 引用，一起清掉吗？',
  'task_id': 't1',
  'repo': 'xzf',
  'subject': {'kind': 'task', 'id': 't1'},
  'handle': '#1',
  'ask': {
    'ask_id': 'ask-1',
    'message_id': 'm-mirror',
    'decision': 'spec 和验收清单里的 phase 2 引用，一起清掉吗？',
    'phase': {'index': 2, 'round': 2},
  },
};

const _healthJson = {'running': 0, 'queued': 0, 'dormant': 0, 'workers': 0, 'max': 3};

const _sessionJson = {
  'id': 's-main',
  'workspaceId': 'ws1',
  'title': '舱主对话',
  'createdAt': '2026-11-26T10:00:00Z',
  'updatedAt': '2026-11-26T10:05:00Z',
  'totalMessageCount': 4,
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
  ],
};

/// 一台假机器：舱快照会随 attention 变化，事件流可手动推 `cabin_view`。
class _FakeServer {
  _FakeServer({List<Map<String, Object?>>? attention, List<Map<String, Object?>>? sessions})
      : attention = attention ?? [_askAttentionJson],
        sessions = sessions ??
            [
              {'id': 's-main', 'workspaceId': 'ws1', 'title': '舱主对话', 'updatedAt': '2026-11-26T10:05:00Z'},
            ];

  List<Map<String, Object?>> attention;
  List<Map<String, Object?>> sessions;
  int detailCalls = 0;
  int attentionCalls = 0;

  late final StreamController<Uint8List> _events = StreamController<Uint8List>(
    onCancel: () {
      if (!_events.isClosed) _events.close();
    },
  );

  HttpClientAdapter adapter() => FakeHttpAdapter((options) {
        final path = options.path;
        if (path == '/api/cabins/c1/events') {
          return ResponseBody(
            _events.stream,
            200,
            headers: {
              Headers.contentTypeHeader: ['text/event-stream'],
            },
          );
        }
        if (path == '/api/cabins/c1') {
          detailCalls++;
          return jsonBody({
            'cabin': {
              'id': 'c1',
              'name': '测试舱',
              'path': r'C:\xzf\cabin-c1',
              'workspace_id': 'ws1',
              'main_session_id': 's-main',
              'status': 'active',
            },
            'view': {
              'attention': attention,
              'health': _healthJson,
              'open_findings': 0,
            },
          });
        }
        if (path == '/api/cabins/c1/attention') {
          attentionCalls++;
          return jsonBody({'attention': attention, 'health': _healthJson});
        }
        if (path.startsWith('/api/workspaces/ws1/chat/sessions')) {
          if (path.endsWith('/s-main')) return jsonBody(_sessionJson);
          return jsonBody(sessions);
        }
        if (path == '/api/tasks') return jsonBody({'items': <Object>[]});
        return jsonBody({});
      });

  void pushCabinView() {
    _events.add(Uint8List.fromList(
      utf8.encode('event: cabin_view\ndata: {"cabin_id":"c1"}\n\n'),
    ));
  }
}

Future<GoRouter> _pumpCabin(WidgetTester tester, _FakeServer server) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();

  final router = GoRouter(
    initialLocation: '/cabin/c1',
    routes: [
      GoRoute(
        path: '/cabin/:cabinId',
        builder: (context, state) =>
            CabinScreen(cabinId: state.pathParameters['cabinId'] ?? ''),
      ),
      GoRoute(
        path: '/session/:workspaceId/:sessionId',
        builder: (context, state) => SessionScreen(
          workspaceId: state.pathParameters['workspaceId'],
          sessionId: state.pathParameters['sessionId'] ?? '',
          quote: state.extra is SessionQuote ? state.extra! as SessionQuote : null,
        ),
      ),
    ],
  );

  await tester.pumpWidget(ProviderScope(
    overrides: [
      storeProvider.overrideWithValue(Store(prefs)),
      apiProvider.overrideWithValue(apiFor(server.adapter())),
    ],
    child: MaterialApp.router(theme: buildOctoTheme(), routerConfig: router),
  ));

  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  return router;
}

Future<void> _unmount(WidgetTester tester, GoRouter router) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
  router.dispose();
}

void main() {
  testWidgets('待你定 → 点开 → 主会话挂上同一问的引用条', (tester) async {
    final server = _FakeServer();
    final router = await _pumpCabin(tester, server);

    // 列表：主体名 + 来源行 + 那一问。
    expect(find.text('测试舱'), findsOneWidget);
    expect(find.text('phase-2 清理'), findsOneWidget);
    expect(find.textContaining('任务 · #1 · xzf · P2 · 第 2 轮', findRichText: true), findsOneWidget);
    expect(find.textContaining('一起清掉吗？'), findsWidgets);

    // 点开 → 进主会话（路由 extra 带引用）。
    await tester.tap(find.text('去会话里说 ›'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }

    expect(find.text('正在回复'), findsOneWidget);
    expect(find.textContaining('依据 2 条', findRichText: true), findsOneWidget);
    expect(find.text('回复上面这个问题…'), findsOneWidget);

    await _unmount(tester, router);
  });

  testWidgets('cabin_view 事件 → 去抖后重拉快照，待你定清空', (tester) async {
    final server = _FakeServer();
    final router = await _pumpCabin(tester, server);

    expect(find.text('phase-2 清理'), findsOneWidget);
    expect(server.detailCalls, 1);

    // 服务端把这问答掉了，推一条 cabin_view。
    server.attention = [];
    server.pushCabinView();
    await tester.pump(const Duration(milliseconds: 600)); // 去抖 450ms
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }

    expect(server.detailCalls, greaterThan(1));
    expect(find.text('phase-2 清理'), findsNothing);
    expect(find.text('这儿没有等你的事'), findsOneWidget);

    await _unmount(tester, router);
  });

  testWidgets('一条会话都没有时不硬闯：提示并给「去会话页」口子', (tester) async {
    final server = _FakeServer(sessions: []);
    final router = await _pumpCabin(tester, server);

    await tester.tap(find.text('去会话里说 ›'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('这个舱还没有会话 —— 建一个，说第一句话'), findsOneWidget);
    expect(find.text('正在回复'), findsNothing);

    await tester.tap(find.text('去会话页'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('还没有会话'), findsOneWidget);

    await _unmount(tester, router);
  });
}
