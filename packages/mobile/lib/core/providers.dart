import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api.dart';
import 'http.dart';
import 'models/cabin.dart';
import 'models/chat.dart';
import 'models/device.dart';
import 'models/task.dart';
import 'storage.dart';

/// 由 main() 在 bootstrap 时覆盖为真实实例。
final storeProvider = Provider<Store>((ref) {
  throw UnimplementedError('storeProvider 必须在 bootstrap 覆盖');
});

class AppState {
  const AppState({
    this.devices = const [],
    this.currentDeviceId,
    this.reduceMotion = false,
    this.crewVideo = false,
  });

  final List<Device> devices;
  final String? currentDeviceId;
  final bool reduceMotion;

  /// 立绘走视频（VP9 alpha）。默认关，真机 spike 通过后再默认开。
  final bool crewVideo;

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
    String? currentDeviceId,
    bool clearCurrent = false,
    bool? reduceMotion,
    bool? crewVideo,
  }) {
    return AppState(
      devices: devices ?? this.devices,
      currentDeviceId: clearCurrent ? null : (currentDeviceId ?? this.currentDeviceId),
      reduceMotion: reduceMotion ?? this.reduceMotion,
      crewVideo: crewVideo ?? this.crewVideo,
    );
  }
}

class AppStateNotifier extends Notifier<AppState> {
  @override
  AppState build() {
    final store = ref.read(storeProvider);
    final devices = store.loadDevices();
    final savedId = store.loadCurrentDeviceId();
    final currentId =
        savedId != null && devices.any((d) => d.id == savedId) ? savedId : null;
    return AppState(
      devices: devices,
      currentDeviceId: currentId,
      reduceMotion: store.loadReduceMotion(),
      crewVideo: store.loadCrewVideo(),
    );
  }

  Future<void> addDevice(Device device) async {
    final next = [...state.devices.where((d) => d.id != device.id), device];
    await ref.read(storeProvider).saveDevices(next);
    state = state.copyWith(devices: next);
  }

  Future<void> removeDevice(String id) async {
    final next = state.devices.where((d) => d.id != id).toList(growable: false);
    await ref.read(storeProvider).saveDevices(next);
    final clearing = state.currentDeviceId == id;
    if (clearing) await ref.read(storeProvider).saveCurrentDeviceId(null);
    state = state.copyWith(devices: next, clearCurrent: clearing);
  }

  Future<void> renameDevice(String id, String name) async {
    final next = state.devices
        .map((d) => d.id == id ? d.copyWith(name: name) : d)
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
        .map((d) => d.id == id ? d.copyWith(lastSeenAt: at.toIso8601String()) : d)
        .toList(growable: false);
    await ref.read(storeProvider).saveDevices(next);
    state = state.copyWith(devices: next);
  }
}

final appStateProvider = NotifierProvider<AppStateNotifier, AppState>(AppStateNotifier.new);

final currentDeviceProvider = Provider<Device?>(
  (ref) => ref.watch(appStateProvider).currentDevice,
);

final reduceMotionProvider = Provider<bool>(
  (ref) => ref.watch(appStateProvider).reduceMotion,
);

final crewVideoProvider = Provider<bool>(
  (ref) => ref.watch(appStateProvider).crewVideo,
);

/// 跟随当前设备的 baseUrl 重建；换机器时旧 dio 被关闭。
/// 只盯 baseUrl —— 改名 / 记录 lastSeen 不该把正在飞的请求干掉。
final apiProvider = Provider<OctopusApi?>((ref) {
  final baseUrl = ref.watch(appStateProvider.select((s) => s.currentDevice?.baseUrl));
  if (baseUrl == null) return null;
  final api = OctopusApi(baseUrl);
  ref.onDispose(api.close);
  return api;
});

// ── 设备探活 ────────────────────────────────────────────────────────────

final deviceStatusProvider = FutureProvider.autoDispose.family<DeviceStatus, String>(
  (ref, deviceId) async {
    // 只盯 baseUrl：markSeen 会改 lastSeenAt，若盯整个 Device 会自激重探。
    final baseUrl = ref.watch(appStateProvider.select((s) => _baseUrlOf(s.devices, deviceId)));
    if (baseUrl == null) return DeviceStatus.unknown;
    final status = await probeDevice(baseUrl);
    if (status == DeviceStatus.running) {
      // 记录一次「上次在线」，列表里离线时也有话说。
      await ref.read(appStateProvider.notifier).markSeen(deviceId);
    }
    return status;
  },
);

String? _baseUrlOf(List<Device> devices, String id) {
  for (final d in devices) {
    if (d.id == id) return d.baseUrl;
  }
  return null;
}

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
  final cards = await Future.wait(cabins.map((cabin) async {
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
      return CabinCard(cabin: cabin, waitCount: 0, reviewCount: 0, runningCount: 0);
    }
  }));
  return cards;
});

final cabinDetailProvider =
    FutureProvider.autoDispose.family<CabinDetail, String>((ref, cabinId) async {
  final api = ref.watch(apiProvider);
  if (api == null) throw ApiException('还没选设备', kind: 'network');
  return api.cabin(cabinId);
});

final sessionsProvider =
    FutureProvider.autoDispose.family<List<SessionRef>, String>((ref, workspaceId) async {
  final api = ref.watch(apiProvider);
  if (api == null) throw ApiException('还没选设备', kind: 'network');
  return (await api.sessions(workspaceId))
      .map((s) => SessionRef(workspaceId: workspaceId, session: s))
      .toList(growable: false);
});

/// 会话列表行的轻量包装（带上它所属的工作区，便于跳转）。
class SessionRef {
  const SessionRef({required this.workspaceId, required this.session});

  final String? workspaceId;
  final ChatSession session;
}

final globalSessionsProvider = FutureProvider.autoDispose<List<SessionRef>>((ref) async {
  final api = ref.watch(apiProvider);
  if (api == null) throw ApiException('还没选设备', kind: 'network');
  final sessions = await api.sessions('');
  return sessions
      .map((s) => SessionRef(workspaceId: null, session: s))
      .toList(growable: false);
});

// ── 任务 ────────────────────────────────────────────────────────────────

final cabinTasksProvider =
    FutureProvider.autoDispose.family<List<TaskItem>, String>((ref, cabinId) async {
  final api = ref.watch(apiProvider);
  if (api == null) throw ApiException('还没选设备', kind: 'network');
  return api.tasks(cabinId: cabinId);
});

final taskDetailProvider =
    FutureProvider.autoDispose.family<TaskItem, String>((ref, taskId) async {
  final api = ref.watch(apiProvider);
  if (api == null) throw ApiException('还没选设备', kind: 'network');
  return api.task(taskId);
});
