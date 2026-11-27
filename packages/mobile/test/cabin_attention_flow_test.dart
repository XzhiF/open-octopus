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
import 'package:octopus_mobile/features/cabins/fleet_screen.dart';
import 'package:octopus_mobile/features/chat/session_screen.dart';
import 'package:octopus_mobile/widgets/crew_animation.dart';
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

/// 舱主会话走 /api/agent：messages.items 里一条 assistant 行带 thinking / tool_calls。
const _sessionJson = {
  'id': 's-main',
  'title': '舱主对话',
  'workspace_id': 'ws1',
  'is_active': true,
  'created_at': '2026-11-26T10:00:00Z',
  'updated_at': '2026-11-26T10:05:00Z',
  'messages': {
    'items': [
      {'id': 'u0', 'role': 'user', 'content': '看看 phase 2', 'created_at': '2026-11-26T10:01:00Z'},
      {
        'id': 'm-tools',
        'role': 'assistant',
        'content': '',
        'thinking': '先核对 manifest 里的引用',
        'created_at': '2026-11-26T10:02:00Z',
        'tool_calls': [
          {'id': 'tc-1', 'name': 'Read', 'status': 'result', 'input': {'file_path': '.task/manifest.json'}},
          {'id': 'tc-2', 'name': 'Grep', 'status': 'result', 'input': {'pattern': 'phase-2'}},
        ],
      },
      {'id': 'm-mirror', 'role': 'user', 'content': 'phase 2 引用一起清掉吗？', 'created_at': '2026-11-26T10:03:00Z'},
    ],
    'total': 3,
    'has_more': false,
  },
};

const _sessionRow = {
  'id': 's-main',
  'title': '舱主对话',
  'workspace_id': 'ws1',
  'is_active': true,
  'created_at': '2026-11-26T10:00:00Z',
  'updated_at': '2026-11-26T10:05:00Z',
};

/// 一台假机器：舱快照会随 attention 变化，事件流可手动推 `cabin_view`。
class _FakeServer {
  _FakeServer({
    List<Map<String, Object?>>? attention,
    List<Map<String, Object?>>? sessions,
    this.mainSessionId = 's-main',
  })  : attention = attention ?? [_askAttentionJson],
        sessions = sessions ?? [_sessionRow];

  List<Map<String, Object?>> attention;
  List<Map<String, Object?>> sessions;
  List<Map<String, Object?>> delegations = [];
  final String? mainSessionId;
  int detailCalls = 0;
  int createCalls = 0;

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
              'main_session_id': mainSessionId,
              'status': 'active',
            },
            'view': {
              'attention': attention,
              'health': _healthJson,
              'open_findings': 0,
            },
          });
        }
        if (path == '/api/cabins/c1/delegations') {
          return jsonBody({'delegations': delegations});
        }
        if (path == '/api/cabins/c1/delegations/register') {
          final body = options.data is Map ? options.data as Map : const {};
          final sessionId = body['session_id'] as String? ?? '';
          delegations = [
            ...delegations,
            {
              'id': 'd-$sessionId',
              'session_id': sessionId,
              'title': '新对话',
              'state': 'queued',
              'origin': 'user',
              'created_at': '2026-11-26T11:00:00Z',
              'updated_at': '2026-11-26T11:00:00Z',
            },
          ];
          return jsonBody({'delegation': delegations.last}, status: 201);
        }
        if (path == '/api/agent/sessions') {
          if (options.method == 'POST') {
            createCalls++;
            final created = {
              'id': 's-new',
              'title': '新对话',
              'workspace_id': 'ws1',
              'is_active': true,
              'created_at': '2026-11-26T11:00:00Z',
              'updated_at': '2026-11-26T11:00:00Z',
            };
            sessions = [created, ...sessions];
            return jsonBody(created);
          }
          return jsonBody({
            'items': sessions,
            'total': sessions.length,
            'has_more': false,
          });
        }
        if (path == '/api/agent/sessions/s-main') return jsonBody(_sessionJson);
        if (path == '/api/agent/sessions/s-new') {
          return jsonBody({
            ..._sessionJson,
            'id': 's-new',
            'title': '新对话',
            'messages': {'items': <Object>[], 'total': 0, 'has_more': false},
          });
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
        path: '/cabin/:cabinId/fleet',
        builder: (context, state) =>
            FleetScreen(cabinId: state.pathParameters['cabinId'] ?? ''),
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

  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  return router;
}

Future<void> _unmount(WidgetTester tester, GoRouter router) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
  router.dispose();
}

Future<void> _openFleet(WidgetTester tester) async {
  await tester.tap(find.text('☰ 编队'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

void main() {
  testWidgets('点进舱先落到主 chat：立绘在面板后、没有动作文字标签', (tester) async {
    final server = _FakeServer();
    final router = await _pumpCabin(tester, server);

    expect(find.text('主 CHAT'), findsOneWidget);
    expect(find.text('测试舱'), findsOneWidget);
    expect(find.text('☰ 编队'), findsOneWidget);
    // 主会话的消息直接铺在聊天面板里（不是先看三块列表）。
    expect(find.textContaining('看看 phase 2', findRichText: true), findsOneWidget);
    // 立绘在面板后面动着；动作文字标签已经不要了。
    expect(find.byType(CrewBackdrop), findsOneWidget);
    expect(find.textContaining('待命'), findsNothing);
    expect(find.textContaining('IDLE'), findsNothing);

    await _unmount(tester, router);
  });

  testWidgets('☰ 编队 → 待你定 → 点回去：主 chat 挂上同一问的引用条', (tester) async {
    final server = _FakeServer();
    final router = await _pumpCabin(tester, server);

    await _openFleet(tester);

    expect(find.text('编队'), findsOneWidget);
    expect(find.text('phase-2 清理'), findsOneWidget);
    expect(find.textContaining('任务 · #1 · xzf · P2 · 第 2 轮', findRichText: true), findsOneWidget);

    // 点开 → 回主 chat（路由 pop 带引用）。
    await tester.tap(find.text('去会话里说 ›'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }

    expect(find.text('主 CHAT'), findsOneWidget);
    expect(find.text('正在回复'), findsOneWidget);
    expect(find.textContaining('依据 2 条', findRichText: true), findsOneWidget);
    expect(find.text('回复上面这个问题…'), findsOneWidget);

    await _unmount(tester, router);
  });

  testWidgets('cabin_view 事件 → 去抖后重拉快照，编队里待你定清空', (tester) async {
    final server = _FakeServer();
    final router = await _pumpCabin(tester, server);

    await _openFleet(tester);
    expect(find.text('phase-2 清理'), findsOneWidget);
    final before = server.detailCalls;

    // 服务端把这问答掉了，推一条 cabin_view。
    server.attention = [];
    server.pushCabinView();
    await tester.pump(const Duration(milliseconds: 600)); // 去抖 450ms
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }

    expect(server.detailCalls, greaterThan(before));
    expect(find.text('phase-2 清理'), findsNothing);
    expect(find.text('这儿没有等你的事'), findsOneWidget);

    await _unmount(tester, router);
  });

  testWidgets('一条会话都没有：主 chat 空态给「新建会话」，建完直接进 chat', (tester) async {
    final server = _FakeServer(sessions: [], mainSessionId: null);
    final router = await _pumpCabin(tester, server);

    expect(find.text('这个舱还没有会话'), findsOneWidget);
    expect(find.text('正在回复'), findsNothing);

    await tester.tap(find.text('新建会话'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }

    expect(server.createCalls, 1);
    // 新会话空态：直接在主 chat 里说第一句话。
    expect(find.text('在这儿说点什么'), findsOneWidget);
    expect(find.text('说点什么…'), findsOneWidget);

    await _unmount(tester, router);
  });
}
