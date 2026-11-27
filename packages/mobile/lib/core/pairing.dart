import 'package:flutter/foundation.dart';
import 'package:dio/dio.dart';

import 'http.dart';

/// 配对兑换的结果：明文令牌只在这一刻拿到，之后只存在本机安全存储里。
///
/// M4：如果电脑装了「远程拉起」，响应里还会带一把受限的 SSH 私钥
/// （`ssh` 段）—— 它和设备令牌一样只进系统安全存储。
class PairResult {
  const PairResult({
    required this.token,
    required this.deviceId,
    required this.name,
    this.sshUser,
    this.sshPort,
    this.sshKey,
    this.sshSlot,
    this.remoteUnavailable,
  });

  final String token;
  final String deviceId;
  final String name;

  final String? sshUser;
  final int? sshPort;

  /// OpenSSH 私钥全文；null = 这台电脑没配远程拉起。
  final String? sshKey;
  final String? sshSlot;

  /// `not_installed` / `no_keys` / `unreadable` —— 只用于给一句人话。
  final String? remoteUnavailable;

  bool get hasRemote => sshKey != null && sshKey!.isNotEmpty;

  /// 远程拉起缺席的原因 → 一句能照做的话。
  String? get remoteHint => switch (remoteUnavailable) {
        'not_installed' =>
          '这台电脑还没装「远程拉起」——在电脑上以管理员运行 scripts/remote/install-remote.ps1，下次配对就能带上',
        'no_keys' => '远程拉起的密钥槽用完了 —— 在电脑上重跑一次安装器',
        'unreadable' => '远程拉起密钥读不出来 —— 在电脑上重跑一次安装器',
        _ => null,
      };
}

/// 用一次性 6 位码换长期设备令牌（`POST /api/pair/redeem`，鉴权闸外）。
///
/// 失败消息直接来自服务端：码过期 / 码错误次数过多 / 没有有效码 —— 都能原样给人看。
Future<PairResult> redeemPairCode(
  String baseUrl,
  String code, {
  String? name,
  String? platform,
  Dio? dio,
}) async {
  final client = dio ?? createApiDio(baseUrl);
  try {
    final resp = await client.post<dynamic>(
      '/api/pair/redeem',
      data: {
        'code': code.trim(),
        // M4：顺便换一把受限 SSH 密钥（电脑没装就只是少一样东西，配对照常成功）。
        'wants_remote': true,
        if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
        if (platform != null && platform.isNotEmpty) 'platform': platform,
      },
    );
    final status = resp.statusCode ?? 0;
    final data = resp.data;
    if (status == 200 && data is Map) {
      final token = data['token'];
      if (token is String && token.isNotEmpty) {
        final device = data['device'];
        final map = device is Map
            ? device.cast<String, dynamic>()
            : const <String, dynamic>{};

        final sshRaw = data['ssh'];
        final ssh = sshRaw is Map ? sshRaw.cast<String, dynamic>() : const <String, dynamic>{};
        final key = ssh['private_key'];
        final hasKey = key is String && key.contains('BEGIN OPENSSH PRIVATE KEY');

        return PairResult(
          token: token,
          deviceId: (map['id'] as String?) ?? '',
          name: (map['name'] as String?) ?? (name?.trim().isNotEmpty == true ? name!.trim() : '手机'),
          sshUser: hasKey && ssh['user'] is String ? ssh['user'] as String : null,
          sshPort: ssh['port'] is num ? (ssh['port'] as num).toInt() : null,
          sshKey: hasKey ? key : null,
          sshSlot: hasKey && ssh['slot'] is String ? ssh['slot'] as String : null,
          remoteUnavailable: data['ssh_unavailable'] is String ? data['ssh_unavailable'] as String : null,
        );
      }
      throw ApiException('配对返回格式不对', kind: 'parse', statusCode: status);
    }
    final message = data is Map ? (data['message'] ?? data['error']) : null;
    throw ApiException(
      message is String && message.isNotEmpty ? message : '配对失败（HTTP $status）',
      statusCode: status,
      kind: 'http',
    );
  } on DioException catch (e) {
    throw describeDioError(e);
  } finally {
    if (dio == null) client.close(force: true);
  }
}

/// 鉴权探针：`/api/cabins` 是鉴权闸内最轻的接口。
/// true = 现在的令牌（或回环直连）能用；false = 需要配对 / 令牌已失效。
/// 连不上等情况抛 [ApiException]。
Future<bool> probeAuthorized(String baseUrl, {String? token, Dio? dio}) async {
  final client = dio ?? createApiDio(baseUrl, token: token);
  try {
    final resp = await client.get<dynamic>('/api/cabins');
    final status = resp.statusCode ?? 0;
    if (status == 401 || status == 403) return false;
    return true;
  } on DioException catch (e) {
    throw describeDioError(e);
  } finally {
    if (dio == null) client.close(force: true);
  }
}

/// 配对时告诉电脑「这是什么设备」——只用于设置页展示。
String platformName() {
  switch (defaultTargetPlatform) {
    case TargetPlatform.android:
      return 'android';
    case TargetPlatform.iOS:
      return 'ios';
    case TargetPlatform.macOS:
      return 'macos';
    case TargetPlatform.windows:
      return 'windows';
    case TargetPlatform.linux:
      return 'linux';
    case TargetPlatform.fuchsia:
      return 'fuchsia';
  }
}
