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
  static const _kCrewVideo = 'octopus.crewVideo.v1';
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

  /// 立绘走视频（VP9 alpha WebM）。默认关：真机解码支不支持 alpha 要 M0 spike 验过。
  bool loadCrewVideo() => prefs.getBool(_kCrewVideo) ?? false;

  Future<void> saveCrewVideo(bool value) => prefs.setBool(_kCrewVideo, value);

  String? lastSeenOf(String deviceId) => prefs.getString('$_kLastSeenPrefix$deviceId');

  Future<void> touchLastSeen(String deviceId, DateTime at) {
    return prefs.setString('$_kLastSeenPrefix$deviceId', at.toIso8601String());
  }
}
