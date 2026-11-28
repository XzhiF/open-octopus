// M4 · 设备列表三档状态 + 一键启动（组件级）。
//
// 用假探针 / 假 SSH 把「在线 · 未启动 → 点启动 → 运行中」走一遍真实 widget 树。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:octopus_mobile/core/models/device.dart';
import 'package:octopus_mobile/core/providers.dart';
import 'package:octopus_mobile/core/remote.dart';
import 'package:octopus_mobile/core/remote_key_store.dart';
import 'package:octopus_mobile/core/storage.dart';
import 'package:octopus_mobile/features/devices/devices_screen.dart';

const _privateKey =
    '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n';
const _startOk =
    '{"ok":true,"verb":"start","octopus":{"state":"stopped","http":0},"result":"started"}';
const _statusStopped =
    '{"ok":true,"verb":"status","octopus":{"state":"stopped","http":0},'
    '"task":{"name":"Octopus","registered":true}}';

class _StatusShell implements RemoteShell {
  bool startCalled = false;
  final List<RemoteVerb> verbs = [];

  @override
  Future<RemoteShellResult> run({
    required String host,
    required int port,
    required String user,
    required String privateKey,
    required RemoteVerb verb,
  }) async {
    verbs.add(verb);
    if (verb == RemoteVerb.start) {
      startCalled = true;
      return const RemoteShellResult(stdout: _startOk, exitCode: 0);
    }
    return const RemoteShellResult(stdout: _statusStopped, exitCode: 0);
  }
}

const _device = Device(
  id: 'd1',
  name: '书房主机',
  baseUrl: 'https://shufang-pc.tail1234.ts.net',
  sshUser: 'EDY',
  sshPort: 22,
  sshSlot: 'slot-01',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('在线·未启动 → 点启动 → 运行中', (tester) async {
    // 关掉场景呼吸动画，pump 才有稳定终点。
    SharedPreferences.setMockInitialValues({'octopus.reduceMotion.v1': true});
    final prefs = await SharedPreferences.getInstance();
    final shell = _StatusShell();

    final container = ProviderContainer(overrides: [
      storeProvider.overrideWithValue(Store(prefs)),
      remoteKeyStoreProvider.overrideWithValue(InMemoryRemoteKeyStore()),
      remoteShellProvider.overrideWithValue(shell),
      // 启动前 HTTP 不通（SSH 说 stopped → 在线未启动）；启动后 HTTP 200。
      httpProbeProvider.overrideWithValue(
        (baseUrl) async => shell.startCalled ? DeviceStatus.running : DeviceStatus.offline,
      ),
      launchTimingProvider.overrideWithValue(
        (timeout: const Duration(seconds: 2), interval: const Duration(milliseconds: 1)),
      ),
    ]);
    addTearDown(container.dispose);

    await container.read(appStateProvider.notifier).addDevice(_device);
    await container.read(appStateProvider.notifier).saveRemote(
          'd1',
          user: 'EDY',
          port: 22,
          slot: 'slot-01',
          privateKey: _privateKey,
        );

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: DevicesScreen()),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('在线·未启动'), findsOneWidget);
    expect(find.text('启动'), findsOneWidget);

    await tester.tap(find.text('启动'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 20));

    expect(shell.verbs, contains(RemoteVerb.start));
    expect(find.text('运行中'), findsOneWidget);
  });
}
