import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

import 'http.dart';
import 'models/cabin.dart';
import 'models/chat.dart';
import 'models/sse.dart';
import 'models/task.dart';
import 'models/telemetry.dart';

/// 一台设备上的 Octopus REST/SSE。所有端点都在桌面壳 sidecar（47820）上，
/// 经 `tailscale serve` 换成 HTTPS；开发时也可直连 `pnpm dev` 的 3001。
class OctopusApi {
  /// 业务请求始终带一个 Bearer：`/api/agent/*` 的闸只检查头是否存在（与桌面
  /// web 的 `Bearer agent` 同款）。没配对时用 `mobile` —— 回环直连（adb reverse /
  /// 本机）能读能发；远程连接仍会被设备令牌闸 401，页面据此提示补配对码。
  OctopusApi(this.baseUrl, {String? token, Dio? dio})
    : _dio =
          dio ??
          createApiDio(
            baseUrl,
            token: (token == null || token.isEmpty) ? 'mobile' : token,
          );

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
    final items =
        (map['attention'] as List?)
            ?.whereType<Map>()
            .map((e) => AttentionItem.fromJson(e.cast<String, dynamic>()))
            .toList(growable: false) ??
        const <AttentionItem>[];
    return CabinDetail(
      cabin: const Cabin(id: '', name: '', path: '', status: ''),
      attention: items,
      health: CabinHealth.fromJson(
        (map['health'] as Map?)?.cast<String, dynamic>(),
      ),
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

  Future<ChatSession> createSession(
    String? workspaceId, {
    String? title,
  }) async {
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
      final resp = await _dio.delete<dynamic>(
        '${_sessionsPath(workspaceId)}/$sessionId',
      );
      _unwrap(resp);
    } on DioException catch (e) {
      throw describeDioError(e);
    }
  }

  // ── 舱会话（agent sessions）────────────────────────────────────────
  //
  // 舱主会话与任务线程都在 `sessions` 表，走 /api/agent；上面那组 chat/sessions
  // 是旧的自由聊天域（chat_sessions 表），舱里根本没有行。

  Future<ChatSession> agentSession(String sessionId, {int limit = 100}) async {
    final data = await _getJson(
      '/api/agent/sessions/$sessionId',
      query: {'limit': '$limit'},
    );
    if (data is! Map) throw ApiException('会话返回格式不对', kind: 'parse');
    return ChatSession.fromAgentJson(data.cast<String, dynamic>());
  }

  Future<ChatSession> createAgentSession(String workspaceId) async {
    final data = await _postJson(
      '/api/agent/sessions',
      body: {'workspace_id': workspaceId},
    );
    if (data is! Map) throw ApiException('新会话返回格式不对', kind: 'parse');
    return ChatSession.fromAgentJson(data.cast<String, dynamic>());
  }

  /// 舱会话发消息：POST 响应体内联 SSE（与桌面主对话同一条管道）。
  ///
  /// `model` / `effort` / `maxContext` 是通讯台的模型设置（服务端原样解析成
  /// SDK 选项）；`subagents` 是「委派 · 一次性」，随这一条消息发出。
  Stream<SseEvent> sendAgentMessage({
    required String sessionId,
    required String content,
    String? model,
    String? effort,
    String? maxContext,
    List<ChatSubagentRef> subagents = const [],
    CancelToken? cancelToken,
  }) {
    return _sse(
      () => _dio.post<ResponseBody>(
        '/api/agent/sessions/$sessionId/chat',
        data: {
          'message': content,
          'session_id': sessionId,
          if (model != null && model.isNotEmpty) 'model': model,
          if (effort != null && effort.isNotEmpty) 'effort': effort,
          if (maxContext != null && maxContext.isNotEmpty)
            'maxContext': maxContext,
          if (subagents.isNotEmpty)
            'subagents': [
              for (final s in subagents) {'id': s.id, 'label': s.label},
            ],
        },
        cancelToken: cancelToken,
        options: Options(
          responseType: ResponseType.stream,
          headers: {'Accept': 'text/event-stream'},
          receiveTimeout: const Duration(minutes: 30),
        ),
      ),
    );
  }

  // ── 通讯台遥测（原型 E3–E9）─────────────────────────────────────

  /// 当前会话身份（星核 · 分身）。
  Future<SessionRole> sessionRole(String sessionId) async {
    final data = await _getJson('/api/agent/sessions/$sessionId/role');
    if (data is! Map) throw ApiException('身份返回格式不对', kind: 'parse');
    return SessionRole.fromJson(data.cast<String, dynamic>());
  }

  /// 切身份；`expert` 传 null = 回主 Agent。
  Future<SessionRole> setSessionRole(String sessionId, String? expert) async {
    final data = await _putJson(
      '/api/agent/sessions/$sessionId/role',
      body: {'expert': expert},
    );
    if (data is! Map) throw ApiException('身份返回格式不对', kind: 'parse');
    return SessionRole.fromJson(data.cast<String, dynamic>());
  }

  /// 会话账本：逐 call 行（轮次归属）+ 整本聚合（tok 芯片 / 明细抽屉）。
  Future<({SessionUsage usage, List<LlmCallRow> rows})> sessionLedger(
    String sessionId,
  ) async {
    final data = await _getJson('/api/sessions/$sessionId/llm-calls');
    if (data is! Map) throw ApiException('账本返回格式不对', kind: 'parse');
    final map = data.cast<String, dynamic>();
    final rawRows = map['data'];
    final rows = rawRows is List
        ? rawRows
              .whereType<Map>()
              .map((e) => LlmCallRow.fromJson(e.cast<String, dynamic>()))
              .toList(growable: false)
        : const <LlmCallRow>[];
    return (usage: SessionUsage.fromAggregates(map['aggregates']), rows: rows);
  }

  /// 舱账本（tok 抽屉底部的「本舱账本 · 去看看」）。
  Future<SessionUsage> cabinUsage(String cabinId) async {
    final data = await _getJson('/api/cabins/$cabinId/usage');
    if (data is! Map) throw ApiException('舱账本返回格式不对', kind: 'parse');
    final map = data.cast<String, dynamic>();
    // 舱账本的「全域累计」在 grand；老服务没有就退回 summary。
    return SessionUsage.fromAggregates(map['grand'] ?? map['summary']);
  }

  Future<List<SkillInfo>> skills() async {
    final data = await _getJson('/api/agent/skills');
    final list = data is Map ? data['items'] : data;
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((e) => SkillInfo.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<List<CloneRef>> clones() async {
    final data = await _getJson('/api/clones');
    final list = data is Map ? data['clones'] : data;
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((e) => CloneRef.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<List<McpServerInfo>> mcpServers() async {
    final data = await _getJson('/api/agent/mcp/servers');
    final list = data is Map ? data['servers'] : data;
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((e) => McpServerInfo.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false);
  }

  /// 重命名会话（星核 · 会话）。
  Future<void> renameAgentSession(String sessionId, String title) async {
    await _putJson('/api/agent/sessions/$sessionId', body: {'title': title});
  }

  /// CLI 在 `system:init` 里广播过的斜杠命令（进程内缓存，重启后为空）。
  Future<List<String>> slashCommands(String sessionId) async {
    try {
      final data = await _getJson(
        '/api/agent/sessions/$sessionId/slash-commands',
      );
      final list = data is Map ? data['commands'] : data;
      if (list is! List) return const [];
      return list.whereType<String>().toList(growable: false);
    } on ApiException {
      return const [];
    }
  }

  /// 舱内登记过的会话（委派 / 用户自开会话）。老服务没有这条路由就返回空。
  Future<List<CabinSessionRef>> cabinDelegations(String cabinId) async {
    try {
      final data = await _getJson('/api/cabins/$cabinId/delegations');
      final list = data is Map ? data['delegations'] : data;
      if (list is! List) return const [];
      return list
          .whereType<Map>()
          .map((e) => CabinSessionRef.fromJson(e.cast<String, dynamic>()))
          .toList(growable: false);
    } on ApiException {
      return const [];
    }
  }

  /// 新开的舱会话向舱登记（origin=user）—— 桌面舱里才看得见这条。
  Future<void> registerCabinSession(
    String cabinId,
    String sessionId, {
    String? title,
  }) async {
    try {
      await _postJson(
        '/api/cabins/$cabinId/delegations/register',
        body: {
          'session_id': sessionId,
          if (title != null && title.trim().isNotEmpty) 'title': title,
        },
      );
    } on ApiException {
      // 老服务没有登记口：会话本身已经建好，不因此判失败。
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
  Stream<SseEvent> workspaceEvents(
    String workspaceId, {
    CancelToken? cancelToken,
  }) {
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

  Stream<SseEvent> _sse(
    Future<Response<ResponseBody>> Function() request,
  ) async* {
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

  Future<dynamic> _putJson(String path, {Object? body}) async {
    try {
      final resp = await _dio.put<dynamic>(path, data: body ?? const {});
      return _unwrap(resp);
    } on DioException catch (e) {
      throw describeDioError(e);
    }
  }

  dynamic _unwrap(Response<dynamic> resp) {
    final code = resp.statusCode ?? 0;
    if (code == 401 || code == 403) {
      throw ApiException(
        '设备令牌失效，需要重新配对',
        statusCode: code,
        kind: 'unauthorized',
      );
    }
    if (code >= 400) {
      throw ApiException(
        _messageFromText(resp.data, code),
        statusCode: code,
        kind: 'http',
      );
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
    if (data is String && data.trim().isNotEmpty && data.length < 400) {
      return data.trim();
    }
    return '请求失败（HTTP $code）';
  }
}
