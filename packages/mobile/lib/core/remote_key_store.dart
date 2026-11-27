import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 远程拉起密钥的存储面（M4 · 2026-11-27）。
///
/// 配对时服务端下发一把 SSH 私钥（只能跑 octopus-ctl 的 status/start）。
/// 它和设备令牌一样只落**系统安全存储**；PC 上那一眼之后就删掉了。
///
/// 抽象出接口同样是为了测试：单测用 [InMemoryRemoteKeyStore]。
abstract class RemoteKeyStore {
  Future<void> init();

  String? keyFor(String deviceId);

  Future<void> save(String deviceId, String privateKey);

  Future<void> remove(String deviceId);
}

/// 系统安全存储实现。key 前缀 `octopus.sshkey.<deviceId>`。
class SecureRemoteKeyStore implements RemoteKeyStore {
  SecureRemoteKeyStore([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  static const _prefix = 'octopus.sshkey.';

  final FlutterSecureStorage _storage;
  final Map<String, String> _cache = {};

  @override
  Future<void> init() async {
    final stored = await _storage.readAll();
    _cache.clear();
    for (final entry in stored.entries) {
      if (entry.key.startsWith(_prefix)) {
        _cache[entry.key.substring(_prefix.length)] = entry.value;
      }
    }
  }

  @override
  String? keyFor(String deviceId) => _cache[deviceId];

  @override
  Future<void> save(String deviceId, String privateKey) async {
    await _storage.write(key: '$_prefix$deviceId', value: privateKey);
    _cache[deviceId] = privateKey;
  }

  @override
  Future<void> remove(String deviceId) async {
    await _storage.delete(key: '$_prefix$deviceId');
    _cache.remove(deviceId);
  }
}

/// 测试 / 未配置安全存储时的兜底：只在进程内记忆。
class InMemoryRemoteKeyStore implements RemoteKeyStore {
  InMemoryRemoteKeyStore([Map<String, String>? initial]) : _cache = {...?initial};

  final Map<String, String> _cache;

  @override
  Future<void> init() async {}

  @override
  String? keyFor(String deviceId) => _cache[deviceId];

  @override
  Future<void> save(String deviceId, String privateKey) async {
    _cache[deviceId] = privateKey;
  }

  @override
  Future<void> remove(String deviceId) async {
    _cache.remove(deviceId);
  }
}
