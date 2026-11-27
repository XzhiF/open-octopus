import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app/app.dart';
import 'core/providers.dart';
import 'core/remote_key_store.dart';
import 'core/storage.dart';
import 'core/token_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();

  // 设备令牌走系统安全存储；读失败（个别机型 Keystore 抽风）不阻塞启动，
  // 只是这次运行需要重新配对 —— 比开不了 App 好。
  final tokenStore = SecureTokenStore();
  try {
    await tokenStore.init();
  } catch (err) {
    debugPrint('令牌存储读取失败，本次按未配对处理: $err');
  }

  // M4 远程拉起的 SSH 私钥：同样只进系统安全存储。
  final remoteKeys = SecureRemoteKeyStore();
  try {
    await remoteKeys.init();
  } catch (err) {
    debugPrint('远程密钥读取失败，本次按「没有远程拉起」处理: $err');
  }

  runApp(
    ProviderScope(
      overrides: [
        storeProvider.overrideWithValue(Store(prefs)),
        tokenStoreProvider.overrideWithValue(tokenStore),
        remoteKeyStoreProvider.overrideWithValue(remoteKeys),
      ],
      child: const OctopusMobileApp(),
    ),
  );
}
