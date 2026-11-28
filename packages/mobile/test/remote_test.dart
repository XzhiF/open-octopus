// M4 · 远程拉起（手机端）：JSON 解析、三档状态合成、启动/轮询状态机。

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:octopus_mobile/core/models/device.dart';
import 'package:octopus_mobile/core/providers.dart';
import 'package:octopus_mobile/core/remote.dart';
import 'package:octopus_mobile/core/remote_key_store.dart';
import 'package:octopus_mobile/core/storage.dart';

const _privateKey =
    '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n';

const _statusRunning =
    '{"ok":true,"verb":"status","octopus":{"state":"running","http":200,"details":{"pid":1234}},"task":{"name":"Octopus","registered":true}}';
const _statusStopped =
    '{"ok":true,"verb":"status","octopus":{"state":"stopped","http":0},"task":{"name":"Octopus","registered":true}}';
const _startOk =
    '{"ok":true,"verb":"start","octopus":{"state":"stopped","http":0},"result":"started"}';
const _startMissingTask =
    '{"ok":false,"verb":"start","error":"task_missing","message":"计划任务 Octopus 不存在"}';

final _device = Device(
  id: 'd1',
  name: '书房主机',
  baseUrl: 'https://shufang-pc.tail1234.ts.net',
  sshUser: 'EDY',
  sshPort: 22,
  sshSlot: 'slot-01',
);

class _FakeShell implements RemoteShell {
  _FakeShell({this.outputs = const {}, this.error});

  final Map<RemoteVerb, String> outputs;
  final Object? error;
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
    if (error != null) throw error!;
    return RemoteShellResult(stdout: outputs[verb] ?? '{}', exitCode: 0);
  }
}

Future<ProviderContainer> _container({
  required _FakeShell shell,
  required Future<DeviceStatus> Function(String) probe,
}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final container = ProviderContainer(overrides: [
    storeProvider.overrideWithValue(Store(prefs)),
    remoteKeyStoreProvider.overrideWithValue(InMemoryRemoteKeyStore({'d1': _privateKey})),
    remoteShellProvider.overrideWithValue(shell),
    httpProbeProvider.overrideWithValue(probe),
    launchTimingProvider.overrideWithValue(
      (timeout: const Duration(seconds: 2), interval: const Duration(milliseconds: 1)),
    ),
  ]);
  addTearDown(container.dispose);
  await container.read(appStateProvider.notifier).addDevice(_device);
  return container;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('RemoteStatusPayload', () {
    test('running / stopped / start 结果都能读出来', () {
      final running = RemoteStatusPayload.parse(_statusRunning);
      expect(running.running, isTrue);
      expect(running.pid, 1234);
      expect(running.http, 200);
      expect(running.taskRegistered, isTrue);

      final stopped = RemoteStatusPayload.parse(_statusStopped);
      expect(stopped.stopped, isTrue);
      expect(stopped.http, 0);

      final started = RemoteStatusPayload.parse(_startOk);
      expect(started.ok, isTrue);
      expect(started.result, 'started');
    });

    test('前面带一行横幅也能抠出 JSON；不是 JSON 就抛', () {
      final payload = RemoteStatusPayload.parse('warning: 什么\n$_statusStopped');
      expect(payload.stopped, isTrue);

      expect(() => RemoteStatusPayload.parse('not json'), throwsA(isA<RemoteException>()));
      expect(() => RemoteStatusPayload.parse('{"oops":'), throwsA(isA<RemoteException>()));
    });
  });

  group('probeDeviceStatus', () {
    test('HTTP 通了就不碰 SSH', () async {
      final shell = _FakeShell(outputs: {RemoteVerb.status: _statusStopped});
      final status = await probeDeviceStatus(
        baseUrl: 'https://x.ts.net',
        sshUser: 'EDY',
        privateKey: _privateKey,
        shell: shell,
        httpProbe: (_) async => DeviceStatus.running,
      );
      expect(status, DeviceStatus.running);
      expect(shell.verbs, isEmpty);
    });

    test('HTTP 不通 + SSH 说 stopped → 在线未启动', () async {
      final shell = _FakeShell(outputs: {RemoteVerb.status: _statusStopped});
      final status = await probeDeviceStatus(
        baseUrl: 'https://x.ts.net',
        sshUser: 'EDY',
        privateKey: _privateKey,
        shell: shell,
        httpProbe: (_) async => DeviceStatus.offline,
      );
      expect(status, DeviceStatus.onlineStopped);
      expect(shell.verbs, [RemoteVerb.status]);
    });

    test('SSH 说在跑（HTTP 只是没通）→ 未就绪；SSH 抛错 → 离线', () async {
      final running = await probeDeviceStatus(
        baseUrl: 'https://x.ts.net',
        sshUser: 'EDY',
        privateKey: _privateKey,
        shell: _FakeShell(outputs: {RemoteVerb.status: _statusRunning}),
        httpProbe: (_) async => DeviceStatus.offline,
      );
      expect(running, DeviceStatus.notReady);

      final offline = await probeDeviceStatus(
        baseUrl: 'https://x.ts.net',
        sshUser: 'EDY',
        privateKey: _privateKey,
        shell: _FakeShell(error: RemoteException('no route')),
        httpProbe: (_) async => DeviceStatus.offline,
      );
      expect(offline, DeviceStatus.offline);
    });

    test('没远程密钥就不多花一次 SSH', () async {
      final shell = _FakeShell(outputs: {RemoteVerb.status: _statusStopped});
      final status = await probeDeviceStatus(
        baseUrl: 'https://x.ts.net',
        shell: shell,
        httpProbe: (_) async => DeviceStatus.offline,
      );
      expect(status, DeviceStatus.offline);
      expect(shell.verbs, isEmpty);
    });
  });

  group('DeviceLaunchController', () {
    test('start：SSH 敲 start → 轮询到 running → 状态清空、记一次 lastSeen', () async {
      final shell = _FakeShell(outputs: {RemoteVerb.start: _startOk});
      final container = await _container(
        shell: shell,
        probe: (_) async => DeviceStatus.running,
      );

      await container.read(deviceLaunchProvider.notifier).start('d1');

      expect(shell.verbs, [RemoteVerb.start]);
      expect(container.read(deviceLaunchProvider), isEmpty);
      expect(container.read(appStateProvider).devices.single.lastSeenAt, isNotNull);
    });

    test('电脑拒绝（task_missing）：失败态带服务端那句话', () async {
      final shell = _FakeShell(outputs: {RemoteVerb.start: _startMissingTask});
      final container = await _container(
        shell: shell,
        probe: (_) async => DeviceStatus.running,
      );

      await container.read(deviceLaunchProvider.notifier).start('d1');

      final state = container.read(deviceLaunchProvider)['d1'];
      expect(state?.phase, LaunchPhase.failed);
      expect(state?.message, contains('计划任务'));
    });

    test('SSH 连不上：失败态，不发第二次', () async {
      final shell = _FakeShell(error: RemoteException('SSH 10.0.0.1:22 连不上'));
      final container = await _container(
        shell: shell,
        probe: (_) async => DeviceStatus.running,
      );

      await container.read(deviceLaunchProvider.notifier).start('d1');

      final state = container.read(deviceLaunchProvider)['d1'];
      expect(state?.phase, LaunchPhase.failed);
      expect(state?.message, contains('连不上'));
      expect(shell.verbs, [RemoteVerb.start]);
    });
  });
}
