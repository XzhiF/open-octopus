/// 通讯台遥测（原型 E4–E9）：模型 / ctx / token / 轮次背后的真实数据结构。
///
/// 全部来自桌面端同一份服务端数据，不在这里造数：
/// - ctx：`GET /api/agent/sessions/:id` 的 `context_usage`（SDK 上报，冷启动是账本估算）
/// - token：`GET /api/sessions/:id/llm-calls` 的 `aggregates`（llm_calls 账本）
/// - 身份 / 技能 / 分身 / MCP：`role`、`/api/agent/skills`、`/api/clones`、`/api/agent/mcp/servers`
library;

/// 四类 token（入 / 出 / 缓存读 / 缓存写）。
class TokenUsage {
  const TokenUsage({
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.cacheReadTokens = 0,
    this.cacheCreationTokens = 0,
  });

  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int cacheCreationTokens;

  int get total =>
      inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  /// 缓存命中率 = cacheRead ÷ (input + cacheRead + cacheCreation)。
  /// 没有输入类 token → null（不造假 0%）。
  double? get cacheHitRate {
    final denom = inputTokens + cacheReadTokens + cacheCreationTokens;
    if (denom <= 0) return null;
    return cacheReadTokens / denom;
  }

  factory TokenUsage.fromJson(Object? raw) {
    if (raw is! Map) return const TokenUsage();
    int n(String key) => (raw[key] as num?)?.toInt() ?? 0;
    return TokenUsage(
      inputTokens: n('inputTokens'),
      outputTokens: n('outputTokens'),
      cacheReadTokens: n('cacheReadTokens'),
      cacheCreationTokens: n('cacheCreationTokens'),
    );
  }
}

/// 上下文窗口构成里的一格（System prompt / Tools / Messages …）。
class ContextCategory {
  const ContextCategory({
    required this.id,
    required this.name,
    required this.tokens,
    this.kind = 'used',
    this.isDeferred = false,
  });

  final String id;
  final String name;
  final int tokens;

  /// used / deferred / buffer —— 只有 used 是真占用，buffer 是压缩预留。
  final String kind;
  final bool isDeferred;

  factory ContextCategory.fromJson(Map<String, dynamic> json) =>
      ContextCategory(
        id: (json['id'] as String?) ?? '',
        name: (json['name'] as String?) ?? '',
        tokens: (json['tokens'] as num?)?.toInt() ?? 0,
        kind: (json['kind'] as String?) ?? 'used',
        isDeferred: json['isDeferred'] == true,
      );
}

/// SDK `context_usage` 的本机投影。
class ContextUsage {
  const ContextUsage({
    required this.totalTokens,
    required this.maxTokens,
    required this.rawMaxTokens,
    required this.percentage,
    this.categories = const [],
    this.model,
    this.estimated = false,
  });

  final int totalTokens;
  final int maxTokens;
  final int rawMaxTokens;

  /// 0–100 量纲（SDK 口径，不是 0–1）。
  final double percentage;
  final List<ContextCategory> categories;

  /// 实际上报的模型名（网关可能把别名映射成真实模型）。
  final String? model;

  /// 冷启动兜底估算（账本推算）—— UI 前面带 `~`。
  final bool estimated;

  int get availableTokens =>
      maxTokens > totalTokens ? maxTokens - totalTokens : 0;

  /// 50–100 的占用率夹紧，避免异常上报把进度条画出格。
  double get clampedPercentage =>
      percentage.isFinite ? percentage.clamp(0, 100).toDouble() : 0;

  /// 真占用（不含压缩预留 / 延后加载的工具定义）。
  List<ContextCategory> get usedCategories => categories
      .where((c) => c.kind == 'used' && !c.isDeferred)
      .toList(growable: false);

  factory ContextUsage.fromJson(Map<String, dynamic> json) {
    final rawCategories = json['categories'];
    final categories = rawCategories is List
        ? rawCategories
              .whereType<Map>()
              .map((e) => ContextCategory.fromJson(e.cast<String, dynamic>()))
              .toList(growable: false)
        : const <ContextCategory>[];
    final total = (json['totalTokens'] as num?)?.toInt() ?? 0;
    final maxTokens = (json['maxTokens'] as num?)?.toInt() ?? 0;
    final rawMax = (json['rawMaxTokens'] as num?)?.toInt() ?? maxTokens;
    final pct =
        (json['percentage'] as num?)?.toDouble() ??
        (maxTokens > 0 ? total / maxTokens * 100 : 0);
    return ContextUsage(
      totalTokens: total,
      maxTokens: maxTokens,
      rawMaxTokens: rawMax,
      percentage: pct,
      categories: categories,
      model: json['model'] as String?,
      estimated: json['estimated'] == true,
    );
  }
}

/// 按模型拆开的账本行。
class ModelUsage {
  const ModelUsage({
    required this.model,
    this.calls = 0,
    this.usage = const TokenUsage(),
    this.costUsd,
  });

  final String model;
  final int calls;
  final TokenUsage usage;
  final double? costUsd;

  factory ModelUsage.fromJson(String model, Map<String, dynamic> json) =>
      ModelUsage(
        model: model,
        calls: (json['calls'] as num?)?.toInt() ?? 0,
        usage: TokenUsage.fromJson(json),
        costUsd: (json['costUsd'] as num?)?.toDouble(),
      );
}

/// 会话账（`llm-calls` 的 aggregates）—— 通讯台 tok 芯片与明细抽屉的唯一来源。
class SessionUsage {
  const SessionUsage({
    this.totalCalls = 0,
    this.usage = const TokenUsage(),
    this.costUsd,
    this.costComplete = true,
    this.cacheHitRate,
    this.models = const [],
  });

  final int totalCalls;
  final TokenUsage usage;
  final double? costUsd;
  final bool costComplete;
  final double? cacheHitRate;
  final List<ModelUsage> models;

  int get tokens => usage.total;

  factory SessionUsage.fromAggregates(Object? raw) {
    if (raw is! Map) return const SessionUsage();
    final totals = (raw['totals'] as Map?)?.cast<String, dynamic>();
    final cost = (totals?['cost'] as Map?)?.cast<String, dynamic>();
    final breakdown = (raw['modelBreakdown'] as Map?)?.cast<String, dynamic>();
    final models = <ModelUsage>[];
    if (breakdown != null) {
      for (final entry in breakdown.entries) {
        final value = entry.value;
        if (value is Map) {
          models.add(
            ModelUsage.fromJson(entry.key, value.cast<String, dynamic>()),
          );
        }
      }
      models.sort((a, b) => b.usage.total.compareTo(a.usage.total));
    }
    return SessionUsage(
      totalCalls: (raw['totalCalls'] as num?)?.toInt() ?? 0,
      usage: TokenUsage.fromJson(raw['usage']),
      costUsd: (cost?['usd'] as num?)?.toDouble(),
      costComplete: cost?['complete'] as bool? ?? true,
      cacheHitRate: (totals?['cacheHitRate'] as num?)?.toDouble(),
      models: models,
    );
  }
}

/// 账本逐 call 行（轮次统计的归属单元）。
class LlmCallRow {
  const LlmCallRow({
    required this.timestamp,
    required this.durationMs,
    required this.usage,
    this.messageId,
    this.model,
    this.sourcePath,
    this.costUsd,
  });

  /// epoch ms。
  final int timestamp;
  final int durationMs;
  final TokenUsage usage;
  final String? messageId;
  final String? model;
  final String? sourcePath;
  final double? costUsd;

  factory LlmCallRow.fromJson(Map<String, dynamic> json) => LlmCallRow(
    timestamp: (json['timestamp'] as num?)?.toInt() ?? 0,
    durationMs: (json['duration_ms'] as num?)?.toInt() ?? 0,
    usage: TokenUsage(
      inputTokens: (json['input_tokens'] as num?)?.toInt() ?? 0,
      outputTokens: (json['output_tokens'] as num?)?.toInt() ?? 0,
      cacheReadTokens: (json['cache_read_tokens'] as num?)?.toInt() ?? 0,
      cacheCreationTokens:
          (json['cache_creation_tokens'] as num?)?.toInt() ?? 0,
    ),
    messageId: json['message_id'] as String?,
    model: json['model'] as String?,
    sourcePath: json['source_path'] as String?,
    costUsd: (json['cost_usd'] as num?)?.toDouble(),
  );
}

/// 一轮（一条用户消息 → 一段 assistant 回复）的统计行。
class TurnStats {
  const TurnStats({
    required this.durationMs,
    required this.calls,
    required this.usage,
    required this.costUsd,
    required this.costComplete,
    required this.models,
  });

  /// 无账本行 → 0（UI 不显示时长）。注意 0 也可能是真·瞬时，占比极小。
  final int durationMs;
  final int calls;
  final TokenUsage usage;
  final double? costUsd;
  final bool costComplete;
  final List<String> models;

  int get tokens => usage.total;
  double? get cacheHitRate => usage.cacheHitRate;

  bool get hasAnything => calls > 0;

  String get durationLabel {
    if (durationMs <= 0) return '';
    if (durationMs < 1000) return '${durationMs}ms';
    final seconds = (durationMs / 1000).round();
    if (seconds < 60) return '${seconds}s';
    final minutes = (seconds / 60).floor();
    final rest = seconds % 60;
    return rest == 0 ? '${minutes}m' : '${minutes}m${rest}s';
  }
}

// ── 星核：身份 / 技能 / 分身 / MCP ──────────────────────────────────

class CloneSkillRef {
  const CloneSkillRef({required this.name});

  final String name;
}

class CloneRef {
  const CloneRef({
    required this.name,
    required this.displayName,
    this.type = 'built-in',
    this.persona = '',
    this.skills = const [],
    this.memoryScope = 'isolated',
    this.status = 'active',
  });

  final String name;
  final String displayName;
  final String type;

  /// 人设摘要（前 200 字）—— 抽屉里只当一句副标题用。
  final String persona;
  final List<String> skills;
  final String memoryScope;
  final String status;

  factory CloneRef.fromJson(Map<String, dynamic> json) {
    final rawSkills = json['skills'];
    // role 接口的 clone 段用 `id` 作键；/api/clones 用 `name`。两处都要能读。
    final name =
        (json['name'] as String?) ??
        (json['id'] as String?) ??
        (json['display_name'] as String?) ??
        '';
    return CloneRef(
      name: name,
      displayName: (json['display_name'] as String?) ?? name,
      type: (json['type'] as String?) ?? 'built-in',
      persona: (json['persona'] as String?) ?? '',
      skills: rawSkills is List
          ? rawSkills.whereType<String>().toList(growable: false)
          : const [],
      memoryScope: (json['memory_scope'] as String?) ?? 'isolated',
      status: (json['status'] as String?) ?? 'active',
    );
  }
}

/// 当前会话身份（`GET/PUT /api/agent/sessions/:id/role`）。
class SessionRole {
  const SessionRole({
    this.activeExpert,
    this.activeKind,
    this.clone,
    this.revision = 0,
  });

  /// null = 主 Agent（基础身份）。
  final String? activeExpert;

  /// clone / expert / base。
  final String? activeKind;
  final CloneRef? clone;
  final int revision;

  bool get isMain => activeExpert == null || activeExpert!.isEmpty;

  String get label {
    if (isMain) return '主 Agent';
    return clone?.displayName ?? activeExpert ?? '主 Agent';
  }

  List<String> get skills => clone?.skills ?? const [];

  factory SessionRole.fromJson(Map<String, dynamic> json) {
    final rawClone = json['clone'];
    return SessionRole(
      activeExpert: json['active_expert'] as String?,
      activeKind: json['active_kind'] as String?,
      clone: rawClone is Map
          ? CloneRef.fromJson(rawClone.cast<String, dynamic>())
          : null,
      revision: (json['revision'] as num?)?.toInt() ?? 0,
    );
  }
}

class SkillInfo {
  const SkillInfo({
    required this.name,
    this.source = 'builtin',
    this.tokenCount = 0,
    this.hasBackup = false,
    this.lastModified,
  });

  final String name;

  /// builtin / local_evolved。
  final String source;
  final int tokenCount;
  final bool hasBackup;
  final String? lastModified;

  String get sourceLabel => source == 'local_evolved' ? '本地进化' : '内置';

  factory SkillInfo.fromJson(Map<String, dynamic> json) => SkillInfo(
    name: (json['name'] as String?) ?? '',
    source: (json['source'] as String?) ?? 'builtin',
    tokenCount: (json['token_count'] as num?)?.toInt() ?? 0,
    hasBackup: json['has_backup'] == true,
    lastModified: json['last_modified'] as String?,
  );
}

class McpServerInfo {
  const McpServerInfo({
    required this.server,
    required this.label,
    this.description = '',
    this.when = '',
    this.toolNames = const [],
  });

  final String server;
  final String label;
  final String description;

  /// 什么会话会挂载它（「会话绑定工作空间时挂载」）。
  final String when;
  final List<String> toolNames;

  factory McpServerInfo.fromJson(Map<String, dynamic> json) {
    final rawTools = json['tools'];
    return McpServerInfo(
      server: (json['server'] as String?) ?? '',
      label: (json['label'] as String?) ?? (json['server'] as String?) ?? 'MCP',
      description: (json['description'] as String?) ?? '',
      when: (json['when'] as String?) ?? '',
      toolNames: rawTools is List
          ? rawTools
                .whereType<Map>()
                .map((t) => (t['name'] as String?) ?? '')
                .where((n) => n.isNotEmpty)
                .toList(growable: false)
          : const [],
    );
  }
}

/// 一次性委派（随下一条消息发出，发送后自动摘掉）。
class ChatSubagentRef {
  const ChatSubagentRef({required this.id, required this.label});

  final String id;
  final String label;
}
