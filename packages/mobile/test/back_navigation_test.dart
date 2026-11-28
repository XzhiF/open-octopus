// 返回的两条规矩：
//   1. 设备列表（栈底）连按两次才退 App —— 一次只提示，别手一滑就没了；
//   2. 其它页面（尤其是选设备之后的舱列表）返回的是上一页，不是 App。
//
// 用 go_router 的真路由跑，系统返回走平台消息 popRoute（Android 的边缘左滑 /
// 返回键都汇到这里），退出 App 走 SystemNavigator.pop，在测试里截下来数次数。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:octopus_mobile/app/router.dart';
import 'package:octopus_mobile/core/models/device.dart';
import 'package:octopus_mobile/core/providers.dart';
import 'package:octopus_mobile/core/remote_key_store.dart';
import 'package:octopus_mobile/core/storage.dart';

const _device = Device(
  id: 'd1',
  name: '书房主机',
  baseUrl: 'http://192.168.2.168:3001',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('设备列表：第一次返回只提示，2 秒内再返回一次才退 App', (tester) async {
    final exits = _captureExit(tester);
    final container = await _container(devices: const []);
    await _pump(tester, container);
    expect(find.text('还没有设备 · 先加一台'), findsOneWidget);

    await _systemBack(tester);
    expect(exits.count, 0, reason: '第一下不许退 App');
    expect(find.text('再返回一次退出 Octopus'), findsOneWidget);

    await _systemBack(tester);
    expect(exits.count, 1, reason: '第二下才退');

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('设备列表：提示过 2 秒后重新计时，不会一把退掉', (tester) async {
    final exits = _captureExit(tester);
    final container = await _container(devices: const []);
    await _pump(tester, container);

    await _systemBack(tester);
    await tester.pump(const Duration(seconds: 3)); // 提示过期
    await _systemBack(tester);

    expect(exits.count, 0, reason: '超时后重新计一次，仍然不退');
    expect(find.text('再返回一次退出 Octopus'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('选设备进舱列表：系统返回回设备列表，不退 App', (tester) async {
    final exits = _captureExit(tester);
    final container = await _container(devices: const [_device]);
    await _pump(tester, container);

    await tester.tap(find.text('书房主机'));
    await _settle(tester);

    expect(find.text('作业舱 · 0'), findsOneWidget);
    expect(container.read(currentDeviceProvider)?.id, 'd1');
    expect(exits.count, 0);

    await _systemBack(tester);
    await _settle(tester);

    expect(exits.count, 0, reason: '退的是上一页，不是 App');
    expect(
      container.read(currentDeviceProvider),
      isNull,
      reason: '回列表等于放下这台设备',
    );
    expect(find.text('书房主机'), findsOneWidget);
    expect(find.text('作业舱 · 0'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('设置页：系统返回退回设备列表，不退 App', (tester) async {
    final exits = _captureExit(tester);
    final container = await _container(devices: const [_device]);
    await _pump(tester, container);

    await tester.tap(find.byIcon(Icons.tune));
    await _settle(tester);
    expect(find.text('显示'), findsOneWidget);

    await _systemBack(tester);
    await _settle(tester);

    expect(exits.count, 0);
    expect(find.text('显示'), findsNothing);
    expect(find.text('＋ 添加'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('设置里换设备 → 舱列表：返回直接回设备列表（栈不被压平）', (tester) async {
    final exits = _captureExit(tester);
    final container = await _container(devices: const [_device]);
    await _pump(tester, container);

    await tester.tap(find.byIcon(Icons.tune));
    await _settle(tester);
    expect(find.text('显示'), findsOneWidget);

    await tester.tap(find.text('书房主机'));
    await _settle(tester);
    expect(find.text('作业舱 · 0'), findsOneWidget);

    await _systemBack(tester);
    await _settle(tester);

    expect(exits.count, 0);
    expect(find.text('作业舱 · 0'), findsNothing);
    expect(find.text('显示'), findsNothing, reason: '设置页已被舱列表替换掉');
    expect(find.text('书房主机'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });
}

/// 截 SystemNavigator.pop：`exits.count` = 真的退了 App 几次。
class _Exits {
  int count = 0;
}

_Exits _captureExit(WidgetTester tester) {
  final exits = _Exits();
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    SystemChannels.platform,
    (call) async {
      if (call.method == 'SystemNavigator.pop') exits.count++;
      return null;
    },
  );
  addTearDown(
    () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      null,
    ),
  );
  return exits;
}

/// 真路由 + 假数据：不开网、不开动效。
Future<ProviderContainer> _container({required List<Device> devices}) async {
  SharedPreferences.setMockInitialValues({'octopus.reduceMotion.v1': true});
  final prefs = await SharedPreferences.getInstance();
  final container = ProviderContainer(
    overrides: [
      storeProvider.overrideWithValue(Store(prefs)),
      remoteKeyStoreProvider.overrideWithValue(InMemoryRemoteKeyStore()),
      httpProbeProvider.overrideWithValue((_) async => DeviceStatus.running),
      cabinsProvider.overrideWith((ref) async => const <CabinCard>[]),
    ],
  );
  addTearDown(container.dispose);
  for (final device in devices) {
    await container.read(appStateProvider.notifier).addDevice(device);
  }
  return container;
}

Future<void> _pump(WidgetTester tester, ProviderContainer container) async {
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(routerConfig: container.read(routerProvider)),
    ),
  );
  // 场景底呼吸 / 星流一直在动，`pumpAndSettle` 收不住。
  await _settle(tester);
}

/// Android 的返回键与手势导航边缘左滑，最后都变成这条平台消息。
Future<void> _systemBack(WidgetTester tester) async {
  final message = const JSONMethodCodec().encodeMethodCall(
    const MethodCall('popRoute'),
  );
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'flutter/navigation',
    message,
    (_) {},
  );
  await tester.pump();
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}
