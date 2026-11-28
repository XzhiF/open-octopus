import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 手机设备令牌的存储面（M3）。
///
/// 明文令牌只落**系统安全存储**（Android Keystore / iOS Keychain），不写
/// SharedPreferences、不进日志。UI 与 API 层读的是内存副本 —— 同步拿到，
/// 不必为了一个请求头改成异步链。
///
/// 抽象出接口是为了测试：单测用 [InMemoryTokenStore]，真机/模拟器用
/// [SecureTokenStore]。
abstract class TokenStore {
  /// 启动时读一次（真机上就是 readAll）。
  Future<void> init();

  String? tokenFor(String deviceId);

  Map<String, String> get all;

  Future<void> save(String deviceId, String token);

  Future<void> remove(String deviceId);
}

/// 系统安全存储实现。key 前缀 `octopus.token.<deviceId>`。
class SecureTokenStore implements TokenStore {
  SecureTokenStore([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  static const _prefix = 'octopus.token.';

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
  String? tokenFor(String deviceId) => _cache[deviceId];

  @override
  Map<String, String> get all => Map.unmodifiable(_cache);

  @override
  Future<void> save(String deviceId, String token) async {
    await _storage.write(key: '$_prefix$deviceId', value: token);
    _cache[deviceId] = token;
  }

  @override
  Future<void> remove(String deviceId) async {
    await _storage.delete(key: '$_prefix$deviceId');
    _cache.remove(deviceId);
  }
}

/// 测试 / 未配置安全存储时的兜底：只在进程内记忆。
///
/// 默认 provider 用它，`main()` 覆盖成 [SecureTokenStore]；单元测试不碰平台通道。
class InMemoryTokenStore implements TokenStore {
  InMemoryTokenStore([Map<String, String>? initial]) : _cache = {...?initial};

  final Map<String, String> _cache;

  @override
  Future<void> init() async {}

  @override
  String? tokenFor(String deviceId) => _cache[deviceId];

  @override
  Map<String, String> get all => Map.unmodifiable(_cache);

  @override
  Future<void> save(String deviceId, String token) async {
    _cache[deviceId] = token;
  }

  @override
  Future<void> remove(String deviceId) async {
    _cache.remove(deviceId);
  }
}
