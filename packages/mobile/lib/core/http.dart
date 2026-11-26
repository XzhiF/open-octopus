import 'package:dio/dio.dart';

import 'models/device.dart';

/// 统一的错误面：UI 只认 [kind] 与 [message]，不直接摸 DioException。
class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.kind = 'unknown'});

  final String message;
  final int? statusCode;

  /// network（连不上）· timeout · http（服务端 4xx/5xx）· unauthorized · parse · notReady
  final String kind;

  bool get isNetwork => kind == 'network' || kind == 'timeout';

  @override
  String toString() => 'ApiException($kind, $statusCode): $message';
}

ApiException describeDioError(DioException e) {
  switch (e.type) {
    case DioExceptionType.connectionTimeout:
    case DioExceptionType.sendTimeout:
    case DioExceptionType.receiveTimeout:
      return ApiException('连接超时 —— 电脑开着吗？在同一 Tailscale 网络里吗？', kind: 'timeout');
    case DioExceptionType.badCertificate:
      return ApiException('证书校验失败：地址可能不是那台机器的 ts.net 域名', kind: 'network');
    case DioExceptionType.cancel:
      return ApiException('已取消', kind: 'cancel');
    case DioExceptionType.badResponse:
      final code = e.response?.statusCode;
      return ApiException(_messageFromBody(e.response?.data, code), statusCode: code);
    case DioExceptionType.connectionError:
    case DioExceptionType.transformTimeout:
    case DioExceptionType.unknown:
      return ApiException(_networkHint(e), kind: 'network');
  }
}

/// 任何异常 → 一句能给人看的话。
String describeError(Object error) {
  if (error is ApiException) return error.message;
  if (error is DioException) return describeDioError(error).message;
  return error.toString();
}

String _networkHint(DioException e) {
  final raw = e.message ?? '';
  if (raw.contains('Connection refused') || raw.contains('Failed host lookup')) {
    return '连不上 —— Octopus 没在跑，或者不在同一个 Tailscale 网络里';
  }
  return '连不上设备（网络不可达）';
}

String _messageFromBody(Object? data, int? statusCode) {
  if (data is Map) {
    final msg = data['message'] ?? data['error'];
    if (msg is String && msg.isNotEmpty) return msg;
  }
  if (data is String && data.trim().isNotEmpty && data.length < 400) return data.trim();
  return '请求失败（HTTP ${statusCode ?? '?'}）';
}

/// 业务请求用：接受 4xx 当正常响应体，交给上层判断。
Dio createApiDio(String baseUrl, {String? token}) {
  return Dio(BaseOptions(
    baseUrl: baseUrl,
    connectTimeout: const Duration(seconds: 8),
    receiveTimeout: const Duration(seconds: 30),
    sendTimeout: const Duration(seconds: 15),
    headers: {
      'Accept': 'application/json',
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
    },
    validateStatus: (code) => code != null && code < 600,
  ));
}

/// 探活：200 = 运行中；503 = 服务在但未就绪；其余/异常 = 离线。
Future<DeviceStatus> probeDevice(String baseUrl) async {
  final dio = Dio(BaseOptions(
    baseUrl: baseUrl,
    connectTimeout: const Duration(seconds: 4),
    receiveTimeout: const Duration(seconds: 5),
    validateStatus: (_) => true,
  ));
  try {
    final resp = await dio.get<dynamic>('/api/actuator/health');
    final code = resp.statusCode ?? 0;
    if (code == 200) return DeviceStatus.running;
    if (code == 503) return DeviceStatus.notReady;
    if (code == 401 || code == 403) return DeviceStatus.running;
    return DeviceStatus.offline;
  } catch (_) {
    return DeviceStatus.offline;
  } finally {
    dio.close(force: true);
  }
}
