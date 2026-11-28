// 设备地址可改：换 IP / 域名 / 端口，令牌与远程配置都留着，改完直接用新地址。
//
// 覆盖两层：状态层（归一化 + 落盘 + 不动别的字段）和设置页的入口
// （设备 ⋯ → 改地址 → 保存 → 后台探一次）。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:octopus_mobile/core/models/device.dart';
import 'package:octopus_mobile/core/providers.dart';
import 'package:octopus_mobile/core/remote_key_store.dart';
import 'package:octopus_mobile/core/storage.dart';
import 'package:octopus_mobile/core/token_store.dart';
import 'package:octopus_mobile/features/settings/settings_screen.dart';

const _a = Device(
  id: 'd1',
  name: 'dev',
  baseUrl: 'http://127.0.0.1:3001',
  sshUser: 'EDY',
  sshPort: 22,
  sshSlot: 'slot-01',
);

const _b = Device(
  id: 'd2',
  name: '书房主机',
  baseUrl: 'https://shufang-pc.tail1234.ts.net',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('改地址：归一化后落盘，令牌 / 远程配置 / 别的设备都不动', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        storeProvider.overrideWithValue(Store(prefs)),
        tokenStoreProvider.overrideWithValue(InMemoryTokenStore()),
        remoteKeyStoreProvider.overrideWithValue(InMemoryRemoteKeyStore()),
      ],
    );
    addTearDown(container.dispose);

    final state = container.read(appStateProvider.notifier);
    await state.addDevice(_a);
    await state.addDevice(_b);
    await state.saveToken('d1', 'tok-1');

    await state.setDeviceAddress('d1', ' 192.168.2.168:3001/ ');

    final app = container.read(appStateProvider);
    final changed = app.devices.firstWhere((d) => d.id == 'd1');
    expect(changed.baseUrl, 'http://192.168.2.168:3001');
    expect(changed.name, 'dev');
    expect(changed.sshUser, 'EDY');
    expect(changed.sshSlot, 'slot-01');
    expect(app.tokenFor('d1'), 'tok-1');
    expect(
      app.devices.firstWhere((d) => d.id == 'd2').baseUrl,
      _b.baseUrl,
      reason: '别的设备不该跟着改',
    );

    // 落盘了：换一份 Store 也读得到新地址。
    expect(
      Store(prefs).loadDevices().firstWhere((d) => d.id == 'd1').baseUrl,
      'http://192.168.2.168:3001',
    );

    // 空地址不写。
    await state.setDeviceAddress('d1', '   ');
    expect(
      container
          .read(appStateProvider)
          .devices
          .firstWhere((d) => d.id == 'd1')
          .baseUrl,
      'http://192.168.2.168:3001',
    );
  });

  testWidgets('设置 → 设备 ⋯ → 改地址：写回并用新地址探活', (tester) async {
    // 关掉场景呼吸动画，pump 才有稳定终点。
    SharedPreferences.setMockInitialValues({'octopus.reduceMotion.v1': true});
    final prefs = await SharedPreferences.getInstance();
    final probes = <String>[];

    final container = ProviderContainer(
      overrides: [
        storeProvider.overrideWithValue(Store(prefs)),
        remoteKeyStoreProvider.overrideWithValue(InMemoryRemoteKeyStore()),
        httpProbeProvider.overrideWithValue((baseUrl) async {
          probes.add(baseUrl);
          return DeviceStatus.running;
        }),
      ],
    );
    addTearDown(container.dispose);
    await container.read(appStateProvider.notifier).addDevice(_a);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: SettingsScreen()),
      ),
    );
    await tester.pump();

    expect(find.text('http://127.0.0.1:3001'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.more_vert));
    await _settle(tester);
    await tester.tap(find.text('改地址（IP / 域名）'));
    await _settle(tester);

    await tester.enterText(find.byType(TextField), '192.168.2.168:3001');
    await tester.tap(find.text('保存'));
    await _settle(tester);

    expect(
      container.read(appStateProvider).devices.single.baseUrl,
      'http://192.168.2.168:3001',
    );
    expect(probes, ['http://192.168.2.168:3001']);
    expect(find.text('http://192.168.2.168:3001'), findsOneWidget);
    expect(find.textContaining('· 在线'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('改地址：填不出主机名时不写、原地报错', (tester) async {
    SharedPreferences.setMockInitialValues({'octopus.reduceMotion.v1': true});
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        storeProvider.overrideWithValue(Store(prefs)),
        remoteKeyStoreProvider.overrideWithValue(InMemoryRemoteKeyStore()),
        httpProbeProvider.overrideWithValue((_) async => DeviceStatus.offline),
      ],
    );
    addTearDown(container.dispose);
    await container.read(appStateProvider.notifier).addDevice(_a);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: SettingsScreen()),
      ),
    );
    await tester.pump();

    await tester.tap(find.byIcon(Icons.more_vert));
    await _settle(tester);
    await tester.tap(find.text('改地址（IP / 域名）'));
    await _settle(tester);

    await tester.enterText(find.byType(TextField), ':::');
    await tester.tap(find.text('保存'));
    await _settle(tester);

    expect(find.text('这个地址解析不出主机名'), findsOneWidget);
    expect(
      container.read(appStateProvider).devices.single.baseUrl,
      'http://127.0.0.1:3001',
      reason: '没通过校验就不写',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });
}

/// 场景底 / 星流一直在动，`pumpAndSettle` 收不住 —— 固定推几帧够动画走完就行。
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}
