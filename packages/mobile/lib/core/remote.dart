import 'dart:async';
import 'dart:convert';

import 'package:dartssh2/dartssh2.dart';

import 'http.dart';
import 'models/device.dart';

/// M4 · 远程拉起（2026-11-27）。
///
/// Octopus 的 server 嵌在桌面程序里 —— 程序没跑时，手机上没有任何监听者。
/// 但系统自带的 sshd 常驻，所以手机用配对时换来的那把受限密钥走 SSH，
/// 让 PC 上的 `octopus-ctl.ps1` 做两件小事：`status` / `start`。
///
/// 协议就一条命令、一份 JSON：
///   { "ok": true, "octopus": { "state": "running|starting|stopped", ... }, ... }
/// 脚本端对动词做白名单（见 scripts/remote/octopus-ctl.ps1），这边也只发这两个词。

enum RemoteVerb { status, start }

class RemoteException implements Exception {
  RemoteException(this.message);
  final String message;

  @override
  String toString() => message;
}

class RemoteShellResult {
  const RemoteShellResult({required this.stdout, this.exitCode});
  final String stdout;
  final int? exitCode;
}

/// SSH 的最小面：跑一个动词、拿回 stdout。测试用假实现。
abstract class RemoteShell {
  Future<RemoteShellResult> run({
    required String host,
    required int port,
    required String user,
    required String privateKey,
    required RemoteVerb verb,
  });
}

class SshRemoteShell implements RemoteShell {
  const SshRemoteShell({
    this.connectTimeout = const Duration(seconds: 6),
    this.runTimeout = const Duration(seconds: 15),
  });

  final Duration connectTimeout;
  final Duration runTimeout;

  @override
  Future<RemoteShellResult> run({
    required String host,
    required int port,
    required String user,
    required String privateKey,
    required RemoteVerb verb,
  }) async {
    SSHClient? client;
    try {
      final socket = await SSHSocket.connect(host, port, timeout: connectTimeout);
      // 安装器生成的是 ed25519 OpenSSH 私钥（无口令）。
      final keys = SSHKeyPair.fromPem(privateKey);
      client = SSHClient(socket, username: user, identities: keys);
      final result = await client.runWithResult(verb.name).timeout(runTimeout);
      return RemoteShellResult(
        stdout: utf8.decode(result.stdout, allowMalformed: true),
        exitCode: result.exitCode,
      );
    } on RemoteException {
      rethrow;
    } catch (err) {
      throw RemoteException('SSH $host:$port 连不上：${_short(err)}');
    } finally {
      try {
        await client?.close();
      } catch (_) {
        /* 已经断了就算了 */
      }
    }
  }

  static String _short(Object err) {
    final text = err.toString();
    return text.length <= 140 ? text : '${text.substring(0, 140)}…';
  }
}

/// octopus-ctl 的 JSON 投影（只取 App 用得到的字段）。
class RemoteStatusPayload {
  const RemoteStatusPayload({
    this.ok,
    this.state = 'unknown',
    this.pid,
    this.http,
    this.taskRegistered,
    this.result,
    this.error,
    this.message,
  });

  /// `start` 时是 already_running / started。
  final String? result;
  final bool? ok;
  final String state;
  final int? pid;
  final int? http;
  final bool? taskRegistered;
  final String? error;
  final String? message;

  bool get running => state == 'running';
  bool get starting => state == 'starting';
  bool get stopped => state == 'stopped';

  /// 从 stdout 里抠出 JSON（PowerShell 偶尔会在前面带一行横幅）。
  factory RemoteStatusPayload.parse(String stdout) {
    final text = stdout.trim();
    final start = text.indexOf('{');
    final end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw RemoteException('远程控制没有返回 JSON');
    }
    Object? decoded;
    try {
      decoded = jsonDecode(text.substring(start, end + 1));
    } catch (_) {
      throw RemoteException('远程控制返回的不是合法 JSON');
    }
    if (decoded is! Map) throw RemoteException('远程控制返回格式不对');
    final json = decoded.cast<String, dynamic>();

    final octopusRaw = json['octopus'];
    final octopus = octopusRaw is Map
        ? octopusRaw.cast<String, dynamic>()
        : const <String, dynamic>{};
    final detailsRaw = octopus['details'];
    final details = detailsRaw is Map
        ? detailsRaw.cast<String, dynamic>()
        : const <String, dynamic>{};
    final taskRaw = json['task'];
    final task = taskRaw is Map ? taskRaw.cast<String, dynamic>() : const <String, dynamic>{};

    return RemoteStatusPayload(
      ok: json['ok'] is bool ? json['ok'] as bool : null,
      state: octopus['state'] is String ? octopus['state'] as String : 'unknown',
      pid: details['pid'] is num ? (details['pid'] as num).toInt() : null,
      http: octopus['http'] is num ? (octopus['http'] as num).toInt() : null,
      taskRegistered: task['registered'] is bool ? task['registered'] as bool : null,
      result: json['result'] is String ? json['result'] as String : null,
      error: json['error'] is String ? json['error'] as String : null,
      message: json['message'] is String ? json['message'] as String : null,
    );
  }
}

/// HTTP 探活 + （可选）SSH 判定，合成三档设备状态。
///
/// 顺序有意为之：先走最轻的 health（3–4 秒），只有连不上时才多花一次 SSH，
/// 免得每次下拉刷新都为「在跑」的机器握手。
Future<DeviceStatus> probeDeviceStatus({
  required String baseUrl,
  String? sshUser,
  int? sshPort,
  String? privateKey,
  required RemoteShell shell,
  Future<DeviceStatus> Function(String baseUrl)? httpProbe,
}) async {
  final probe = httpProbe ?? probeDevice;
  final http = await probe(baseUrl);
  if (http == DeviceStatus.running || http == DeviceStatus.notReady) return http;
  if (http != DeviceStatus.offline) return http;
  if (sshUser == null || sshUser.isEmpty || privateKey == null || privateKey.isEmpty) {
    return DeviceStatus.offline;
  }
  final host = Uri.tryParse(baseUrl)?.host ?? '';
  if (host.isEmpty) return DeviceStatus.offline;

  try {
    final result = await shell.run(
      host: host,
      port: sshPort ?? 22,
      user: sshUser,
      privateKey: privateKey,
      verb: RemoteVerb.status,
    );
    final payload = RemoteStatusPayload.parse(result.stdout);
    if (payload.ok == false) return DeviceStatus.offline;
    if (payload.stopped) return DeviceStatus.onlineStopped;
    // 在跑 / 正在起：机器在线，只是 HTTP 这条路这次没通（比如 serve 配置）。
    return DeviceStatus.notReady;
  } catch (_) {
    return DeviceStatus.offline;
  }
}
