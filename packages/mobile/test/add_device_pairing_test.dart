import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:octopus_mobile/app/theme.dart';
import 'package:octopus_mobile/core/providers.dart';
import 'package:octopus_mobile/core/storage.dart';
import 'package:octopus_mobile/core/token_store.dart';
import 'package:octopus_mobile/features/devices/add_device_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一台真的回环 HTTP 服务：跑真实 dio / 真实 socket，验「探活 → 401 → 配对 →
/// 令牌进请求头 → 进主页」整条链。不是 mock adapter —— 这是 M3 的验收路径。
class _PairServer {
  late HttpServer _server;
  final List<String> requests = [];
  final String token = 'tok-abc123';
  int redeemCalls = 0;

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server.listen(_handle);
  }

  String get baseUrl => 'http://127.0.0.1:${_server.port}';

  Future<void> close() => _server.close(force: true);

  Future<void> _handle(HttpRequest req) async {
    final auth = req.headers.value(HttpHeaders.authorizationHeader);
    requests.add('${req.method} ${req.uri.path} ${auth ?? '-'}');

    if (req.uri.path == '/api/actuator/health') {
      return _json(req, 200, {'status': 'UP'});
    }
    if (req.uri.path == '/api/cabins') {
      if (auth == 'Bearer $token') return _json(req, 200, {'cabins': <Object>[]});
      return _json(req, 401, {
        'error': 'unauthorized',
        'message': '需要设备令牌 —— 在电脑「设置 → 手机配对」生成配对码',
      });
    }
    if (req.uri.path == '/api/pair/redeem' && req.method == 'POST') {
      redeemCalls++;
      final body = await utf8.decoder.bind(req).join();
      final data = (jsonDecode(body) as Map).cast<String, dynamic>();
      if (data['code'] == '246810') {
        return _json(req, 200, {
          'token': token,
          'device': {'id': 'dev-1', 'name': data['name'] ?? '手机'},
        });
      }
      return _json(req, 400, {'error': 'pairing_failed', 'message': '配对码不对'});
    }
    return _json(req, 404, {'error': 'not_found'});
  }

  Future<void> _json(HttpRequest req, int status, Object body) async {
    req.response.statusCode = status;
    req.response.headers.contentType = ContentType.json;
    req.response.write(jsonEncode(body));
    await req.response.close();
  }
}

class _Harness {
  _Harness(this.container, this.tokens, this.router);

  final ProviderContainer container;
  final InMemoryTokenStore tokens;
  final GoRouter router;
}

Future<_Harness> _pumpApp(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1080, 2800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final tokens = InMemoryTokenStore();
  final container = ProviderContainer(overrides: [
    storeProvider.overrideWithValue(Store(prefs)),
    tokenStoreProvider.overrideWithValue(tokens),
  ]);
  addTearDown(container.dispose);

  final router = GoRouter(
    initialLocation: '/add-device',
    routes: [
      GoRoute(path: '/add-device', builder: (_, _) => const AddDeviceScreen()),
      GoRoute(path: '/device', builder: (_, _) => const Scaffold(body: Text('设备页'))),
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(theme: buildOctoTheme(), routerConfig: router),
  ));
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  return _Harness(container, tokens, router);
}

/// 真 socket 需要真实事件循环：runAsync 让 I/O 跑，pump 让 UI 跟上。
Future<void> _waitFor(WidgetTester tester, Finder finder, {int rounds = 120}) async {
  for (var i = 0; i < rounds; i++) {
    if (finder.evaluate().isNotEmpty) return;
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 20));
  }
  fail('等不到：$finder');
}

void main() {
  late _PairServer server;

  setUp(() async {
    // flutter_test 默认把所有 HttpClient 请求打成 400（无真实网络）。
    // 这个文件要跑真 socket，必须把这个桩关掉。
    HttpOverrides.global = null;
    server = _PairServer();
    await server.start();
  });

  tearDown(() async {
    await server.close();
  });

  testWidgets('没填配对码：探活 401 → 提示补配对码 → 填码连接 → 进设备页', (tester) async {
    final harness = await _pumpApp(tester);

    await tester.enterText(find.byType(TextField).at(0), server.baseUrl);
    await tester.tap(find.text('连 接'));
    await tester.pump();

    // 401 之后把配对码框标出来。
    await _waitFor(tester, find.textContaining('这台电脑开了设备令牌'));
    expect(harness.container.read(appStateProvider).devices, isEmpty);

    await tester.enterText(find.byType(TextField).at(2), '246810');
    await tester.tap(find.text('连 接'));
    await tester.pump();

    await _waitFor(tester, find.text('设备页'));
    expect(server.redeemCalls, 1);
    expect(server.requests.any((r) => r.startsWith('GET /api/cabins -')), isTrue);

    final state = harness.container.read(appStateProvider);
    expect(state.devices, hasLength(1));
    // 服务端回的名字被当成设备名（名字输入框留空时）。
    expect(state.devices.single.name, '手机');
    expect(state.currentToken, server.token);
    expect(harness.tokens.tokenFor(state.devices.single.id), server.token);
  });

  testWidgets('配对码不对：把服务端的话原样显示', (tester) async {
    final harness = await _pumpApp(tester);

    await tester.enterText(find.byType(TextField).at(0), server.baseUrl);
    await tester.enterText(find.byType(TextField).at(2), '111111');
    await tester.tap(find.text('连 接'));
    await tester.pump();

    await _waitFor(tester, find.text('配对码不对'));
    expect(harness.container.read(appStateProvider).devices, isEmpty);
    expect(harness.container.read(appStateProvider).currentToken, isNull);
  });

  testWidgets('已有令牌：粘贴后直接连接，后续请求都带 Bearer', (tester) async {
    final harness = await _pumpApp(tester);

    await tester.enterText(find.byType(TextField).at(0), server.baseUrl);
    await tester.tap(find.textContaining('直接粘贴令牌'));
    await tester.pump();

    // 展开后的第四个输入框是令牌。
    await tester.enterText(find.byType(TextField).at(3), server.token);
    await tester.tap(find.text('连 接'));
    await tester.pump();

    await _waitFor(tester, find.text('设备页'));
    expect(server.redeemCalls, 0);
    expect(
      server.requests.any((r) => r.startsWith('GET /api/cabins Bearer ${server.token}')),
      isTrue,
    );
    expect(harness.container.read(appStateProvider).currentToken, server.token);
  });
}
