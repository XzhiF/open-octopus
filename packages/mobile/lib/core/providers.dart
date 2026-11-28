import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api.dart';
import 'http.dart';
import 'models/cabin.dart';
import 'models/chat.dart';
import 'models/device.dart';
import 'models/sse.dart';
import 'models/task.dart';
import 'remote.dart';
import 'remote_key_store.dart';
import 'storage.dart';
import 'token_store.dart';

/// 由 main() 在 bootstrap 时覆盖为真实实例。
final storeProvider = Provider<Store>((ref) {
  throw UnimplementedError('storeProvider 必须在 bootstrap 覆盖');
});

/// 设备令牌存储：main() 覆盖为 SecureTokenStore；单测默认进程内记忆。
final tokenStoreProvider = Provider<TokenStore>((ref) => InMemoryTokenStore());

/// 远程拉起密钥存储（M4）：main() 覆盖为 SecureRemoteKeyStore。
final remoteKeyStoreProvider = Provider<RemoteKeyStore>(
  (ref) => InMemoryRemoteKeyStore(),
);

/// SSH 执行面（M4）：单测覆盖成假实现，不连真实网络。
final remoteShellProvider = Provider<RemoteShell>(
  (ref) => const SshRemoteShell(),
);

/// HTTP 探活面：抽出来是为了让「启动后轮询」在测试里可替换。
final httpProbeProvider = Provider<Future<DeviceStatus> Function(String)>(
  (ref) => probeDevice,
);

/// 拉起节奏：90 秒上限 / 2 秒一轮（测试覆写成毫秒级）。
final launchTimingProvider = Provider<({Duration timeout, Duration interval})>(
  (ref) => (
    timeout: const Duration(seconds: 90),
    interval: const Duration(seconds: 2),
  ),
);

class AppState {
  const AppState({
    this.devices = const [],
    this.tokens = const {},
    this.sshKeys = const {},
    this.currentDeviceId,
    this.reduceMotion = false,
    this.crewVideo = true,
  });

  final List<Device> devices;

  /// 已配对设备的令牌（内存副本；落盘在系统安全存储里）。
  final Map<String, String> tokens;

  /// 远程拉起的 SSH 私钥（内存副本；落盘在系统安全存储里）。
  final Map<String, String> sshKeys;

  final String? currentDeviceId;
  final bool reduceMotion;

  /// 立绘动画（带透明通道的 WebP）。默认开；关掉就整支不画 —— 没有静态兜底图。
  final bool crewVideo;

  String? tokenFor(String? deviceId) =>
      deviceId == null ? null : tokens[deviceId];

  String? sshKeyFor(String? deviceId) =>
      deviceId == null ? null : sshKeys[deviceId];

  /// 当前设备的令牌；null = 这台机器没开设备令牌（回环直连）或还没配对。
  String? get currentToken => tokenFor(currentDeviceId);

  Device? get currentDevice {
    final id = currentDeviceId;
    if (id == null) return null;
    for (final d in devices) {
      if (d.id == id) return d;
    }
    return null;
  }

  AppState copyWith({
    List<Device>? devices,
    Map<String, String>? tokens,
    Map<String, String>? sshKeys,
    String? currentDeviceId,
    bool clearCurrent = false,
    bool? reduceMotion,
    bool? crewVideo,
  }) {
    return AppState(
      devices: devices ?? this.devices,
      tokens: tokens ?? this.tokens,
      sshKeys: sshKeys ?? this.sshKeys,
      currentDeviceId: clearCurrent
          ? null
          : (currentDeviceId ?? this.currentDeviceId),
      reduceMotion: reduceMotion ?? this.reduceMotion,
      crewVideo: crewVideo ?? this.crewVideo,
    );
  }
}

class AppStateNotifier extends Notifier<AppState> {
  @override
  AppState build() {
    final store = ref.read(storeProvider);
    final tokenStore = ref.read(tokenStoreProvider);
    final remoteKeys = ref.read(remoteKeyStoreProvider);
    final devices = store.loadDevices();
    final tokens = <String, String>{};
    final sshKeys = <String, String>{};
    for (final device in devices) {
      final token = tokenStore.tokenFor(device.id);
      if (token != null && token.isNotEmpty) tokens[device.id] = token;
      final key = remoteKeys.keyFor(device.id);
      if (key != null && key.isNotEmpty) sshKeys[device.id] = key;
    }
    final savedId = store.loadCurrentDeviceId();
    final currentId = savedId != null && devices.any((d) => d.id == savedId)
        ? savedId
        : null;
    return AppState(
      devices: devices,
      tokens: tokens,
      sshKeys: sshKeys,
      currentDeviceId: currentId,
      reduceMotion: store.loadReduceMotion(),
      crewVideo: store.loadCrewVideo(),
    );
  }

  Future<void> addDevice(Device device) async {
    final next = [...state.devices.where((d) => d.id != device.id), device];
    await ref.read(storeProvider).saveDevices(next);
    final storedKey = ref.read(remoteKeyStoreProvider).keyFor(device.id);
    state = state.copyWith(
      devices: next,
      sshKeys: storedKey == null || storedKey.isEmpty
          ? null
          : {...state.sshKeys, device.id: storedKey},
    );
  }

  Future<void> removeDevice(String id) async {
    final next = state.devices.where((d) => d.id != id).toList(growable: false);
    await ref.read(storeProvider).saveDevices(next);
    await ref.read(tokenStoreProvider).remove(id);
    await ref.read(remoteKeyStoreProvider).remove(id);
    final tokens = {...state.tokens}..remove(id);
    final sshKeys = {...state.sshKeys}..remove(id);
    final clearing = state.currentDeviceId == id;
    if (clearing) await ref.read(storeProvider).saveCurrentDeviceId(null);
    state = state.copyWith(
      devices: next,
      tokens: tokens,
      sshKeys: sshKeys,
      clearCurrent: clearing,
    );
  }

  /// 配对兑换回来 / 手动粘贴的令牌：写安全存储 + 更新内存副本。
  Future<void> saveToken(String deviceId, String token) async {
    await ref.read(tokenStoreProvider).save(deviceId, token);
    state = state.copyWith(tokens: {...state.tokens, deviceId: token});
  }

  /// 配对时换到的「远程拉起」：SSH 用户 / 端口 / 槽位写进设备，
  /// 私钥进安全存储（重新配对时整把替换）。
  Future<void> saveRemote(
    String deviceId, {
    required String user,
    required int port,
    String? slot,
    String? privateKey,
  }) async {
    final next = state.devices
        .map(
          (d) => d.id == deviceId
              ? d.copyWith(sshUser: user, sshPort: port, sshSlot: slot)
              : d,
        )
        .toList(growable: false);
    await ref.read(storeProvider).saveDevices(next);
    if (privateKey == null || privateKey.isEmpty) {
      state = state.copyWith(devices: next);
      return;
    }
    await ref.read(remoteKeyStoreProvider).save(deviceId, privateKey);
    state = state.copyWith(
      devices: next,
      sshKeys: {...state.sshKeys, deviceId: privateKey},
    );
  }

  Future<void> clearToken(String deviceId) async {
    await ref.read(tokenStoreProvider).remove(deviceId);
    final tokens = {...state.tokens}..remove(deviceId);
    state = state.copyWith(tokens: tokens);
  }

  Future<void> renameDevice(String id, String name) async {
    final next = state.devices
        .map((d) => d.id == id ? d.copyWith(name: name) : d)
        .toList(growable: false);
    await ref.read(storeProvider).saveDevices(next);
    state = state.copyWith(devices: next);
  }

  /// 改设备地址（换 IP / 域名 / 端口）：令牌、远程拉起密钥、名字都留着，
  /// 只换根地址 —— 跟重新配对是两回事。
  ///
  /// `apiProvider` 与 [deviceStatusProvider] 都盯着 `baseUrl`，改完下一帧
  /// 就用新地址重连、重新探活，不用重启 App。
  Future<void> setDeviceAddress(String id, String baseUrl) async {
    final normalized = normalizeBaseUrl(baseUrl);
    if (normalized.isEmpty) return;
    final next = state.devices
        .map((d) => d.id == id ? d.copyWith(baseUrl: normalized) : d)
        .toList(growable: false);
    await ref.read(storeProvider).saveDevices(next);
    state = state.copyWith(devices: next);
  }

  Future<void> selectDevice(String? id) async {
    await ref.read(storeProvider).saveCurrentDeviceId(id);
    state = state.copyWith(currentDeviceId: id, clearCurrent: id == null);
  }

  Future<void> setReduceMotion(bool value) async {
    await ref.read(storeProvider).saveReduceMotion(value);
    state = state.copyWith(reduceMotion: value);
  }

  Future<void> setCrewVideo(bool value) async {
    await ref.read(storeProvider).saveCrewVideo(value);
    state = state.copyWith(crewVideo: value);
  }

  Future<void> markSeen(String id) async {
    final at = DateTime.now();
    await ref.read(storeProvider).touchLastSeen(id, at);
    final next = state.devices
        .map(
          (d) => d.id == id ? d.copyWith(lastSeenAt: at.toIso8601String()) : d,
        )
        .toList(growable: false);
    await ref.read(storeProvider).saveDevices(next);
    state = state.copyWith(devices: next);
  }
}

final appStateProvider = NotifierProvider<AppStateNotifier, AppState>(
  AppStateNotifier.new,
);

final currentDeviceProvider = Provider<Device?>(
  (ref) => ref.watch(appStateProvider).currentDevice,
);

final reduceMotionProvider = Provider<bool>(
  (ref) => ref.watch(appStateProvider).reduceMotion,
);

final crewVideoProvider = Provider<bool>(
  (ref) => ref.watch(appStateProvider).crewVideo,
);

/// 跟随当前设备的 baseUrl / 令牌重建；换机器或重新配对时旧 dio 被关闭。
/// 只盯 baseUrl + token —— 改名 / 记录 lastSeen 不该把正在飞的请求干掉。
final apiProvider = Provider<OctopusApi?>((ref) {
  final baseUrl = ref.watch(
    appStateProvider.select((s) => s.currentDevice?.baseUrl),
  );
  final token = ref.watch(appStateProvider.select((s) => s.currentToken));
  if (baseUrl == null) return null;
  final api = OctopusApi(baseUrl, token: token);
  ref.onDispose(api.close);
  return api;
});

// ── 设备探活 ────────────────────────────────────────────────────────────

/// 三档状态：HTTP 通 → 运行中 / 未就绪；HTTP 不通但有远程密钥 → 再问一次 SSH，
/// 能问出 stopped 就是「在线 · 未启动」，SSH 也不通才是真离线。
final deviceStatusProvider = FutureProvider.autoDispose
    .family<DeviceStatus, String>((ref, deviceId) async {
      // 只盯 baseUrl + 远程配置：markSeen 改 lastSeenAt，若盯整个 Device 会自激重探。
      final info = ref.watch(
        appStateProvider.select((s) {
          final d = _deviceOf(s.devices, deviceId);
          if (d == null) return null;
          return (d.baseUrl, d.sshUser, d.sshPort);
        }),
      );
      if (info == null) return DeviceStatus.unknown;
      final key = ref.watch(
        appStateProvider.select((s) => s.sshKeys[deviceId]),
      );

      final status = await probeDeviceStatus(
        baseUrl: info.$1,
        sshUser: info.$2,
        sshPort: info.$3,
        privateKey: key,
        shell: ref.read(remoteShellProvider),
        httpProbe: ref.read(httpProbeProvider),
      );
      if (status == DeviceStatus.running) {
        // 记录一次「上次在线」，列表里离线时也有话说。
        await ref.read(appStateProvider.notifier).markSeen(deviceId);
      }
      return status;
    });

Device? _deviceOf(List<Device> devices, String id) {
  for (final d in devices) {
    if (d.id == id) return d;
  }
  return null;
}

// ── 远程拉起（M4）────────────────────────────────────────────────────────

enum LaunchPhase { starting, failed }

class LaunchState {
  const LaunchState({required this.phase, this.message, this.startedAt});

  final LaunchPhase phase;
  final String? message;
  final DateTime? startedAt;

  bool get starting => phase == LaunchPhase.starting;
}

/// 每台设备一条：点「启动」→ SSH 敲 start → 2 秒一轮探活，90 秒封顶。
/// 失败不吞：message 原样给人看（计划任务不存在 / SSH 不通 / timeout）。
class DeviceLaunchController extends Notifier<Map<String, LaunchState>> {
  @override
  Map<String, LaunchState> build() => const {};

  LaunchState? stateOf(String deviceId) => state[deviceId];

  bool isStarting(String deviceId) =>
      state[deviceId]?.phase == LaunchPhase.starting;

  Future<void> start(String deviceId) async {
    if (isStarting(deviceId)) return;

    final app = ref.read(appStateProvider);
    final device = _deviceOf(app.devices, deviceId);
    if (device == null) return;
    if (!device.hasRemote) {
      _set(
        deviceId,
        const LaunchState(
          phase: LaunchPhase.failed,
          message: '这台设备没有远程拉起密钥 —— 在电脑上重新配对一次',
        ),
      );
      return;
    }
    final key = app.sshKeyFor(deviceId);
    if (key == null || key.isEmpty) {
      _set(
        deviceId,
        const LaunchState(
          phase: LaunchPhase.failed,
          message: '远程密钥读不到 —— 在电脑上重新配对一次',
        ),
      );
      return;
    }
    final host = Uri.tryParse(device.baseUrl)?.host ?? '';
    if (host.isEmpty) return;

    _set(
      deviceId,
      LaunchState(phase: LaunchPhase.starting, startedAt: DateTime.now()),
    );

    try {
      final result = await ref
          .read(remoteShellProvider)
          .run(
            host: host,
            port: device.sshPort ?? 22,
            user: device.sshUser!,
            privateKey: key,
            verb: RemoteVerb.start,
          );
      final payload = RemoteStatusPayload.parse(result.stdout);
      if (payload.ok == false) {
        _set(
          deviceId,
          LaunchState(
            phase: LaunchPhase.failed,
            message: payload.message ?? '电脑拒绝启动（${payload.error ?? '未知原因'}）',
          ),
        );
        return;
      }
    } on RemoteException catch (err) {
      _set(
        deviceId,
        LaunchState(phase: LaunchPhase.failed, message: err.message),
      );
      return;
    } catch (err) {
      _set(
        deviceId,
        LaunchState(phase: LaunchPhase.failed, message: '启动命令没发出去：$err'),
      );
      return;
    }

    final timing = ref.read(launchTimingProvider);
    final probe = ref.read(httpProbeProvider);
    final deadline = DateTime.now().add(timing.timeout);
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(timing.interval);
      final status = await probe(device.baseUrl);
      if (status == DeviceStatus.running) {
        await ref.read(appStateProvider.notifier).markSeen(deviceId);
        state = {...state}..remove(deviceId);
        ref.invalidate(deviceStatusProvider(deviceId));
        return;
      }
    }
    _set(
      deviceId,
      LaunchState(
        phase: LaunchPhase.failed,
        message: '等了 ${timing.timeout.inSeconds} 秒还没起来 —— 去电脑上看看 Octopus 有没有报错',
      ),
    );
    ref.invalidate(deviceStatusProvider(deviceId));
  }

  void clear(String deviceId) {
    if (!state.containsKey(deviceId)) return;
    state = {...state}..remove(deviceId);
  }

  void _set(String deviceId, LaunchState value) {
    state = {...state, deviceId: value};
  }
}

final deviceLaunchProvider =
    NotifierProvider<DeviceLaunchController, Map<String, LaunchState>>(
      DeviceLaunchController.new,
    );

// ── 舱 ──────────────────────────────────────────────────────────────────

class CabinCard {
  const CabinCard({
    required this.cabin,
    required this.waitCount,
    required this.reviewCount,
    required this.runningCount,
  });

  final Cabin cabin;
  final int waitCount;
  final int reviewCount;
  final int runningCount;
}

final cabinsProvider = FutureProvider.autoDispose<List<CabinCard>>((ref) async {
  final api = ref.watch(apiProvider);
  if (api == null) throw ApiException('还没选设备', kind: 'network');
  final cabins = await api.cabins();
  final cards = await Future.wait(
    cabins.map((cabin) async {
      try {
        final detail = await api.attention(cabin.id);
        return CabinCard(
          cabin: cabin,
          waitCount: detail.waitCount,
          reviewCount: detail.reviewCount,
          runningCount: detail.health.running,
        );
      } catch (_) {
        // 单个舱探不到不拖垮整张列表
        return CabinCard(
          cabin: cabin,
          waitCount: 0,
          reviewCount: 0,
          runningCount: 0,
        );
      }
    }),
  );
  return cards;
});

final cabinDetailProvider = FutureProvider.autoDispose
    .family<CabinDetail, String>((ref, cabinId) async {
      final api = ref.watch(apiProvider);
      if (api == null) throw ApiException('还没选设备', kind: 'network');
      return api.cabin(cabinId);
    });

/// 舱事件流（断线自动重连）。`cabin_view` / `cabin_status` 一到，舱页重拉快照；
/// heartbeat 只用来确认链路还活着。切后台断流后回来会自动续上。
final cabinEventsProvider = StreamProvider.autoDispose.family<SseEvent, String>(
  (ref, cabinId) async* {
    final api = ref.watch(apiProvider);
    if (api == null) return;
    final cancel = CancelToken();
    ref.onDispose(() => cancel.cancel('dispose'));
    var failures = 0;
    while (!cancel.isCancelled) {
      try {
        await for (final event in api.cabinEvents(
          cabinId,
          cancelToken: cancel,
        )) {
          failures = 0;
          yield event;
        }
      } on ApiException catch (error) {
        if (cancel.isCancelled) return;
        if (error.kind == 'unauthorized') rethrow;
        // 4xx 不是断线（老服务没有这个端点 / 舱被删了）：别无限重试烧电。
        final code = error.statusCode;
        if (code != null && code >= 400 && code < 500) return;
        failures++;
      } catch (_) {
        if (cancel.isCancelled) return;
        failures++;
      }
      if (cancel.isCancelled) return;
      // 1.5s → 3s → 6s 封顶；收到任何事件就归零。
      final backoff = failures <= 1 ? 1.5 : (failures == 2 ? 3.0 : 6.0);
      await Future<void>.delayed(
        Duration(milliseconds: (backoff * 1000).round()),
      );
    }
  },
);

/// 舱自己的会话：主会话（`cabins.main_session_id`）+ 舱里登记过的会话
/// （委派 / 用户自开）。旧的 chat/sessions 域在舱里没有行，不能用。
final cabinSessionsProvider = FutureProvider.autoDispose
    .family<List<SessionRef>, String>((ref, cabinId) async {
      final api = ref.watch(apiProvider);
      if (api == null) throw ApiException('还没选设备', kind: 'network');
      final detail = await ref.watch(cabinDetailProvider(cabinId).future);
      final cabin = detail.cabin;
      final workspaceId = cabin.workspaceId;
      final mainId = cabin.mainSessionId;

      final out = <SessionRef>[];
      if (mainId != null && workspaceId != null) {
        ChatSession main;
        try {
          main = await api.agentSession(mainId);
        } catch (_) {
          // 快照拉不到也别让列表空着：先按主会话 id 占一行。
          main = ChatSession(
            id: mainId,
            workspaceId: workspaceId,
            title: '舱主对话',
            createdAt: '',
            updatedAt: '',
          );
        }
        out.add(SessionRef(workspaceId: workspaceId, session: main));
      }

      for (final ref in await api.cabinDelegations(cabinId)) {
        final id = ref.sessionId;
        if (id == null || id.isEmpty || id == mainId) continue;
        out.add(
          SessionRef(
            workspaceId: workspaceId,
            session: ChatSession(
              id: id,
              workspaceId: workspaceId ?? '',
              title: ref.title.trim().isEmpty ? null : ref.title,
              createdAt: ref.createdAt ?? '',
              updatedAt: ref.updatedAt ?? '',
            ),
          ),
        );
      }
      return out;
    });

/// 会话列表行的轻量包装（带上它所属的工作区，便于跳转）。
class SessionRef {
  const SessionRef({required this.workspaceId, required this.session});

  final String? workspaceId;
  final ChatSession session;
}

final globalSessionsProvider = FutureProvider.autoDispose<List<SessionRef>>((
  ref,
) async {
  final api = ref.watch(apiProvider);
  if (api == null) throw ApiException('还没选设备', kind: 'network');
  final sessions = await api.sessions('');
  return sessions
      .map((s) => SessionRef(workspaceId: null, session: s))
      .toList(growable: false);
});

// ── 任务 ────────────────────────────────────────────────────────────────

final cabinTasksProvider = FutureProvider.autoDispose
    .family<List<TaskItem>, String>((ref, cabinId) async {
      final api = ref.watch(apiProvider);
      if (api == null) throw ApiException('还没选设备', kind: 'network');
      return api.tasks(cabinId: cabinId);
    });

final taskDetailProvider = FutureProvider.autoDispose.family<TaskItem, String>((
  ref,
  taskId,
) async {
  final api = ref.watch(apiProvider);
  if (api == null) throw ApiException('还没选设备', kind: 'network');
  return api.task(taskId);
});
