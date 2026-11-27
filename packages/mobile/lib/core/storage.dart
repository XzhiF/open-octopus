import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'models/device.dart';

/// 本机偏好与设备清单。全部留在手机本地，不跨设备同步。
class Store {
  Store(this.prefs);

  final SharedPreferences prefs;

  static const _kDevices = 'octopus.devices.v1';
  static const _kCurrent = 'octopus.currentDevice.v1';
  static const _kReduceMotion = 'octopus.reduceMotion.v1';
  static const _kCrewVideo = 'octopus.crewVideo.v2';
  static const _kLastSeenPrefix = 'octopus.lastSeen.';

  List<Device> loadDevices() {
    final raw = prefs.getString(_kDevices);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final list = jsonDecode(raw);
      if (list is! List) return const [];
      return list
          .whereType<Map>()
          .map((e) => Device.fromJson(e.cast<String, dynamic>()))
          .toList(growable: false);
    } catch (_) {
      return const [];
    }
  }

  Future<void> saveDevices(List<Device> devices) {
    return prefs.setString(
      _kDevices,
      jsonEncode(devices.map((d) => d.toJson()).toList(growable: false)),
    );
  }

  String? loadCurrentDeviceId() => prefs.getString(_kCurrent);

  Future<void> saveCurrentDeviceId(String? id) {
    if (id == null) return prefs.remove(_kCurrent);
    return prefs.setString(_kCurrent, id);
  }

  bool loadReduceMotion() => prefs.getBool(_kReduceMotion) ?? false;

  Future<void> saveReduceMotion(bool value) => prefs.setBool(_kReduceMotion, value);

  /// 立绘动画（带透明通道的 WebP）：默认开。没有可靠的静帧 —— 关掉就不画立绘。
  /// 键升到 v2：旧版默认是关，机器上存下的 false 多半是默认值而非选择，升级后统一按开。
  bool loadCrewVideo() => prefs.getBool(_kCrewVideo) ?? true;

  Future<void> saveCrewVideo(bool value) => prefs.setBool(_kCrewVideo, value);

  String? lastSeenOf(String deviceId) => prefs.getString('$_kLastSeenPrefix$deviceId');

  Future<void> touchLastSeen(String deviceId, DateTime at) {
    return prefs.setString('$_kLastSeenPrefix$deviceId', at.toIso8601String());
  }
}
