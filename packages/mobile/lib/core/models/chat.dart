import 'dart:convert';

import 'telemetry.dart';

/// 会话（与 server services/chat.ts 的 ChatSession 对齐）。
class ChatSession {
  const ChatSession({
    required this.id,
    required this.workspaceId,
    required this.createdAt,
    required this.updatedAt,
    this.title,
    this.isActive = true,
    this.provider = 'claude',
    this.providerSessionId,
    this.messages = const [],
    this.totalMessageCount = 0,
    this.contextUsage,
  });

  final String id;
  final String workspaceId;
  final String? title;
  final bool isActive;
  final String provider;
  final String? providerSessionId;
  final String createdAt;
  final String updatedAt;
  final List<ChatMessage> messages;
  final int totalMessageCount;

  /// 通讯台头的 ctx 芯片（agent 会话才有；旧 chat 域为 null）。
  final ContextUsage? contextUsage;

  String get displayTitle {
    final t = title?.trim();
    if (t == null || t.isEmpty) return '新会话';
    // v5 建舱时主会话标题落成「undefined · 舱主对话」；服务端会在舱起名后
    // 纠正一次，但历史行可能还留着占位名 —— 手机上不把 undefined 画给人看。
    return t.replaceFirst(RegExp(r'^undefined\s*·\s*'), '');
  }

  factory ChatSession.fromJson(Map<String, dynamic> json) {
    final rawMessages = json['messages'];
    return ChatSession(
      id: json['id'] as String,
      workspaceId: (json['workspaceId'] as String?) ?? '',
      title: json['title'] as String?,
      isActive: json['isActive'] as bool? ?? true,
      provider: (json['provider'] as String?) ?? 'claude',
      providerSessionId: json['providerSessionId'] as String?,
      createdAt: (json['createdAt'] as String?) ?? '',
      updatedAt: (json['updatedAt'] as String?) ?? '',
      messages: rawMessages is List
          ? rawMessages
                .whereType<Map>()
                .map((e) => ChatMessage.fromJson(e.cast<String, dynamic>()))
                .toList(growable: false)
          : const [],
      totalMessageCount: (json['totalMessageCount'] as num?)?.toInt() ?? 0,
    );
  }

  /// 舱会话走 `GET /api/agent/sessions/:id`：行本身是 snake_case，
  /// `messages` 是 `{items, total, has_more}`，一条 assistant 行里装着
  /// `thinking` / `tool_calls` / 正文。这里摊平成 TUI 的一行一条。
  factory ChatSession.fromAgentJson(Map<String, dynamic> json) {
    final raw = json['messages'];
    final rows = <ChatMessage>[];
    var total = 0;
    if (raw is Map) {
      final items = raw['items'];
      total =
          (raw['total'] as num?)?.toInt() ?? (items is List ? items.length : 0);
      if (items is List) {
        for (final item in items.whereType<Map>()) {
          rows.addAll(_agentMessageRows(item.cast<String, dynamic>()));
        }
      }
    }
    final isActiveRaw = json['is_active'];
    final rawContext = json['context_usage'];
    return ChatSession(
      id: (json['id'] as String?) ?? '',
      workspaceId:
          (json['workspaceId'] as String?) ??
          (json['workspace_id'] as String?) ??
          '',
      title: json['title'] as String?,
      isActive:
          (json['isActive'] as bool?) ??
          (isActiveRaw is bool ? isActiveRaw : isActiveRaw != 0),
      provider: (json['provider'] as String?) ?? 'claude',
      providerSessionId:
          (json['providerSessionId'] as String?) ??
          (json['provider_session_id'] as String?),
      createdAt:
          (json['createdAt'] as String?) ??
          (json['created_at'] as String?) ??
          '',
      updatedAt:
          (json['updatedAt'] as String?) ??
          (json['updated_at'] as String?) ??
          (json['last_message_at'] as String?) ??
          '',
      messages: rows,
      totalMessageCount: total > 0 ? total : rows.length,
      contextUsage: rawContext is Map
          ? ContextUsage.fromJson(rawContext.cast<String, dynamic>())
          : null,
    );
  }

  /// 一条 agent 消息 → TUI 行：thinking 一行、每个 tool 一行、正文一行。
  /// 用户 / 系统消息保持单行。
  static List<ChatMessage> _agentMessageRows(Map<String, dynamic> m) {
    final id = (m['id'] as String?) ?? '';
    final sessionId =
        (m['sessionId'] as String?) ?? (m['session_id'] as String?) ?? '';
    final role = (m['role'] as String?) ?? 'assistant';
    final createdAt =
        (m['createdAt'] as String?) ?? (m['created_at'] as String?) ?? '';
    final content = (m['content'] as String?) ?? '';
    final metadata =
        _decodeMetadata(m['metadata']) ?? const <String, dynamic>{};

    if (role == 'user' || role == 'system') {
      if (content.trim().isEmpty) return const [];
      return [
        ChatMessage(
          id: id,
          sessionId: sessionId,
          role: role,
          type: 'text',
          content: content,
          createdAt: createdAt,
          meta: {
            ...metadata,
            'displayType': (metadata['displayType'] as String?) ?? role,
          },
        ),
      ];
    }

    final rows = <ChatMessage>[];
    final thinking = (m['thinking'] as String?)?.trimRight() ?? '';
    final tools = m['tool_calls'];
    // 落库的提问卡：metadata 带 displayType=ask_user_question + questions，
    // tool_calls 里还会留一条 AskUserQuestion —— 有 metadata 时不再重复画工具行。
    final askFromMeta = metadata['questions'];
    final hasAskMetadata = askFromMeta is List && askFromMeta.isNotEmpty;

    /// 一条 tool_calls → 一行过程（提问工具长成提问卡）。跳过时返回 null。
    ChatMessage? processRow(Map<String, dynamic> tc, int index) {
      final status = (tc['status'] as String?) ?? 'result';
      final name = (tc['name'] as String?) ?? 'tool';
      if (name == 'AskUserQuestion' && hasAskMetadata) return null;
      final isAsk = name == 'AskUserQuestion';
      final input = tc['input'];
      return ChatMessage(
        id: '${tc['id'] ?? '$id-tool-$index'}',
        sessionId: sessionId,
        role: 'assistant',
        type: isAsk ? 'text' : 'tool_call',
        content: '',
        createdAt: createdAt,
        meta: {
          'displayType': isAsk ? 'ask_user_question' : 'tool_call',
          'toolName': name,
          'toolInput': input,
          'toolResult': tc['result'],
          if (isAsk) 'questions': input is Map ? input['questions'] : null,
          'toolStatus': switch (status) {
            'fail' => 'error',
            'start' => 'running',
            _ => 'done',
          },
          'sourceId': id,
        },
      );
    }

    // 服务端在 metadata.timeline 里按到达顺序记着 think 段 / 工具 / 正文段。
    // 有它就先按它排：thinking 不能被一律提到工具前面（桌面 TuiMeta 同一口径）。
    final timeline = metadata['timeline'];
    final timed =
        timeline is List &&
        timeline.whereType<Map>().any(
          (e) => e['kind'] == 'thinking' || e['kind'] == 'tool',
        );

    if (timed) {
      final byId = <String, Map<String, dynamic>>{};
      if (tools is List) {
        for (final tool in tools.whereType<Map>()) {
          final tc = tool.cast<String, dynamic>();
          final tid = (tc['id'] as String?) ?? '';
          if (tid.isNotEmpty) byId[tid] = tc;
        }
      }
      var toolIndex = 0;
      var thinkIndex = 0;
      for (final entry in timeline.whereType<Map>()) {
        final kind = entry['kind'];
        if (kind == 'thinking') {
          final text = ((entry['text'] as String?) ?? '').trimRight();
          if (text.trim().isEmpty) continue;
          rows.add(
            ChatMessage(
              id: '$id-th-${thinkIndex++}',
              sessionId: sessionId,
              role: 'assistant',
              type: 'thinking',
              content: '',
              createdAt: createdAt,
              meta: {
                'displayType': 'thinking',
                'thinkingContent': text,
                'sourceId': id,
              },
            ),
          );
        } else if (kind == 'tool') {
          final tc = byId[(entry['id'] as String?) ?? ''];
          if (tc == null) continue;
          final row = processRow(tc, toolIndex++);
          if (row != null) rows.add(row);
        }
        // kind == 'text'：正文由消息 content 整段画，过程里不重复。
      }
    } else {
      // 老行没有时间线：退回「thinking 一段 + 工具若干」。
      if (thinking.trim().isNotEmpty) {
        rows.add(
          ChatMessage(
            id: '$id-thinking',
            sessionId: sessionId,
            role: 'assistant',
            type: 'thinking',
            content: '',
            createdAt: createdAt,
            meta: {
              'displayType': 'thinking',
              'thinkingContent': thinking,
              'sourceId': id,
            },
          ),
        );
      }
      if (tools is List) {
        var index = 0;
        for (final tool in tools.whereType<Map>()) {
          final row = processRow(tool.cast<String, dynamic>(), index++);
          if (row != null) rows.add(row);
        }
      }
    }

    if (content.trim().isNotEmpty || metadata.isNotEmpty) {
      rows.add(
        ChatMessage(
          id: id,
          sessionId: sessionId,
          role: 'assistant',
          type: 'text',
          content: content,
          createdAt: createdAt,
          meta: {
            ...metadata,
            'displayType': (metadata['displayType'] as String?) ?? 'text',
            'sourceId': id,
          },
        ),
      );
    }
    return rows;
  }
}

/// 一条会话消息。`metadata` 在 wire 上是 JSON 字符串，这里解开成 Map 方便渲染。
class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.sessionId,
    required this.role,
    required this.type,
    required this.content,
    required this.createdAt,
    this.meta,
  });

  final String id;
  final String sessionId;
  final String role;
  final String type;
  final String content;
  final String createdAt;
  final Map<String, dynamic>? meta;

  String get displayType => (meta?['displayType'] as String?) ?? type;
  bool get isUser => role == 'user';
  bool get isEvent => displayType == 'event';

  /// agent 消息摊平后，从思考 / 工具 / 正文行都能追回原 assistant 消息 id
  /// （轮次统计与折叠块归属用）。
  String get sourceId => (meta?['sourceId'] as String?) ?? id;

  /// 本轮被「停止」截断（服务端 metadata.interrupted）。
  bool get interrupted => meta?['interrupted'] == true;

  /// 本轮运行失败（服务端 metadata.error = { code, message }）。
  String? get errorMessage {
    final error = meta?['error'];
    if (error is Map) return error['message'] as String?;
    return null;
  }

  String? get thinkingContent => meta?['thinkingContent'] as String?;
  String? get thinkingDuration => meta?['thinkingDuration'] as String?;

  String? get toolName => meta?['toolName'] as String?;
  String? get toolInputText {
    final input = meta?['toolInput'];
    if (input == null) return null;
    if (input is String) return input;
    try {
      return jsonEncode(input);
    } catch (_) {
      return input.toString();
    }
  }

  /// 工具返回原文（服务端 `tool_calls[].result`）。没有就只画 input。
  String? get toolResultText {
    final result = meta?['toolResult'];
    if (result == null) return null;
    if (result is String) return result;
    try {
      return jsonEncode(result);
    } catch (_) {
      return result.toString();
    }
  }

  String get toolStatus => (meta?['toolStatus'] as String?) ?? 'done';
  String? get toolDuration => meta?['toolDuration'] as String?;

  /// 提问卡的题目：metadata.questions 优先，其次工具入参里的 questions。
  /// 老数据 / 流式事件两种形状都宽容读。
  Object? get questions {
    final map = meta;
    if (map == null) return null;
    final direct = map['questions'];
    if (direct != null) return direct;
    final input = map['toolInput'];
    if (input is Map) return input['questions'];
    if (input is String) {
      try {
        final decoded = jsonDecode(input);
        if (decoded is Map) return decoded['questions'];
      } catch (_) {
        // 工具入参不是 JSON：没有题目可读。
      }
    }
    return null;
  }

  Map<String, dynamic>? get usage =>
      (meta?['usage'] as Map?)?.cast<String, dynamic>();
  double? get costUsd => (meta?['costUsd'] as num?)?.toDouble();

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
    id: (json['id'] as String?) ?? '',
    sessionId: (json['sessionId'] as String?) ?? '',
    role: (json['role'] as String?) ?? 'assistant',
    type: (json['type'] as String?) ?? 'text',
    content: (json['content'] as String?) ?? '',
    createdAt: (json['createdAt'] as String?) ?? '',
    meta: _decodeMetadata(json['metadata']),
  );
}

/// wire 上的 metadata 是 JSON 字符串；宽容读，坏数据不拖垮整条会话。
Map<String, dynamic>? _decodeMetadata(Object? raw) {
  if (raw == null) return null;
  if (raw is Map) return raw.cast<String, dynamic>();
  if (raw is String && raw.trim().isNotEmpty && raw != 'null') {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) return decoded.cast<String, dynamic>();
    } catch (_) {
      // 宽容读：坏 metadata 不拖垮整条会话
    }
  }
  return null;
}

/// 一段正在流式输出的回合（SSE chunk 累积出来的临时态，不落库）。
class LiveTurn {
  String text = '';
  String thinking = '';
  bool thinkingDone = false;
  String? thinkingDuration;
  final List<LiveTool> tools = [];

  /// 过程按到达顺序（think 段 / 工具交替）—— 服务端 SSE 就是按这个顺序发的，
  /// 渲染时照原样排，不能把 thinking 一律提到工具前面。
  final List<LiveProcessItem> process = [];

  int? numTurns;
  int inputTokens = 0;
  int outputTokens = 0;
  int cacheReadTokens = 0;
  int cacheCreationTokens = 0;
  double? costUsd;

  bool started = false;
  bool done = false;
  String? errorMessage;
  String? errorCode;

  /// 本轮起点：工作行的计时与洗牌种子都从这里来（空 = 还没开始）。
  DateTime? startedAt;

  bool get hasAnything =>
      started ||
      text.isNotEmpty ||
      thinking.isNotEmpty ||
      tools.isNotEmpty ||
      errorMessage != null;

  /// 渲染用的过程列表：正常来自 [process]；直接构造出来的 LiveTurn（测试 /
  /// 老状态）退回「thinking 一段 + 工具若干」。
  List<LiveProcessItem> get processItems {
    if (process.isNotEmpty) return process;
    return [
      if (thinking.trim().isNotEmpty) LiveProcessItem.thinking(thinking),
      for (final tool in tools) LiveProcessItem.tool(tool.id),
    ];
  }

  /// 追加一段 thinking：紧挨着的合并成一段，中间夹过工具就另起一段。
  void appendThinking(String delta) {
    thinking += delta;
    if (process.isNotEmpty && process.last.kind == 'thinking') {
      process.last.text += delta;
    } else {
      process.add(LiveProcessItem.thinking(delta));
    }
  }

  /// 工具第一次出现时记进过程时间线（幂等）。
  void markTool(String id) {
    if (id.isEmpty) return;
    if (process.any((item) => item.kind == 'tool' && item.toolId == id)) return;
    process.add(LiveProcessItem.tool(id));
  }

  int get totalTokens =>
      inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  void applyUsage(Map<String, dynamic>? usage) {
    if (usage == null) return;
    int n(String camel) => (usage[camel] as num?)?.toInt() ?? 0;
    final nextIn = n('inputTokens');
    final nextOut = n('outputTokens');
    final nextRead = n('cacheReadTokens');
    final nextCreate = n('cacheCreationTokens');
    if (nextIn > inputTokens) inputTokens = nextIn;
    if (nextOut > outputTokens) outputTokens = nextOut;
    if (nextRead > cacheReadTokens) cacheReadTokens = nextRead;
    if (nextCreate > cacheCreationTokens) cacheCreationTokens = nextCreate;
  }
}

class LiveTool {
  LiveTool({
    required this.id,
    required this.name,
    this.inputText,
    this.resultText,
    this.status = 'running',
    this.duration,
  });

  final String id;
  final String name;
  String? inputText;
  String? resultText;
  String status;
  String? duration;
}

/// 运行中的一条过程：一段 thinking 或一次工具调用，按到达顺序排。
class LiveProcessItem {
  LiveProcessItem.thinking(this.text) : kind = 'thinking', toolId = null;
  LiveProcessItem.tool(this.toolId) : kind = 'tool', text = '';

  /// `thinking` / `tool`。
  final String kind;
  String text;
  final String? toolId;
}
