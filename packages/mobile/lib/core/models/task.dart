/// 任务（只读）。GET /api/tasks?cabin_id= → `{items: Task[]}`。
///
/// 手机端不改任务：明细编辑、触发、验收、归档都在桌面。这里只挑展示要用的字段，
/// `task_spec` 保持动态结构（v4 的 goal / phases 都在里面）。
class TaskItem {
  const TaskItem({
    required this.id,
    required this.name,
    required this.status,
    this.cabinId,
    this.repoGroup,
    this.updatedAt,
    this.createdAt,
    this.semanticSummary,
    this.taskSpec,
  });

  final String id;
  final String name;
  final String status;
  final String? cabinId;
  final String? repoGroup;
  final String? updatedAt;
  final String? createdAt;
  final String? semanticSummary;
  final Map<String, dynamic>? taskSpec;

  String? get goal {
    final g = taskSpec?['goal'];
    if (g is String && g.trim().isNotEmpty) return g.trim();
    return null;
  }

  String? get format => taskSpec?['format'] as String?;

  List<TaskPhaseLite> get phases {
    final raw = taskSpec?['phases'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((e) => TaskPhaseLite.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false);
  }

  List<String> get acceptance {
    final raw = taskSpec?['ac'];
    if (raw is! List) return const [];
    return raw.whereType<String>().where((s) => s.trim().isNotEmpty).toList(growable: false);
  }

  factory TaskItem.fromJson(Map<String, dynamic> json) => TaskItem(
        id: json['id'] as String,
        name: (json['name'] as String?) ?? '',
        status: (json['status'] as String?) ?? 'draft',
        cabinId: json['cabin_id'] as String?,
        repoGroup: json['repo_group'] as String?,
        updatedAt: json['updated_at'] as String?,
        createdAt: json['created_at'] as String?,
        semanticSummary: json['semantic_summary'] as String?,
        taskSpec: (json['task_spec'] as Map?)?.cast<String, dynamic>(),
      );
}

class TaskPhaseLite {
  const TaskPhaseLite({required this.name, this.slug, this.workflowRef});

  final String name;
  final String? slug;
  final String? workflowRef;

  factory TaskPhaseLite.fromJson(Map<String, dynamic> json) => TaskPhaseLite(
        name: (json['name'] as String?)?.trim().isNotEmpty == true
            ? json['name'] as String
            : (json['slug'] as String?) ?? '未命名 phase',
        slug: json['slug'] as String?,
        workflowRef: json['workflowRef'] as String? ?? json['workflow_ref'] as String?,
      );
}

/// 任务状态 → 中文标签 + 色档（与桌面同一套词）。
const taskStatusLabels = <String, String>{
  'draft': '草稿',
  'ready': '待跑',
  'running': '运行中',
  'paused': '已暂停',
  'awaiting_review': '待验收',
  'awaiting_archive': '待归档',
  'archiving': '归档中',
  'done': '已完成',
  'failed': '失败',
  'aborted': '已中止',
};

enum TaskTone { neutral, run, wait, review, bad }

TaskTone taskTone(String status) {
  switch (status) {
    case 'running':
    case 'ready':
      return TaskTone.run;
    case 'awaiting_review':
      return TaskTone.review;
    case 'awaiting_archive':
    case 'archiving':
      return TaskTone.wait;
    case 'failed':
    case 'aborted':
      return TaskTone.bad;
    default:
      return TaskTone.neutral;
  }
}
