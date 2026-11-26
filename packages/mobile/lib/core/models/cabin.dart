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

class AttentionItem {
  const AttentionItem({
    required this.id,
    required this.stage,
    required this.title,
    this.question,
    this.detail,
    this.taskId,
    this.jobId,
    this.handle,
    this.repo,
    this.deepLink,
    this.source,
  });

  final String id;
  final AttentionStage stage;
  final String title;
  final String? question;
  final String? detail;
  final String? taskId;
  final String? jobId;
  final String? handle;
  final String? repo;
  final String? deepLink;
  final String? source;

  factory AttentionItem.fromJson(Map<String, dynamic> json) => AttentionItem(
        id: (json['id'] as String?) ?? '',
        stage: AttentionStage.parse(json['stage'] as String?),
        title: (json['title'] as String?) ?? '',
        question: json['question'] as String?,
        detail: json['detail'] as String?,
        taskId: json['task_id'] as String?,
        jobId: json['job_id'] as String?,
        handle: json['handle'] as String?,
        repo: json['repo'] as String?,
        deepLink: json['deep_link'] as String?,
        source: _sourceOf(json),
      );

  static String? _sourceOf(Map<String, dynamic> json) {
    final subject = json['subject'];
    if (subject is Map && subject['kind'] is String) {
      final kind = subject['kind'] as String;
      return kind == 'task' ? '任务' : '委派';
    }
    if (json['task_id'] != null) return '任务';
    return null;
  }
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

  int get reviewCount => attention.where((a) => a.stage.isReview).length;
  int get waitCount => attention.where((a) => !a.stage.isReview).length;
}
