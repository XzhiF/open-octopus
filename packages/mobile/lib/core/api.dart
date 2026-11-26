import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

import 'http.dart';
import 'models/cabin.dart';
import 'models/chat.dart';
import 'models/sse.dart';
import 'models/task.dart';

/// 一台设备上的 Octopus REST/SSE。所有端点都在桌面壳 sidecar（47820）上，
/// 经 `tailscale serve` 换成 HTTPS；开发时也可直连 `pnpm dev` 的 3001。
class OctopusApi {
  OctopusApi(this.baseUrl, {String? token, Dio? dio})
      : _dio = dio ?? createApiDio(baseUrl, token: token);

  final String baseUrl;
  final Dio _dio;

  void close() => _dio.close(force: true);

  // ── 舱 ─────────────────────────────────────────────────────────────

  Future<List<Cabin>> cabins() async {
    final data = await _getJson('/api/cabins');
    final list = (data is Map ? data['cabins'] : data) as List?;
    if (list == null) return const [];
    return list
        .whereType<Map>()
        .map((e) => Cabin.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<CabinDetail> cabin(String cabinId) async {
    final data = await _getJson('/api/cabins/$cabinId');
    if (data is! Map) throw ApiException('舱详情返回格式不对', kind: 'parse');
    return CabinDetail.fromJson(data.cast<String, dynamic>());
  }

  /// 只要 attention 与 health（舱列表角标用）。
  Future<CabinDetail> attention(String cabinId) async {
    final data = await _getJson('/api/cabins/$cabinId/attention');
    if (data is! Map) throw ApiException('attention 返回格式不对', kind: 'parse');
    final map = data.cast<String, dynamic>();
    final items = (map['attention'] as List?)
            ?.whereType<Map>()
            .map((e) => AttentionItem.fromJson(e.cast<String, dynamic>()))
            .toList(growable: false) ??
        const <AttentionItem>[];
    return CabinDetail(
      cabin: const Cabin(id: '', name: '', path: '', status: ''),
      attention: items,
      health: CabinHealth.fromJson((map['health'] as Map?)?.cast<String, dynamic>()),
    );
  }

  // ── 会话（舱 / 单独） ───────────────────────────────────────────────

  String _sessionsPath(String? workspaceId) => workspaceId == null
      ? '/api/chat/global/sessions'
      : '/api/workspaces/$workspaceId/chat/sessions';

  Future<List<ChatSession>> sessions(String? workspaceId) async {
    final data = await _getJson(_sessionsPath(workspaceId));
    final list = data is List ? data : (data is Map ? data['items'] : null);
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((e) => ChatSession.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<ChatSession> session(
    String? workspaceId,
    String sessionId, {
    int limit = 100,
  }) async {
    final data = await _getJson(
      '${_sessionsPath(workspaceId)}/$sessionId',
      query: {'limit': '$limit'},
    );
    if (data is! Map) throw ApiException('会话返回格式不对', kind: 'parse');
    return ChatSession.fromJson(data.cast<String, dynamic>());
  }

  Future<ChatSession> createSession(String? workspaceId, {String? title}) async {
    final data = await _postJson(
      _sessionsPath(workspaceId),
      body: title == null ? const {} : {'title': title},
    );
    if (data is! Map) throw ApiException('新会话返回格式不对', kind: 'parse');
    return ChatSession.fromJson(data.cast<String, dynamic>());
  }

  /// 删会话（手机端 v1 只在「单独会话」里用到；舱会话保持只读语义）。
  Future<void> deleteSession(String? workspaceId, String sessionId) async {
    try {
      final resp = await _dio.delete<dynamic>('${_sessionsPath(workspaceId)}/$sessionId');
      _unwrap(resp);
    } on DioException catch (e) {
      throw describeDioError(e);
    }
  }

  // ── 任务（只读） ────────────────────────────────────────────────────

  Future<List<TaskItem>> tasks({String? cabinId}) async {
    final data = await _getJson(
      '/api/tasks',
      query: cabinId == null ? null : {'cabin_id': cabinId},
    );
    final list = data is Map ? data['items'] : data;
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((e) => TaskItem.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<TaskItem> task(String taskId) async {
    final data = await _getJson('/api/tasks/$taskId');
    if (data is! Map) throw ApiException('任务返回格式不对', kind: 'parse');
    return TaskItem.fromJson(data.cast<String, dynamic>());
  }

  // ── SSE ────────────────────────────────────────────────────────────

  /// 发一条消息，响应体本身就是 SSE 流（不是另开订阅）。
  Stream<SseEvent> sendMessage({
    required String? workspaceId,
    required String sessionId,
    required String content,
    CancelToken? cancelToken,
  }) {
    return _sse(
      () => _dio.post<ResponseBody>(
        '${_sessionsPath(workspaceId)}/$sessionId/messages',
        data: {'content': content},
        cancelToken: cancelToken,
        options: Options(
          responseType: ResponseType.stream,
          headers: {'Accept': 'text/event-stream'},
          receiveTimeout: const Duration(minutes: 30),
        ),
      ),
    );
  }

  /// 工作区级事件（任务 / 会话状态变化）。global 会话没有这条通道。
  Stream<SseEvent> workspaceEvents(String workspaceId, {CancelToken? cancelToken}) {
    return _sse(
      () => _dio.get<ResponseBody>(
        '/api/workspaces/$workspaceId/events',
        cancelToken: cancelToken,
        options: Options(
          responseType: ResponseType.stream,
          headers: {'Accept': 'text/event-stream'},
          receiveTimeout: const Duration(minutes: 30),
        ),
      ),
    );
  }

  /// 舱级事件：`cabin_view`（attention 变脏）/ `cabin_status` / `tree_changed`，
  /// 30s 一条 heartbeat。手机端靠它即时刷新「待你定」，不轮询。
  Stream<SseEvent> cabinEvents(String cabinId, {CancelToken? cancelToken}) {
    return _sse(
      () => _dio.get<ResponseBody>(
        '/api/cabins/$cabinId/events',
        cancelToken: cancelToken,
        options: Options(
          responseType: ResponseType.stream,
          headers: {'Accept': 'text/event-stream'},
          receiveTimeout: const Duration(minutes: 30),
        ),
      ),
    );
  }

  Stream<SseEvent> _sse(Future<Response<ResponseBody>> Function() request) async* {
    Response<ResponseBody> resp;
    try {
      resp = await request();
    } on DioException catch (e) {
      throw describeDioError(e);
    }
    final code = resp.statusCode ?? 0;
    if (code >= 400) {
      final body = await _readAll(resp.data);
      throw ApiException(
        _messageFromText(body, code),
        statusCode: code,
        kind: code == 401 || code == 403 ? 'unauthorized' : 'http',
      );
    }
    final body = resp.data;
    if (body == null) return;

    final parser = SseParser();
    final decoded = const Utf8Decoder(allowMalformed: true).bind(body.stream);
    try {
      await for (final text in decoded) {
        for (final event in parser.add(text)) {
          yield event;
        }
      }
    } on DioException catch (e) {
      throw describeDioError(e);
    }
  }

  // ── 内部 ───────────────────────────────────────────────────────────

  Future<dynamic> _getJson(String path, {Map<String, dynamic>? query}) async {
    try {
      final resp = await _dio.get<dynamic>(path, queryParameters: query);
      return _unwrap(resp);
    } on DioException catch (e) {
      throw describeDioError(e);
    }
  }

  Future<dynamic> _postJson(String path, {Object? body}) async {
    try {
      final resp = await _dio.post<dynamic>(path, data: body ?? const {});
      return _unwrap(resp);
    } on DioException catch (e) {
      throw describeDioError(e);
    }
  }

  dynamic _unwrap(Response<dynamic> resp) {
    final code = resp.statusCode ?? 0;
    if (code == 401 || code == 403) {
      throw ApiException('设备令牌失效，需要重新配对', statusCode: code, kind: 'unauthorized');
    }
    if (code >= 400) {
      throw ApiException(_messageFromText(resp.data, code), statusCode: code, kind: 'http');
    }
    return resp.data;
  }

  static Future<String> _readAll(ResponseBody? body) async {
    if (body == null) return '';
    try {
      final bytes = <int>[];
      await for (final chunk in body.stream) {
        bytes.addAll(chunk);
        if (bytes.length > 64 * 1024) break;
      }
      return utf8.decode(bytes, allowMalformed: true);
    } catch (_) {
      return '';
    }
  }

  static String _messageFromText(Object? data, int code) {
    if (data is Map) {
      final msg = data['message'] ?? data['error'];
      if (msg is String && msg.isNotEmpty) return msg;
    }
    if (data is String && data.trim().isNotEmpty && data.length < 400) return data.trim();
    return '请求失败（HTTP $code）';
  }
}
