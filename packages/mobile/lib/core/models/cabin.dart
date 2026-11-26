/// 舱（一个目录一个舱，长期存活）。DTO 与服务端 shared/types/cabin.ts 对齐。
class Cabin {
  const Cabin({
    required this.id,
    required this.name,
    required this.path,
    required this.status,
    this.workspaceId,
    this.mainSessionId,
    this.updatedAt,
    this.lastActiveAt,
    this.archivedAt,
  });

  final String id;
  final String name;
  final String path;
  final String status;
  final String? workspaceId;
  final String? mainSessionId;
  final String? updatedAt;
  final String? lastActiveAt;
  final String? archivedAt;

  factory Cabin.fromJson(Map<String, dynamic> json) => Cabin(
        id: json['id'] as String,
        name: (json['name'] as String?) ?? '',
        path: (json['path'] as String?) ?? '',
        status: (json['status'] as String?) ?? 'active',
        workspaceId: json['workspace_id'] as String?,
        mainSessionId: json['main_session_id'] as String?,
        updatedAt: json['updated_at'] as String?,
        lastActiveAt: json['last_active_at'] as String?,
        archivedAt: json['archived_at'] as String?,
      );
}

/// 待你定的 stage。`answer`（待你定）/ `start`（待入列·触发·恢复）/
/// `review`（待验收）/ `adjudicate`（待裁决）/ `approval`（待审批）/ `blocked`（受阻）。
enum AttentionStage {
  answer,
  start,
  review,
  adjudicate,
  approval,
  blocked,
  notice,
  unknown;

  static AttentionStage parse(String? raw) {
    switch (raw) {
      case 'answer':
        return AttentionStage.answer;
      case 'start':
        return AttentionStage.start;
      case 'review':
        return AttentionStage.review;
      case 'adjudicate':
        return AttentionStage.adjudicate;
      case 'approval':
        return AttentionStage.approval;
      case 'blocked':
        return AttentionStage.blocked;
      case 'notice':
        return AttentionStage.notice;
      default:
        return AttentionStage.unknown;
    }
  }

  /// 界面上的一档：待验收单独一色，其余归「待你定」。
  bool get isReview => this == AttentionStage.review;

  /// 列表排序：先「要你答 / 要你给一脚」，再验收类，最后受阻与知会。
  int get priority => switch (this) {
        AttentionStage.answer => 0,
        AttentionStage.start => 1,
        AttentionStage.adjudicate => 2,
        AttentionStage.review => 3,
        AttentionStage.approval => 4,
        AttentionStage.blocked => 5,
        AttentionStage.notice => 6,
        AttentionStage.unknown => 7,
      };

  String get label {
    switch (this) {
      case AttentionStage.answer:
        return '待你定';
      case AttentionStage.start:
        return '待放行';
      case AttentionStage.review:
        return '待验收';
      case AttentionStage.adjudicate:
        return '待裁决';
      case AttentionStage.approval:
        return '待审批';
      case AttentionStage.blocked:
        return '受阻';
      case AttentionStage.notice:
        return '提醒';
      case AttentionStage.unknown:
        return '待处理';
    }
  }
}

/// 决策票据里的一个选项（design 26 信封）。
class AskOption {
  const AskOption({required this.label, this.impact, this.description});

  final String label;
  final String? impact;
  final String? description;

  factory AskOption.fromJson(Map<String, dynamic> json) => AskOption(
        label: (json['label'] as String?) ?? '',
        impact: json['impact'] as String?,
        description: json['description'] as String?,
      );
}

/// 提问所属的 phase / 轮次（引用条上的「P2 · 第 2 轮」）。
class AskPhase {
  const AskPhase({this.index, this.round});

  final int? index;
  final int? round;

  bool get isEmpty => index == null && round == null;

  factory AskPhase.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const AskPhase();
    return AskPhase(
      index: (json['index'] as num?)?.toInt(),
      round: (json['round'] as num?)?.toInt(),
    );
  }
}

/// `stage=answer` 的提问信封（design 26 §4.1）。作者线程原卡只带最小字段，
/// 舱主会话的镜像卡最全；服务端已按完整度挑过一份。
class AskEnvelope {
  const AskEnvelope({
    required this.askId,
    this.messageId,
    this.authorSessionId,
    this.origin,
    this.decision,
    this.intent,
    this.options = const [],
    this.recommendationLabel,
    this.recommendationReason,
    this.blocking,
    this.phase = const AskPhase(),
  });

  final String askId;

  /// 舱主会话里镜像卡的 message.id —— 引用条据此在同一条会话里定位问题。
  final String? messageId;

  /// 作者线程（旧服务端 / 无票据时的回退入口；手机端 v1 不用它跳转）。
  final String? authorSessionId;

  final String? origin;

  /// 要定的事。
  final String? decision;

  /// 人的原始要求（截断）。
  final String? intent;

  final List<AskOption> options;
  final String? recommendationLabel;
  final String? recommendationReason;
  final bool? blocking;
  final AskPhase phase;

  factory AskEnvelope.fromJson(Map<String, dynamic> json) {
    final rawOptions = json['options'];
    final rec = (json['recommendation'] as Map?)?.cast<String, dynamic>();
    return AskEnvelope(
      askId: (json['ask_id'] as String?) ?? '',
      messageId: json['message_id'] as String?,
      authorSessionId: json['author_session_id'] as String?,
      origin: json['origin'] as String?,
      decision: json['decision'] as String?,
      intent: json['intent'] as String?,
      options: rawOptions is List
          ? rawOptions
              .whereType<Map>()
              .map((e) => AskOption.fromJson(e.cast<String, dynamic>()))
              .toList(growable: false)
          : const [],
      recommendationLabel: rec?['label'] as String?,
      recommendationReason: rec?['reason'] as String?,
      blocking: json['blocking'] as bool?,
      phase: AskPhase.fromJson((json['phase'] as Map?)?.cast<String, dynamic>()),
    );
  }
}

/// 一条「等你动手」的事。手机端只读索引：点开回到会话，用人话说，不提供
/// 「通过 / 退回」按钮（design 34 §3）。
class AttentionItem {
  const AttentionItem({
    required this.id,
    required this.stage,
    required this.title,
    this.awaiting,
    this.question,
    this.detail,
    this.startKind,
    this.taskId,
    this.jobId,
    this.handle,
    this.repo,
    this.wt,
    this.deepLink,
    this.subjectKind,
    this.subjectId,
    this.ask,
  });

  final String id;
  final AttentionStage stage;

  /// `person` / `working` / `idle` / `ended` —— 手机端只列 person。
  final String? awaiting;
  final String title;
  final String? question;
  final String? detail;

  /// `enqueue` / `trigger` / `resume`（仅 stage=start）。
  final String? startKind;
  final String? taskId;
  final String? jobId;
  final String? handle;
  final String? repo;
  final String? wt;
  final String? deepLink;

  /// `task` / `delegation`（design 25 §4.2：两种工作实体共用一套 attention）。
  final String? subjectKind;
  final String? subjectId;

  final AskEnvelope? ask;

  factory AttentionItem.fromJson(Map<String, dynamic> json) {
    final subject = (json['subject'] as Map?)?.cast<String, dynamic>();
    final rawAsk = (json['ask'] as Map?)?.cast<String, dynamic>();
    return AttentionItem(
      id: (json['id'] as String?) ?? '',
      stage: AttentionStage.parse(json['stage'] as String?),
      awaiting: json['awaiting'] as String?,
      title: (json['title'] as String?) ?? '',
      question: json['question'] as String?,
      detail: json['detail'] as String?,
      startKind: json['start_kind'] as String?,
      taskId: json['task_id'] as String?,
      jobId: json['job_id'] as String?,
      handle: json['handle'] as String?,
      repo: json['repo'] as String?,
      wt: json['wt'] as String?,
      deepLink: json['deep_link'] as String?,
      subjectKind: subject?['kind'] as String?,
      subjectId: subject?['id'] as String?,
      ask: rawAsk == null ? null : AskEnvelope.fromJson(rawAsk),
    );
  }

  /// 去重键：同一张提问卡在作者线程与原卡里可能各派生一次，票据 id 相同。
  String get dedupeKey {
    final askId = ask?.askId;
    return askId != null && askId.isNotEmpty ? askId : id;
  }

  /// 标题去掉服务端后缀（`· 待验收` / `· 待回答` / `· 委派在问你`…），只留主体名。
  String get subjectName => stripAttentionSuffix(title);

  /// 来源类别：任务 / 委派 / 舱内（findings、incidents 这类没有工作实体）。
  String get subjectKindLabel => switch (subjectKind) {
        'task' => '任务',
        'delegation' => '委派',
        _ => taskId != null ? '任务' : '舱内',
      };

  /// 引用条上的 phase / 轮次：`P2 · 第 2 轮`。
  String? get phaseLabel {
    final phase = ask?.phase;
    if (phase == null || phase.isEmpty) return null;
    final parts = <String>[];
    if (phase.index != null) parts.add('P${phase.index}');
    if (phase.round != null) parts.add('第 ${phase.round} 轮');
    return parts.isEmpty ? null : parts.join(' · ');
  }

  /// 引用条的来源行：`任务 · #1 · P2 · 第 2 轮`（空字段自然省略）。
  String get sourceLine => [
        subjectKindLabel,
        if (handle != null && handle!.trim().isNotEmpty) handle!.trim(),
        if (repo != null && repo!.trim().isNotEmpty) repo!.trim(),
        ?phaseLabel,
      ].join(' · ');

  /// 引用条的问题原文：信封里的「要定的事」最准，其次原问题，再次说明，最后标题。
  String get quoteText {
    for (final candidate in [ask?.decision, question, detail]) {
      final v = candidate?.trim();
      if (v != null && v.isNotEmpty) return v;
    }
    return subjectName;
  }
}

const _attentionSuffixes = [
  '待回答',
  '待验收',
  '待归档',
  '待审批',
  '待入列',
  '待触发',
  '待恢复',
  '失败已升级',
  '委派失败',
  '委派在问你',
  '任务主线程',
  '已完成',
];

/// `app-user 体系分离 · 任务主线程 · 待回答` → `app-user 体系分离`。
String stripAttentionSuffix(String title) {
  var out = title.trim();
  var changed = true;
  while (changed) {
    changed = false;
    for (final suffix in _attentionSuffixes) {
      final re = RegExp('\\s*·\\s*${RegExp.escape(suffix)}\\s*\$');
      final next = out.replaceFirst(re, '');
      if (next != out) {
        out = next;
        changed = true;
      }
    }
  }
  return out.isEmpty ? title.trim() : out;
}

/// 列表口径（去重 + 按 stage 排序）—— PC 的 inbox 同样先按人是否要动手过滤。
///
/// 过滤三条：非 person 不列；`notice`（已完成知会）不进待办，与 PC inbox 一致；
/// 同一票据（`ask.ask_id`）/ 同一 id 只留第一条。
/// 排序：answer → start → adjudicate → review → approval → blocked，同档保持
/// 服务端给的顺序（服务端已把 person 项排在前）。
List<AttentionItem> buildAttentionList(Iterable<AttentionItem> raw) {
  final seenAsk = <String>{};
  final seenId = <String>{};
  final kept = <(int, int, AttentionItem)>[];
  var order = 0;
  for (final item in raw) {
    if (item.stage == AttentionStage.notice) continue;
    final awaiting = item.awaiting;
    if (awaiting != null && awaiting != 'person') continue;
    final askId = item.ask?.askId;
    if (askId != null && askId.isNotEmpty && !seenAsk.add(askId)) continue;
    if (!seenId.add(item.id)) continue;
    kept.add((item.stage.priority, order++, item));
  }
  kept.sort((a, b) => a.$1 != b.$1 ? a.$1 - b.$1 : a.$2 - b.$2);
  return kept.map((e) => e.$3).toList(growable: false);
}

class CabinHealth {
  const CabinHealth({
    this.running = 0,
    this.queued = 0,
    this.dormant = 0,
    this.workers = 0,
    this.max = 0,
  });

  final int running;
  final int queued;
  final int dormant;
  final int workers;
  final int max;

  factory CabinHealth.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const CabinHealth();
    int n(String k) => (json[k] as num?)?.toInt() ?? 0;
    return CabinHealth(
      running: n('running'),
      queued: n('queued'),
      dormant: n('dormant'),
      workers: n('workers'),
      max: n('max'),
    );
  }
}

/// GET /api/cabins/:id → `{cabin, view:{cabin, attention, health, open_findings}}`
class CabinDetail {
  const CabinDetail({
    required this.cabin,
    required this.attention,
    required this.health,
    this.openFindings = 0,
  });

  final Cabin cabin;
  final List<AttentionItem> attention;
  final CabinHealth health;
  final int openFindings;

  factory CabinDetail.fromJson(Map<String, dynamic> json) {
    final cabinJson = (json['cabin'] as Map?)?.cast<String, dynamic>() ?? const {};
    final view = (json['view'] as Map?)?.cast<String, dynamic>() ?? const {};
    final attentionRaw = view['attention'];
    return CabinDetail(
      cabin: Cabin.fromJson(cabinJson.isEmpty ? view['cabin'] as Map<String, dynamic> : cabinJson),
      attention: (attentionRaw is List)
          ? attentionRaw
              .whereType<Map>()
              .map((e) => AttentionItem.fromJson(e.cast<String, dynamic>()))
              .toList(growable: false)
          : const [],
      health: CabinHealth.fromJson((view['health'] as Map?)?.cast<String, dynamic>()),
      openFindings: (view['open_findings'] as num?)?.toInt() ?? 0,
    );
  }

  int get reviewCount => attentionList.where((a) => a.stage.isReview).length;
  int get waitCount => attentionList.where((a) => !a.stage.isReview).length;

  /// 界面口径：去掉非 person 项、按票据去重、按 stage 排序后的列表。
  List<AttentionItem> get attentionList => buildAttentionList(attention);
}
